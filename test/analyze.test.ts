// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnalysisResult, ChangeType, OrgModel } from "../src/core/index.js";
import { analyze, loadProject, run, saveProcedure, toChanges, toMarkdown } from "../src/core/index.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/sample-org");
const SRC = "force-app/main/default";

let model: OrgModel;
beforeAll(() => {
  model = loadProject(FIXTURE);
});

function analyzeFiles(files: string[], changeType: ChangeType = "modified"): AnalysisResult {
  const { changes } = toChanges(files.map((file) => ({ file, changeType })));
  return analyze({ model, changes });
}

const rules = (r: AnalysisResult) => r.findings.map((f) => f.rule);

describe("loadProject", () => {
  it("loads every supported component in the fixture", () => {
    expect(model.flows.size).toBe(5);
    expect(model.triggers.size).toBe(1);
    expect(model.classes.size).toBe(3);
    expect(model.validationRules).toHaveLength(2);
    expect(model.permissionContainers.size).toBe(1);
    expect([...model.agents.keys()]).toEqual(["sales_agent", "service_agent"]);
    expect(model.agentTests.map((t) => t.name)).toEqual(["Sales_Agent_Tests"]);
    expect(model.warnings).toEqual([]);
  });
});

describe("saveProcedure", () => {
  it("orders automations like Salesforce's order of execution", () => {
    const p = saveProcedure(model, "Opportunity", "insert");
    expect(p.steps.map((s) => s.phase)).toEqual(["before-flow", "validation", "after-flow", "rollup"]);
    expect(p.steps.map((s) => s.automation.name)).toEqual([
      "Opportunity_Set_Defaults",
      "Require_Contract_Signed_Date",
      "Opportunity_Closed_Won_Followup",
      "Account.Total_Won_Amount__c",
    ]);
  });

  it("does not run validation rules on delete", () => {
    const p = saveProcedure(model, "Opportunity", "delete");
    expect(p.steps.some((s) => s.phase === "validation")).toBe(false);
  });

  it("attributes handler-class writes to the trigger", () => {
    const p = saveProcedure(model, "Contact", "update");
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]!.writes).toEqual([expect.objectContaining({ object: "Account", op: "update" })]);
  });
});

describe("analyze: field change", () => {
  const file = `${SRC}/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml`;

  it("follows the cascade through roll-up, flow and trigger and finds both cycles", () => {
    const r = analyzeFiles([file]);
    expect(r.impactedObjects).toEqual(["Account", "Contact", "Opportunity", "Task"]);
    expect(r.cycles).toHaveLength(2);
    expect(r.findings.filter((f) => f.rule === "recursion-cycle").map((f) => f.title)).toEqual(
      expect.arrayContaining([
        "Automation cycle: Account → Contact → Account",
        "Automation cycle: Opportunity → Opportunity",
      ]),
    );
    expect(r.summary.risk).toBe("high");
  });

  it("says where to break a cycle: entry criteria for flows, a Set<Id> guard (not a Boolean) for Apex", () => {
    const details = analyzeFiles([file])
      .findings.filter((f) => f.rule === "recursion-cycle")
      .map((f) => f.detail)
      .join("\n");
    expect(details).toContain("Set<Id>");
    expect(details).toContain("not a static Boolean");
    expect(details).toContain("$Record__Prior");
  });

  it("flags the validation rule that checks the field and automated writes it guards", () => {
    const r = analyzeFiles([file]);
    expect(rules(r)).toEqual(
      expect.arrayContaining([
        "field-used-by-validation-rule",
        "automated-write-vs-validation-rule",
        "after-save-self-update",
        "dml-or-soql-in-loop",
      ]),
    );
    expect(r.references.map((x) => `${x.from.kind}:${x.from.name}`)).toEqual(
      expect.arrayContaining(["ValidationRule:Require_Contract_Signed_Date", "PermissionSet:Agent_Runtime_User"]),
    );
  });

  it("reports deleted fields that are still referenced", () => {
    const r = analyzeFiles([file], "deleted");
    expect(r.findings[0]).toMatchObject({ rule: "deleted-still-referenced", severity: "high" });
  });

  it("suggests bulk, recursion, boundary and validation-collision tests", () => {
    const kinds = new Set(analyzeFiles([file]).suggestedTests.map((t) => t.kind));
    for (const k of ["bulk", "recursion", "boundary", "validation-collision", "idempotency"])
      expect(kinds).toContain(k);
  });
});

describe("analyze: invocable Apex used by an agent", () => {
  it("surfaces the validation rule the action will collide with", () => {
    const r = analyzeFiles([`${SRC}/classes/OpportunityCloser.cls`, `${SRC}/classes/OpportunityCloser.cls-meta.xml`]);
    expect(r.changes).toHaveLength(1);
    const collision = r.findings.find(
      (f) => f.rule === "automated-write-vs-validation-rule" && f.object === "Opportunity",
    );
    expect(collision?.detail).toContain("class OpportunityCloser");
    expect(collision?.detail).toContain("Require_Contract_Signed_Date");
  });
});

describe("analyze: trigger handler change", () => {
  it("rates loop issues in changed Apex as high", () => {
    const r = analyzeFiles([`${SRC}/classes/ContactTriggerHandler.cls`]);
    const loop = r.findings.find((f) => f.rule === "dml-or-soql-in-loop");
    expect(loop).toMatchObject({ severity: "high" });
    expect(r.cascade[0]).toMatchObject({ object: "Contact", event: "update" });
  });
});

describe("analyze: permission set change", () => {
  it("flags Modify All / View All and delete grants", () => {
    const r = analyzeFiles([`${SRC}/permissionsets/Agent_Runtime_User.permissionset-meta.xml`]);
    expect(r.findings.map((f) => `${f.severity}:${f.rule}:${f.object}`)).toEqual(
      expect.arrayContaining([
        "high:permission-escalation:Opportunity",
        "medium:permission-delete:Opportunity",
        "medium:permission-delete:Account",
      ]),
    );
    expect(r.suggestedTests.some((t) => t.kind === "permission-negative")).toBe(true);
  });
});

describe("markdown report", () => {
  it("renders the key sections", () => {
    const md = toMarkdown(analyzeFiles([`${SRC}/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml`]));
    expect(md).toContain("## Preflight: 🔴 HIGH risk");
    expect(md).toContain("### Cascade");
    expect(md).toContain("⟲ cycle");
    expect(md).toContain("### Suggested tests");
    expect(md).toContain("Order of execution for impacted objects");
  });
});

describe("git integration", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sf-preflight-"));
    cpSync(FIXTURE, repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("detects a new validation rule in the working tree and the automations it now constrains", () => {
    const vrDir = path.join(repo, SRC, "objects/Contact/validationRules");
    execFileSync("mkdir", ["-p", vrDir]);
    writeFileSync(
      path.join(vrDir, "Email_Required.validationRule-meta.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Email_Required</fullName>
    <active>true</active>
    <errorConditionFormula>ISBLANK(Email)</errorConditionFormula>
    <errorMessage>Email is required.</errorMessage>
</ValidationRule>`,
    );
    const r = run({ projectDir: repo, base: "HEAD" });
    expect(r.changes.map((c) => `${c.changeType}:${c.component.name}`)).toEqual(["added:Contact.Email_Required"]);
    const f = r.findings.find((x) => x.rule === "validation-rule-vs-existing-automation");
    expect(f).toMatchObject({ severity: "high", object: "Contact" });
    expect(f?.detail).toContain("flow Account_Sync_Tier_To_Contacts");
  });

  it("diffs permission sets against the base ref", () => {
    const ps = path.join(repo, SRC, "permissionsets/Agent_Runtime_User.permissionset-meta.xml");
    execFileSync("git", ["checkout", "-q", "--", "."], { cwd: repo });
    execFileSync("sed", [
      "-i",
      "s#<userPermissions/>##; s#</PermissionSet>#<userPermissions><enabled>true</enabled><name>ModifyAllData</name></userPermissions></PermissionSet>#",
      ps,
    ]);
    const r = run({ projectDir: repo, base: "HEAD" });
    const perm = r.findings.filter((f) => f.rule.startsWith("permission"));
    // Only the delta is reported: Modify All on Opportunity existed in the base.
    expect(perm.map((f) => f.rule)).toEqual(["permission-system"]);
    expect(perm[0]!.title).toContain("newly grants system permission ModifyAllData");
  });
});
