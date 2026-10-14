// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeChange, loadProject, saveProcedure } from "../src/core/index.js";
import { parseWorkflow } from "../src/core/parsers/saveRules.js";

const SRC = "force-app/main/default/";
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

const workflow = (active: boolean) => `<?xml version="1.0" encoding="UTF-8"?>
<Workflow ${NS}>
    <alerts>
        <fullName>Ack_Email</fullName>
        <recipients><field>Primary_Contact__c</field><type>contactLookup</type></recipients>
        <senderType>CurrentUser</senderType>
        <template>T/Ack</template>
    </alerts>
    <fieldUpdates>
        <fullName>Set_Status</fullName>
        <field>Ack_Status__c</field>
        <literalValue>Acknowledged</literalValue>
        <name>Set Status</name>
        <operation>Literal</operation>
    </fieldUpdates>
    <rules>
        <fullName>Acknowledge</fullName>
        <actions><name>Ack_Email</name><type>Alert</type></actions>
        <actions><name>Set_Status</name><type>FieldUpdate</type></actions>
        <actions><name>Follow_Up</name><type>Task</type></actions>
        <active>${active}</active>
        <criteriaItems><field>Opportunity.Amount</field><operation>greaterThan</operation><value>100</value></criteriaItems>
        <triggerType>onCreateOnly</triggerType>
    </rules>
    <rules>
        <fullName>Later</fullName>
        <active>true</active>
        <formula>Won__c</formula>
        <triggerType>onAllChanges</triggerType>
        <workflowTimeTriggers>
            <actions><name>Set_Status</name><type>FieldUpdate</type></actions>
            <timeLength>3</timeLength>
            <workflowTimeTriggerUnit>Days</workflowTimeTriggerUnit>
        </workflowTimeTriggers>
    </rules>
</Workflow>
`;

describe("workflow rules", () => {
  it("reads rules with the fields their criteria, field updates and alerts use", () => {
    const [a, b] = parseWorkflow(workflow(true), "Opportunity", "f");
    expect(a).toMatchObject({
      kind: "WorkflowRule",
      name: "Opportunity.Acknowledge",
      active: true,
      events: ["insert"],
      creates: ["Task"],
      actions: ["email alert Ack_Email", "field update Ack_Status__c", "task Follow_Up"],
    });
    expect(a?.fields.sort()).toEqual(["Ack_Status__c", "Amount", "Primary_Contact__c"]);
    expect(b).toMatchObject({ events: ["insert", "update"], timeDependent: true });
    expect(b?.fields.sort()).toEqual(["Ack_Status__c", "Won__c"]);
  });

  describe("in a project", () => {
    let dir: string;
    const write = (rel: string, body: string) => {
      const f = path.join(dir, SRC, rel);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, body);
    };
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "pipe" });
    const field = (name: string) =>
      `<CustomField ${NS}><fullName>${name}</fullName><label>${name}</label><type>Text</type><length>10</length></CustomField>`;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "preflight-workflow-"));
      writeFileSync(
        path.join(dir, "sfdx-project.json"),
        JSON.stringify({ packageDirectories: [{ path: "force-app" }] }),
      );
      git("init", "-q", "-b", "main");
      write("objects/Opportunity/fields/Ack_Status__c.field-meta.xml", field("Ack_Status__c"));
      write("workflows/Opportunity.workflow-meta.xml", workflow(false));
      git("add", "-A");
      git("commit", "-q", "-m", "base");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("runs active rules after the after-save triggers, for the saves they apply to", () => {
      write("workflows/Opportunity.workflow-meta.xml", workflow(true));
      const model = loadProject(dir, { cache: false });
      const insert = saveProcedure(model, "Opportunity", "insert").steps.filter((s) => s.phase === "workflow");
      expect(insert.map((s) => s.automation.name)).toEqual(["Opportunity.Acknowledge", "Opportunity.Later"]);
      expect(insert[0]?.writes).toEqual([expect.objectContaining({ object: "Task", op: "insert" })]);
      expect(insert[0]?.notes.join(" ")).toContain("once more");
      expect(insert[1]?.notes.join(" ")).toContain("time-dependent");
      // Create-only rules don't run on update.
      expect(
        saveProcedure(model, "Opportunity", "update")
          .steps.filter((s) => s.phase === "workflow")
          .map((s) => s.automation.name),
      ).toEqual(["Opportunity.Later"]);
    });

    it("reports a rule switched on, and a deleted field a workflow rule still updates", () => {
      write("workflows/Opportunity.workflow-meta.xml", workflow(true));
      const on = analyzeChange({ projectDir: dir, base: "HEAD", config: false }).result.findings;
      expect(on.find((f) => f.rule === "save-rule-changed")?.title).toBe(
        "Workflow rule Opportunity.Acknowledge switched on",
      );
      expect(on.find((f) => f.rule === "legacy-workflow")?.detail).toContain("2 of 2 rule(s) active");
      git("checkout", "-q", "--", ".");
      rmSync(path.join(dir, SRC, "objects/Opportunity/fields/Ack_Status__c.field-meta.xml"));
      const deleted = analyzeChange({ projectDir: dir, base: "HEAD", config: false }).result.findings;
      expect(deleted.find((f) => f.rule === "deleted-still-referenced")?.detail).toContain("Opportunity.Acknowledge");
    });
  });
});
