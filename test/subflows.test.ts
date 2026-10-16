// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flowWrites } from "../src/core/graph.js";
import { analyze, fieldReferences, loadProject, toMarkdown } from "../src/core/index.js";
import { parseFlow } from "../src/core/parsers/flows.js";
import { classifyPath } from "../src/core/project.js";
import type { Change } from "../src/core/types.js";

const base = "force-app/main/default/";

/** Record-triggered after-save flow on Opportunity that hands its record to a subflow. */
const PARENT = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <label>Opportunity After Save</label>
    <processType>AutoLaunchedFlow</processType>
    <start>
        <object>Opportunity</object>
        <recordTriggerType>Update</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
        <connector><targetReference>Run_Check_Stage</targetReference></connector>
    </start>
    <status>Active</status>
    <subflows>
        <name>Run_Check_Stage</name>
        <label>Run Check Stage</label>
        <flowName>Check_Stage</flowName>
        <inputAssignments>
            <name>opp</name>
            <value><elementReference>$Record</elementReference></value>
        </inputAssignments>
    </subflows>
</Flow>
`;

/** Top-level flow that runs the parent's subflow through another subflow, without $Record. */
const GRANDPARENT = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <label>Nightly Wrapper</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <subflows>
        <name>Run_Middle</name>
        <flowName>Middle</flowName>
    </subflows>
</Flow>
`;

const MIDDLE = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <label>Middle</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <subflows>
        <name>Run_Check_Stage</name>
        <flowName>Check_Stage</flowName>
    </subflows>
</Flow>
`;

/**
 * Autolaunched subflow: reads Stage_Gate__c in a Decision and Amount in a Formula, sets
 * Next_Step__c with an Assignment and saves the record variable it was given.
 */
const SUBFLOW = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <label>Check Stage</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <variables>
        <name>opp</name>
        <dataType>SObject</dataType>
        <isCollection>false</isCollection>
        <isInput>true</isInput>
        <isOutput>false</isOutput>
        <objectType>Opportunity</objectType>
    </variables>
    <formulas>
        <name>Big_Deal</name>
        <dataType>Boolean</dataType>
        <expression>{!opp.Amount} &gt; 100000 &amp;&amp; {!opp.Account.Name} != null</expression>
    </formulas>
    <decisions>
        <name>Gate_Passed</name>
        <label>Gate passed?</label>
        <rules>
            <name>Yes</name>
            <conditionLogic>and</conditionLogic>
            <conditions>
                <leftValueReference>opp.Stage_Gate__c</leftValueReference>
                <operator>EqualTo</operator>
                <rightValue><stringValue>Passed</stringValue></rightValue>
            </conditions>
            <connector><targetReference>Set_Next_Step</targetReference></connector>
        </rules>
    </decisions>
    <assignments>
        <name>Set_Next_Step</name>
        <assignmentItems>
            <assignToReference>opp.Next_Step__c</assignToReference>
            <operator>Assign</operator>
            <value><stringValue>Legal review</stringValue></value>
        </assignmentItems>
        <connector><targetReference>Save_Opp</targetReference></connector>
    </assignments>
    <recordUpdates>
        <name>Save_Opp</name>
        <inputReference>opp</inputReference>
    </recordUpdates>
</Flow>
`;

const field = (name: string) => `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>${name}</fullName>
    <label>${name}</label>
    <type>Text</type>
    <length>80</length>
</CustomField>
`;

describe("flow parser: record variables and subflow inputs", () => {
  it("finds fields used through record variables in Decisions, Formulas and Assignments", () => {
    const flow = parseFlow(SUBFLOW, "Check_Stage", "Check_Stage.flow-meta.xml");
    expect(flow.fieldRefs).toEqual(
      expect.arrayContaining(["Opportunity.Stage_Gate__c", "Opportunity.Amount", "Opportunity.Next_Step__c"]),
    );
    // Relationship paths are not resolved to a field of the variable's own object.
    expect(flow.fieldRefs).not.toContain("Opportunity.Account");
  });

  it("records what a Subflow element passes in", () => {
    const flow = parseFlow(PARENT, "Opp_After_Save", "Opp_After_Save.flow-meta.xml");
    expect(flow.subflows).toEqual(["Check_Stage"]);
    expect(flow.subflowCalls).toEqual([{ flow: "Check_Stage", inputs: [{ variable: "opp", ref: "$Record" }] }]);
  });

  it("notes the record variable a write goes through", () => {
    const flow = parseFlow(SUBFLOW, "Check_Stage", "Check_Stage.flow-meta.xml");
    expect(flow.writes).toEqual([expect.objectContaining({ object: "Opportunity", op: "update", recordVar: "opp" })]);
  });
});

describe("field changes traced through subflows", () => {
  let dir: string;
  const write = (rel: string, body: string) => {
    const f = path.join(dir, base, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  };
  const change = (rel: string, changeType: Change["changeType"] = "modified"): Change => ({
    changeType,
    component: classifyPath(base + rel),
  });
  const stageGate = "objects/Opportunity/fields/Stage_Gate__c.field-meta.xml";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-subflows-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    write(stageGate, field("Stage_Gate__c"));
    write("objects/Opportunity/fields/Next_Step__c.field-meta.xml", field("Next_Step__c"));
    write("flows/Opp_After_Save.flow-meta.xml", PARENT);
    write("flows/Check_Stage.flow-meta.xml", SUBFLOW);
    write("flows/Middle.flow-meta.xml", MIDDLE);
    write("flows/Nightly_Wrapper.flow-meta.xml", GRANDPARENT);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists the flows that run the subflow, with the chain and whether they pass $Record", () => {
    const model = loadProject(dir, { cache: false });
    const refs = fieldReferences(model, "Opportunity", "Stage_Gate__c").filter((r) => r.from.kind === "Flow");
    const byName = Object.fromEntries(refs.map((r) => [r.from.name, r.via]));
    expect(byName).toEqual({
      Check_Stage: undefined,
      Opp_After_Save: "subflow Check_Stage (passes $Record)",
      Middle: "subflow Check_Stage",
      Nightly_Wrapper: "subflow Middle › Check_Stage",
    });
  });

  it("shows the indirect references in the report", () => {
    const result = analyze({ model: loadProject(dir, { cache: false }), changes: [change(stageGate)] });
    expect(toMarkdown(result)).toContain("Flow `Opp_After_Save` (through subflow Check_Stage (passes $Record))");
  });

  it("treats a subflow saving the record it was handed as the caller re-entering its own save", () => {
    const model = loadProject(dir, { cache: false });
    const parent = model.flows.get("opp_after_save")!;
    expect(flowWrites(model, parent)).toEqual([
      expect.objectContaining({ object: "Opportunity", op: "update", selfUpdate: true }),
    ]);
    // On its own, the subflow does not know whose record it was given.
    expect(flowWrites(model, model.flows.get("check_stage")!)[0]!.selfUpdate).toBeUndefined();
    // Only the flow that passes $Record re-enters; a caller without it does not.
    expect(flowWrites(model, model.flows.get("middle")!)[0]!.selfUpdate).toBeUndefined();

    const result = analyze({ model, changes: [change("flows/Check_Stage.flow-meta.xml")] });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        rule: "after-save-self-update",
        title: "After-save flow Opp_After_Save updates its own triggering Opportunity",
      }),
    );
  });

  it("blames only the subflow when a field it uses is deleted", () => {
    const result = analyze({ model: loadProject(dir, { cache: false }), changes: [change(stageGate, "deleted")] });
    const finding = result.findings.find((f) => f.rule === "deleted-still-referenced");
    expect(finding?.detail).toContain("Check_Stage");
    expect(finding?.detail).not.toContain("Opp_After_Save");
  });
});
