// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeChange, insightFor, loadProject } from "../src/core/index.js";
import { locate, namesIn } from "../vscode/src/model.js";

const FIELD = "force-app/main/default/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml";

describe("unsaved edits (overlay)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-overlay-"));
    cpSync(path.resolve("fixtures/sample-org"), dir, { recursive: true });
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd: dir, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("analyzes the editor's text instead of the file on disk, and counts it as changed", () => {
    const onDisk = readFileSync(path.join(dir, FIELD), "utf8");
    expect(analyzeChange({ projectDir: dir, base: "HEAD" }).result.changes).toEqual([]);
    const typed = onDisk.replace("<type>Date</type>", "<type>DateTime</type>");
    const { result } = analyzeChange({ projectDir: dir, base: "HEAD", overlay: { [path.join(dir, FIELD)]: typed } });
    expect(result.changes.map((c) => c.component.name)).toEqual(["Opportunity.Contract_Signed_Date__c"]);
    expect(result.summary.risk).toBe("high");
    expect(readFileSync(path.join(dir, FIELD), "utf8")).toBe(onDisk);
  });

  it("sees unsaved Apex too: a new SOQL query in a loop", () => {
    const cls = "force-app/main/default/classes/OpportunityCloser.cls";
    const typed = `public class OpportunityCloser { public static void run(List<Id> ids) { for (Id i : ids) { Account a = [SELECT Id FROM Account WHERE Id = :i]; } } }`;
    const { result } = analyzeChange({ projectDir: dir, base: "HEAD", overlay: { [cls]: typed } });
    expect(result.findings.some((f) => f.rule === "dml-or-soql-in-loop" && f.files[0] === cls)).toBe(true);
  });
});

describe("insight above a file", () => {
  const model = loadProject(path.resolve("fixtures/sample-org"));
  it("says who uses a field and what saving its object runs", () => {
    expect(insightFor(model, FIELD).summary).toBe(
      "Used by 1 validation rule, 1 permission set · saving Opportunity runs 3 automations",
    );
  });
  it("leaves test classes out of a class's callers", () => {
    expect(insightFor(model, "force-app/main/default/classes/OpportunityCloser.cls").summary).toBe("saves Opportunity");
  });
  it("describes a trigger's object and a record-triggered flow", () => {
    expect(insightFor(model, "force-app/main/default/triggers/ContactTrigger.trigger").summary).toBe(
      "Saving Contact runs 1 automation · 1 automation writes Contact",
    );
    expect(
      insightFor(model, "force-app/main/default/flows/Opportunity_Closed_Won_Followup.flow-meta.xml").summary,
    ).toBe("Runs after save of Opportunity");
  });
});

describe("where a problem is underlined", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="x">\n    <fullName>Contract_Signed_Date__c</fullName>\n    <type>Date</type>\n</CustomField>`;
  it("picks API names from a finding's title, longest first", () => {
    expect(
      namesIn("Opportunity.Contract_Signed_Date__c is checked by validation rule Require_Contract_Signed_Date"),
    ).toEqual(["Opportunity.Contract_Signed_Date__c", "Require_Contract_Signed_Date", "Contract_Signed_Date__c"]);
    expect(namesIn("Automation cycle: Account → Contact → Account")).toEqual([]);
  });
  it("underlines the name the finding is about", () => {
    expect(
      locate(xml, { line: 0, exact: false, title: "Opportunity.Contract_Signed_Date__c is checked by a rule" }),
    ).toEqual({
      line: 2,
      start: 14,
      end: 37,
    });
  });
  it("falls back to the first element, and uses the finding's own line when it has one", () => {
    expect(locate(xml, { line: 0, exact: false, title: "Automation cycle: Account → Contact" })).toEqual({
      line: 1,
      start: 0,
      end: 23,
    });
    expect(locate(xml, { line: 3, exact: true, title: "x" })).toEqual({ line: 3, start: 4, end: 21 });
  });
});
