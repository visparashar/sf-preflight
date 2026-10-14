// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeChange } from "../src/core/index.js";

const SRC = "force-app/main/default/";
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

describe("before-save flows and validation rules", () => {
  let dir: string;
  const write = (rel: string, body: string) => {
    const f = path.join(dir, SRC, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "pipe" });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-before-save-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    git("init", "-q", "-b", "main");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("names the before-save flows that set the fields a new validation rule checks", () => {
    write(
      "flows/Case_Defaults.flow-meta.xml",
      `<Flow ${NS}><status>Active</status><assignments><name>Set</name><assignmentItems><assignToReference>$Record.Region__c</assignToReference><operator>Assign</operator><value><stringValue>EMEA</stringValue></value></assignmentItems></assignments><start><object>Case</object><recordTriggerType>Create</recordTriggerType><triggerType>RecordBeforeSave</triggerType></start></Flow>`,
    );
    write(
      "flows/Other_Defaults.flow-meta.xml",
      `<Flow ${NS}><status>Active</status><assignments><name>Set</name><assignmentItems><assignToReference>$Record.Priority</assignToReference><operator>Assign</operator><value><stringValue>High</stringValue></value></assignmentItems></assignments><start><object>Case</object><recordTriggerType>Create</recordTriggerType><triggerType>RecordBeforeSave</triggerType></start></Flow>`,
    );
    write("classes/CaseMaker.cls", "public class CaseMaker { public static void make() { insert new Case(); } }");
    write(
      "classes/CaseMaker.cls-meta.xml",
      `<ApexClass ${NS}><apiVersion>60.0</apiVersion><status>Active</status></ApexClass>`,
    );
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    write(
      "objects/Case/validationRules/Region_Required.validationRule-meta.xml",
      `<ValidationRule ${NS}><fullName>Region_Required</fullName><active>true</active><errorConditionFormula>ISBLANK(Region__c)</errorConditionFormula><errorMessage>Region is required</errorMessage></ValidationRule>`,
    );
    const { result } = analyzeChange({ projectDir: dir, base: "HEAD", config: false });
    const f = result.findings.find((x) => x.rule === "validation-rule-vs-existing-automation");
    expect(f?.detail).toContain("Before-save flows that set what it checks: Case_Defaults (sets Region__c)");
    expect(f?.detail).not.toContain("Other_Defaults");
  });
});
