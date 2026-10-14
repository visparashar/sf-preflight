// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeApex, parseApexClass, parseApexTrigger, stripApex } from "../src/core/parsers/apex.js";
import { parseField } from "../src/core/parsers/fields.js";
import { parseFlow } from "../src/core/parsers/flows.js";
import { formulaFieldRefs } from "../src/core/parsers/formula.js";
import { parsePermissionContainer } from "../src/core/parsers/permissions.js";
import { classifyPath } from "../src/core/project.js";

const SRC = path.resolve(__dirname, "../fixtures/sample-org/force-app/main/default");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");
const objects = new Set(["account", "contact", "opportunity"]);

describe("classifyPath", () => {
  it("recognises object-scoped components at any nesting depth", () => {
    expect(classifyPath("force-app/main/default/objects/Account/fields/Tier__c.field-meta.xml")).toMatchObject({
      type: "CustomField",
      name: "Account.Tier__c",
      object: "Account",
    });
    expect(classifyPath("pkg/sales/objects/Opportunity/validationRules/X.validationRule-meta.xml")).toMatchObject({
      type: "ValidationRule",
      name: "Opportunity.X",
    });
    expect(classifyPath("force-app/main/default/objects/Foo__c/Foo__c.object-meta.xml").type).toBe("CustomObject");
    expect(classifyPath("force-app/main/default/objects/Foo__c/listViews/All.listView-meta.xml").type).toBe(
      "ObjectChild",
    );
  });

  it("recognises code, flows and permissions", () => {
    expect(classifyPath("a/flows/My_Flow.flow-meta.xml")).toMatchObject({ type: "Flow", name: "My_Flow" });
    expect(classifyPath("a/classes/Foo.cls").type).toBe("ApexClass");
    expect(classifyPath("a/classes/Foo.cls-meta.xml").name).toBe("Foo");
    expect(classifyPath("a/triggers/T.trigger").type).toBe("ApexTrigger");
    expect(classifyPath("a/permissionsets/P.permissionset-meta.xml").type).toBe("PermissionSet");
    expect(classifyPath("README.md").type).toBe("Other");
  });
});

describe("formulaFieldRefs", () => {
  it("ignores functions, strings, keywords and globals", () => {
    const refs = formulaFieldRefs(
      `AND(ISPICKVAL(StageName, "Closed Won"), ISBLANK(Contract_Signed_Date__c), $User.Id <> OwnerId, TRUE)`,
    );
    expect(refs.sort()).toEqual(["Contract_Signed_Date__c", "OwnerId", "StageName"]);
  });

  it("keeps relationship paths", () => {
    expect(formulaFieldRefs("Account.Industry = 'Tech'")).toEqual(["Account.Industry"]);
  });
});

describe("parseFlow", () => {
  it("parses a record-triggered after-save flow and resolves writes", () => {
    const flow = parseFlow(
      read("flows/Opportunity_Closed_Won_Followup.flow-meta.xml"),
      "Opportunity_Closed_Won_Followup",
      "f",
    );
    expect(flow.active).toBe(true);
    expect(flow.trigger).toMatchObject({
      object: "Opportunity",
      timing: "after",
      events: ["insert", "update"],
      entryFields: ["StageName"],
    });
    expect(flow.writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ object: "Task", op: "insert" }),
        expect.objectContaining({ object: "Opportunity", op: "update", selfUpdate: true, fields: ["NextStep"] }),
      ]),
    );
  });

  it("parses before-save flows", () => {
    const flow = parseFlow(read("flows/Opportunity_Set_Defaults.flow-meta.xml"), "Opportunity_Set_Defaults", "f");
    expect(flow.trigger).toMatchObject({ timing: "before", events: ["insert"] });
    // "Update Records" on $Record in a before-save flow sets fields in memory.
    expect(flow.fieldSets).toEqual(["Probability"]);
  });

  it("reads the fields a before-save flow sets with Assignment elements, and none for after-save flows", () => {
    const flow = (type: string, set: string) =>
      parseFlow(
        `<?xml version="1.0"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata"><status>Active</status>
        <assignments><name>Set</name><assignmentItems><assignToReference>$Record.${set}</assignToReference><operator>Assign</operator><value><stringValue>x</stringValue></value></assignmentItems><assignmentItems><assignToReference>myVar</assignToReference><operator>Assign</operator><value><stringValue>y</stringValue></value></assignmentItems></assignments>
        <start><object>Case</object><recordTriggerType>CreateAndUpdate</recordTriggerType><triggerType>${type}</triggerType></start></Flow>`,
        "F",
        "f",
      );
    expect(flow("RecordBeforeSave", "Status").fieldSets).toEqual(["Status"]);
    expect(flow("RecordAfterSave", "Status").fieldSets).toEqual([]);
  });

  it("reads the trigger order, from the flow or its start, within 1 to 2000", () => {
    const flow = (inStart: string, inFlow = "") =>
      parseFlow(
        `<?xml version="1.0"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata"><status>Active</status>${inFlow}<start><object>Case</object><recordTriggerType>Create</recordTriggerType><triggerType>RecordAfterSave</triggerType>${inStart}</start></Flow>`,
        "F",
        "f",
      ).trigger?.order;
    expect(flow("", "<triggerOrder>240</triggerOrder>")).toBe(240);
    expect(flow("<triggerOrder>1500</triggerOrder>")).toBe(1500);
    expect(flow("")).toBeUndefined();
    expect(flow("<triggerOrder>0</triggerOrder>")).toBeUndefined();
    expect(flow("<triggerOrder>2001</triggerOrder>")).toBeUndefined();
  });

  it("collects field references from filters, assignments and $Record", () => {
    const flow = parseFlow(
      read("flows/Account_Sync_Tier_To_Contacts.flow-meta.xml"),
      "Account_Sync_Tier_To_Contacts",
      "f",
    );
    expect(flow.fieldRefs).toEqual(
      expect.arrayContaining(["Contact.Account_Tier__c", "Contact.AccountId", "Account.Customer_Tier__c"]),
    );
  });

  it("resolves typed variables, Get Records outputs and loop variables", () => {
    const xml = `<?xml version="1.0"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata">
      <status>Active</status>
      <variables><name>casesToClose</name><dataType>SObject</dataType><isCollection>true</isCollection><objectType>Case</objectType></variables>
      <recordLookups><name>Get_Contacts</name><object>Contact</object></recordLookups>
      <loops><name>Each_Contact</name><collectionReference>Get_Contacts</collectionReference></loops>
      <recordUpdates><name>Close_Cases</name><inputReference>casesToClose</inputReference></recordUpdates>
      <recordDeletes><name>Delete_Contact</name><inputReference>Each_Contact</inputReference></recordDeletes>
    </Flow>`;
    const flow = parseFlow(xml, "Screen", "f");
    expect(flow.trigger).toBeUndefined();
    expect(flow.writes.map((w) => `${w.object}:${w.op}`).sort()).toEqual(["Case:update", "Contact:delete"]);
    expect(flow.reads).toEqual(["Contact"]);
  });
});

describe("apex analysis", () => {
  it("blanks comments and strings without shifting lines", () => {
    const src = "a = 'update x;'; // insert y;\n/* delete z; */ b";
    const s = stripApex(src);
    expect(s.length).toBe(src.length);
    expect(s).not.toMatch(/update|insert|delete/);
    expect(s.split("\n").length).toBe(2);
  });

  it("resolves DML targets from declarations, new, inline SOQL and Database methods", () => {
    const src = `
      List<Account> accs = new List<Account>();
      Contact c = new Contact();
      update accs;
      insert c;
      insert new Task(Subject = 'x');
      delete [SELECT Id FROM Lead WHERE IsConverted = false];
      Database.update(accs, false);
      Database.insert(unknownThing);
    `;
    const a = analyzeApex(src, { projectObjects: new Set() });
    expect(a.writes.map((w) => `${w.object}:${w.op}`).sort()).toEqual([
      "Account:update",
      "Account:update",
      "Contact:insert",
      "Lead:delete",
      "Task:insert",
    ]);
    expect(a.unresolvedDml).toBe(1);
  });

  it("finds SOQL and DML inside loops but not SOQL-for-loop headers", () => {
    const src = `
      for (Account a : [SELECT Id FROM Account]) {
        Contact c = [SELECT Id FROM Contact WHERE AccountId = :a.Id LIMIT 1];
        update c;
      }
    `;
    const a = analyzeApex(src, { projectObjects: new Set() });
    expect(a.loopIssues.map((i) => i.kind).sort()).toEqual(["dml-in-loop", "soql-in-loop"]);
    expect(a.reads.sort()).toEqual(["Account", "Contact"]);
  });

  it("parses triggers without mistaking header events for DML", () => {
    const trig = parseApexTrigger(read("triggers/ContactTrigger.trigger"), "ContactTrigger", "t", objects)!;
    expect(trig.object).toBe("Contact");
    expect(trig.events).toEqual([{ timing: "after", event: "update" }]);
    expect(trig.writes).toEqual([]);
    expect(trig.unresolvedDml).toBe(0);
    expect(trig.classRefs).toContain("ContactTriggerHandler");
  });

  it("parses classes, invocable and test flags", () => {
    const closer = parseApexClass(read("classes/OpportunityCloser.cls"), "OpportunityCloser", "c", objects);
    expect(closer.invocable).toBe(true);
    expect(closer.isTest).toBe(false);
    expect(closer.writes).toEqual([expect.objectContaining({ object: "Opportunity", op: "update" })]);
    const test = parseApexClass(read("classes/OpportunityCloserTest.cls"), "OpportunityCloserTest", "c", objects);
    expect(test.isTest).toBe(true);
  });
});

describe("fields and permissions", () => {
  it("parses roll-up summary fields", () => {
    const f = parseField(
      read("objects/Account/fields/Total_Won_Amount__c.field-meta.xml"),
      "Account",
      "Total_Won_Amount__c",
      "f",
    );
    expect(f.summary).toMatchObject({
      childObject: "Opportunity",
      relationshipField: "AccountId",
      operation: "sum",
      summarizedField: "Opportunity.Amount",
      filterFields: ["Opportunity.StageName"],
    });
  });

  it("parses permission sets", () => {
    const ps = parsePermissionContainer(
      read("permissionsets/Agent_Runtime_User.permissionset-meta.xml"),
      "Agent_Runtime_User",
      "PermissionSet",
      "p",
    );
    expect(ps.objects.find((o) => o.object === "Opportunity")).toMatchObject({ modifyAll: true, viewAll: true });
    expect(ps.fields).toEqual([{ field: "Opportunity.Contract_Signed_Date__c", readable: true, editable: true }]);
  });
});
