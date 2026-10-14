// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeChange, loadProject, saveProcedure } from "../src/core/index.js";

const SRC = "force-app/main/default/";
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

describe("cascade delete", () => {
  let dir: string;
  const write = (rel: string, body: string) => {
    const f = path.join(dir, SRC, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  };
  const field = (object: string, name: string, type: string, to: string, extra = "") =>
    write(
      `objects/${object}/fields/${name}.field-meta.xml`,
      `<CustomField ${NS}><fullName>${name}</fullName><label>${name}</label><type>${type}</type><referenceTo>${to}</referenceTo><relationshipName>${name.replace("__c", "")}s</relationshipName>${extra}</CustomField>`,
    );
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "pipe" });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-cascade-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    git("init", "-q", "-b", "main");
    for (const o of ["Invoice__c", "Line__c", "Note__c", "Tag__c"])
      write(`objects/${o}/${o}.object-meta.xml`, `<CustomObject ${NS}><label>${o}</label></CustomObject>`);
    field("Line__c", "Invoice__c", "MasterDetail", "Invoice__c");
    field("Note__c", "Line__c", "Lookup", "Line__c", "<deleteConstraint>Cascade</deleteConstraint>");
    field("Tag__c", "Invoice__c", "Lookup", "Invoice__c", "<deleteConstraint>SetNull</deleteConstraint>");
    write(
      "triggers/LineCleanup.trigger",
      "trigger LineCleanup on Line__c (before delete) { for (Line__c l : Trigger.old) { Integer n = [SELECT COUNT() FROM Note__c WHERE Line__c = :l.Id]; } }",
    );
    write(
      "triggers/LineCleanup.trigger-meta.xml",
      `<ApexTrigger ${NS}><apiVersion>60.0</apiVersion><status>Active</status></ApexTrigger>`,
    );
    write(
      "classes/InvoiceCloser.cls",
      "public class InvoiceCloser { public static void close(Invoice__c i) { i.Name = 'x'; } }",
    );
    write(
      "classes/InvoiceCloser.cls-meta.xml",
      `<ApexClass ${NS}><apiVersion>60.0</apiVersion><status>Active</status></ApexClass>`,
    );
    git("add", "-A");
    git("commit", "-q", "-m", "base");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("deleting a parent deletes master-detail children and cascading-lookup children, not set-null ones", () => {
    const model = loadProject(dir, { cache: false });
    const steps = saveProcedure(model, "Invoice__c", "delete").steps.filter((s) => s.phase === "cascade-delete");
    expect(steps.map((s) => s.automation.name)).toEqual(["Line__c"]);
    expect(steps[0]?.writes).toEqual([expect.objectContaining({ object: "Line__c", op: "delete" })]);
    // And a child's own children, one level down.
    expect(
      saveProcedure(model, "Line__c", "delete")
        .steps.filter((s) => s.phase === "cascade-delete")
        .map((s) => s.automation.name),
    ).toEqual(["Note__c"]);
    // Inserting or updating a parent deletes nothing.
    expect(saveProcedure(model, "Invoice__c", "update").steps.some((s) => s.phase === "cascade-delete")).toBe(false);
  });

  it("a change that deletes parents reaches the children's delete automation", () => {
    write(
      "classes/InvoiceCloser.cls",
      "public class InvoiceCloser { public static void close(List<Invoice__c> i) { delete i; } }",
    );
    const { result } = analyzeChange({ projectDir: dir, base: "HEAD", config: false });
    expect(result.impactedObjects).toEqual(expect.arrayContaining(["Invoice__c", "Line__c", "Note__c"]));
    const loop = result.findings.find((f) => f.rule === "dml-or-soql-in-loop");
    expect(loop?.title).toContain("LineCleanup");
  });
});
