// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONDITION_RULES } from "../src/core/baseline.js";
import { analyze, insightFor, loadProject } from "../src/core/index.js";
import { callsInSettings, omniOf, parseOmni, remoteCallable } from "../src/core/omnistudio.js";
import { classifyPath } from "../src/core/project.js";
import { RULES } from "../src/core/rules.js";
import type { Change, Finding } from "../src/core/types.js";

const base = "force-app/main/default/";
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
const json = (o: unknown) => JSON.stringify(o).replace(/"/g, "&quot;");

/** One `omniProcessElements` entry; `children` become `childElements` (a block's contents). */
const el = (name: string, type: string, settings: unknown, opts: { active?: boolean; children?: string } = {}) =>
  `<omniProcessElements>${opts.children ?? ""}<isActive>${opts.active ?? true}</isActive><name>${name}</name><propertySetConfig>${json(settings)}</propertySetConfig><type>${type}</type></omniProcessElements>`;
const child = (inner: string) => inner.replace(/omniProcessElements>/g, "childElements>");

const procedure = (type: string, sub: string, elements: string[], active = true) =>
  `<OmniIntegrationProcedure ${NS}><isActive>${active}</isActive><isIntegrationProcedure>true</isIntegrationProcedure><language>Procedure</language><name>${type} ${sub}</name>${elements.join("")}<subType>${sub}</subType><type>${type}</type><versionNumber>1.0</versionNumber></OmniIntegrationProcedure>`;
const script = (type: string, sub: string, elements: string[]) =>
  `<OmniScript ${NS}><isActive>true</isActive><isIntegrationProcedure>false</isIntegrationProcedure><language>English</language><name>${type} ${sub}</name>${elements.join("")}<omniProcessType>OmniScript</omniProcessType><subType>${sub}</subType><type>${type}</type></OmniScript>`;
const item = (fields: Record<string, string>) =>
  `<omniDataTransformItem>${Object.entries(fields)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join("")}</omniDataTransformItem>`;
const mapper = (name: string, type: string, items: string[], active = true) =>
  `<OmniDataTransform ${NS}><active>${active}</active><name>${name}</name>${items.join("")}<type>${type}</type></OmniDataTransform>`;
const card = (name: string, ipMethod: string, active = true) =>
  `<OmniUiCard ${NS}><dataSourceConfig>${json({ dataSource: { type: "IntegrationProcedures", value: { ipMethod, inputMap: { recordId: "{recordId}" } } } })}</dataSourceConfig><isActive>${active}</isActive><name>${name}</name><propertySetConfig>${json({ states: [{ fields: [], name: "Active" }] })}</propertySetConfig></OmniUiCard>`;
const field = (name: string) =>
  `<CustomField ${NS}><fullName>${name}</fullName><label>${name}</label><type>Text</type><length>80</length></CustomField>`;

const IP_CREATE = "omniIntegrationProcedures/Order_Create_1.oip-meta.xml";
const IP_VALIDATE = "omniIntegrationProcedures/Order_Validate_1.oip-meta.xml";
const DM_LOAD = "omniDataTransforms/OrderLoad.rpt-meta.xml";
const DM_EXTRACT = "omniDataTransforms/AccountExtract.rpt-meta.xml";
const OS_ENTRY = "omniScripts/Order_Entry_English_1.os-meta.xml";
const CARD = "omniUiCard/OrderCard.ouc-meta.xml";

describe("OmniStudio parsing", () => {
  it("reads what each element's settings call, at any depth", () => {
    expect(callsInSettings({ remoteClass: "OrderService", remoteMethod: "create", remoteOptions: {} }, "Save")).toEqual(
      [{ kind: "ApexClass", target: "OrderService", method: "create", element: "Save" }],
    );
    expect(
      callsInSettings({
        integrationProcedureKey: "Order_Create",
        remoteOptions: { preTransformBundle: "OrderIn" },
        postTransformBundle: "OrderOut",
      })
        .map((c) => `${c.kind}:${c.target}`)
        .sort(),
    ).toEqual(["DataMapper:OrderIn", "DataMapper:OrderOut", "IntegrationProcedure:Order_Create"]);
    // A Step's empty remote settings call nothing.
    expect(callsInSettings({ label: "Step", remoteClass: "", remoteMethod: "" })).toEqual([]);
    expect(
      callsInSettings({ Type: "Order", "Sub Type": "Review", Language: "English" }, "Embed", "OmniScript"),
    ).toEqual([{ kind: "OmniScript", target: "Order_Review", element: "Embed" }]);
    expect(
      callsInSettings({ dataSource: { type: "IntegrationProcedures", value: { ipMethod: "Order_Create" } } }).map(
        (c) => [c.kind, c.target],
      ),
    ).toEqual([["IntegrationProcedure", "Order_Create"]]);
  });

  it("reads a procedure's name, nested elements and skips inactive ones", () => {
    const ip = parseOmni(
      "IntegrationProcedure",
      procedure("Order", "Create", [
        el("Load", "DataRaptor Post Action", { bundle: "OrderLoad" }),
        el("Old", "Remote Action", { remoteClass: "Gone" }, { active: false }),
        el(
          "Block",
          "Conditional Block",
          {},
          { children: child(el("Inner", "Remote Action", { remoteClass: "ChildRemote" })) },
        ),
      ]),
      "Order_Create_1",
      IP_CREATE,
    );
    expect(ip.name).toBe("Order_Create");
    expect(ip.calls.map((c) => `${c.kind}:${c.target}`).sort()).toEqual([
      "ApexClass:ChildRemote",
      "DataMapper:OrderLoad",
    ]);
  });

  it("reads what a Data Mapper Extract reads and a Load writes", () => {
    const extract = parseOmni(
      "DataMapper",
      mapper("AccountExtract", "Extract", [
        item({ inputObjectName: "Account", outputFieldName: "Acct", filterValue: "recordId" }),
        item({ inputFieldName: "Acct:Name", outputFieldName: "Account:Name" }),
        item({ inputFieldName: "Acct:Rating__c", outputFieldName: "Account:Rating" }),
      ]),
      "AccountExtract",
      DM_EXTRACT,
    );
    expect(extract.reads.map((r) => `${r.object}.${r.field ?? ""}`)).toEqual([
      "Account.",
      "Account.Name",
      "Account.Rating__c",
    ]);
    const load = parseOmni(
      "DataMapper",
      mapper("OrderLoad", "Load", [
        item({ inputFieldName: "order:status", outputObjectName: "Order__c", outputFieldName: "Status__c" }),
        item({ inputFieldName: "order:total", outputObjectName: "Order__c", outputFieldName: "Total__c" }),
      ]),
      "OrderLoad",
      DM_LOAD,
    );
    expect(load.writes.map((w) => `${w.object}.${w.field}`)).toEqual(["Order__c.Status__c", "Order__c.Total__c"]);
    expect(load.reads).toEqual([]);
  });
});

describe("OmniStudio in the analysis", () => {
  let dir: string;
  const write = (rel: string, body: string) => {
    const f = path.join(dir, base, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  };
  const run = (rel: string, changeType: Change["changeType"] = "modified", baseXml?: string) =>
    analyze({
      model: loadProject(dir, { cache: false }),
      changes: [{ changeType, component: classifyPath(base + rel) }],
      readBase: () => baseXml,
    });
  const byRule = (fs: Finding[], rule: string) => fs.filter((f) => f.rule === rule);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-omni-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    write("objects/Order__c/Order__c.object-meta.xml", `<CustomObject ${NS}><label>Order</label></CustomObject>`);
    for (const f of ["Status__c", "Total__c"]) write(`objects/Order__c/fields/${f}.field-meta.xml`, field(f));
    write("objects/Account/fields/Rating__c.field-meta.xml", field("Rating__c"));
    write(
      "classes/OrderService.cls",
      "global with sharing class OrderService implements System.Callable { public Object call(String action, Map<String, Object> args) { insert new Order__c(); return null; } }",
    );
    write("classes/LegacyPricing.cls", "public class LegacyPricing { public static Decimal price() { return 1; } }");
    write(
      "classes/BaseRemote.cls",
      "public virtual class BaseRemote implements Callable { public Object call(String a, Map<String,Object> m) { return null; } }",
    );
    write("classes/ChildRemote.cls", "public class ChildRemote extends BaseRemote { }");
    write(
      IP_CREATE,
      procedure("Order", "Create", [
        el("LoadOrder", "DataRaptor Post Action", { bundle: "OrderLoad" }),
        el("Create", "Remote Action", { remoteClass: "OrderService", remoteMethod: "create" }),
        el("Price", "Remote Action", { remoteClass: "LegacyPricing", remoteMethod: "price" }),
        el("Validate", "Integration Procedure Action", { integrationProcedureKey: "Order_Validate" }),
        el(
          "Block",
          "Conditional Block",
          {},
          { children: child(el("Inner", "Remote Action", { remoteClass: "ChildRemote" })) },
        ),
      ]),
    );
    write(
      IP_VALIDATE,
      procedure("Order", "Validate", [
        el("Again", "Integration Procedure Action", { integrationProcedureKey: "Order_Create" }),
      ]),
    );
    write(
      DM_LOAD,
      mapper("OrderLoad", "Load", [
        item({ inputFieldName: "order:status", outputObjectName: "Order__c", outputFieldName: "Status__c" }),
        item({ inputFieldName: "order:total", outputObjectName: "Order__c", outputFieldName: "Total__c" }),
      ]),
    );
    write(
      DM_EXTRACT,
      mapper("AccountExtract", "Extract", [
        item({ inputObjectName: "Account", outputFieldName: "Acct" }),
        item({ inputFieldName: "Acct:Rating__c", outputFieldName: "Account:Rating" }),
      ]),
    );
    write(
      OS_ENTRY,
      script("Order", "Entry", [
        el("Account", "DataRaptor Extract Action", { bundle: "AccountExtract" }),
        el("Submit", "Integration Procedure Action", { integrationProcedureKey: "Order_Create" }),
        el("Summary", "Custom Lightning Web Component", { lwcName: "orderSummary" }),
      ]),
    );
    write(CARD, card("OrderCard", "Order_Create"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds every component in the project", () => {
    const all = omniOf(loadProject(dir, { cache: false }));
    expect(all.map((o) => `${o.kind}:${o.name}`).sort()).toEqual([
      "DataMapper:AccountExtract",
      "DataMapper:OrderLoad",
      "FlexCard:OrderCard",
      "IntegrationProcedure:Order_Create",
      "IntegrationProcedure:Order_Validate",
      "OmniScript:Order_Entry",
    ]);
  });

  it("a changed Integration Procedure: who uses it, a class it can't call, a loop, and what it saves", () => {
    const r = run(IP_CREATE);
    const used = byRule(r.findings, "omnistudio-used-by")[0]!;
    expect(used.detail).toContain("OmniScript Order_Entry");
    expect(used.detail).toContain("FlexCard OrderCard");
    expect(used.detail).toContain("Integration Procedure Order_Validate");
    // LegacyPricing implements nothing; ChildRemote inherits Callable from BaseRemote.
    const notCallable = byRule(r.findings, "omnistudio-remote-not-callable");
    expect(notCallable.map((f) => [f.title, f.severity])).toEqual([
      ["LegacyPricing is a Remote Action's class but does not implement Callable", "high"],
    ]);
    expect(byRule(r.findings, "omnistudio-cycle")[0]?.detail).toContain(
      "Integration Procedure Order_Create → Integration Procedure Order_Validate → Integration Procedure Order_Create",
    );
    expect(byRule(r.findings, "omnistudio-missing-reference")).toEqual([]);
    // Saving Order__c, through the Data Mapper and OrderService.
    expect(r.impactedObjects).toContain("Order__c");
  });

  it("knows which classes can be Remote Action classes", () => {
    const model = loadProject(dir, { cache: false });
    expect(remoteCallable(model, "OrderService")).toBe(true);
    expect(remoteCallable(model, "ChildRemote")).toBe(true);
    expect(remoteCallable(model, "LegacyPricing")).toBe(false);
    expect(remoteCallable(model, "NotHere")).toBeUndefined();
  });

  it("an OmniScript that calls a component the project lacks", () => {
    const r = run(OS_ENTRY);
    const [f] = byRule(r.findings, "omnistudio-missing-reference");
    expect(f?.detail).toContain("Lightning component orderSummary (element Summary)");
    expect(f?.severity).toBe("medium");
  });

  it("a Data Mapper writing a field the project doesn't have", () => {
    write(
      DM_LOAD,
      mapper("OrderLoad", "Load", [item({ outputObjectName: "Order__c", outputFieldName: "Discount__c" })]),
    );
    expect(byRule(run(DM_LOAD).findings, "omnistudio-missing-reference")[0]?.detail).toContain(
      "field Order__c.Discount__c",
    );
  });

  it("deleting a Data Mapper a procedure still uses", () => {
    const before = mapper("OrderLoad", "Load", [item({ outputObjectName: "Order__c", outputFieldName: "Status__c" })]);
    rmSync(path.join(dir, base, DM_LOAD));
    const [f] = byRule(run(DM_LOAD, "deleted", before).findings, "deleted-still-referenced");
    expect(f?.title).toBe("Deleted Data Mapper OrderLoad is still used");
    expect(f?.detail).toContain("Integration Procedure Order_Create");
    expect(f?.severity).toBe("high");
  });

  it("deleting one version of a procedure while another stays is fine", () => {
    write("omniIntegrationProcedures/Order_Validate_2.oip-meta.xml", procedure("Order", "Validate", []));
    const before = procedure("Order", "Validate", []);
    rmSync(path.join(dir, base, IP_VALIDATE));
    expect(byRule(run(IP_VALIDATE, "deleted", before).findings, "deleted-still-referenced")).toEqual([]);
  });

  it("an inactive Data Mapper that is still called (Data Mappers write <active>)", () => {
    write(
      DM_LOAD,
      mapper("OrderLoad", "Load", [item({ outputObjectName: "Order__c", outputFieldName: "Status__c" })], false),
    );
    expect(byRule(run(DM_LOAD).findings, "omnistudio-inactive-in-use")[0]?.title).toBe(
      "Data Mapper OrderLoad is inactive but still used",
    );
  });

  it("an inactive procedure that is still called", () => {
    write(IP_VALIDATE, procedure("Order", "Validate", [], false));
    expect(byRule(run(IP_VALIDATE).findings, "omnistudio-inactive-in-use")[0]?.detail).toContain(
      "Integration Procedure Order_Create",
    );
  });

  it("a changed Apex class used by OmniStudio, and one deleted while still used", () => {
    const r = run("classes/LegacyPricing.cls");
    expect(byRule(r.findings, "apex-called-from-omnistudio")[0]?.detail).toContain(
      "Integration Procedure Order_Create",
    );
    expect(byRule(r.findings, "omnistudio-remote-not-callable")).toHaveLength(1);
    expect(byRule(run("classes/OrderService.cls").findings, "omnistudio-remote-not-callable")).toEqual([]);
    rmSync(path.join(dir, base, "classes/OrderService.cls"));
    const [gone] = byRule(run("classes/OrderService.cls", "deleted").findings, "deleted-still-referenced");
    expect(gone?.detail).toContain("Integration Procedure Order_Create");
  });

  it("fields a Data Mapper reads or writes count as references", () => {
    rmSync(path.join(dir, base, "objects/Order__c/fields/Total__c.field-meta.xml"));
    const [f] = byRule(
      run("objects/Order__c/fields/Total__c.field-meta.xml", "deleted").findings,
      "deleted-still-referenced",
    );
    expect(f?.detail).toContain("Data Mapper OrderLoad");
  });

  it("a new validation rule applies to the Data Mapper Loads that write its object", () => {
    write(
      "objects/Order__c/validationRules/Needs_Total.validationRule-meta.xml",
      `<ValidationRule ${NS}><fullName>Needs_Total</fullName><active>true</active><errorConditionFormula>ISBLANK(Total__c)</errorConditionFormula><errorMessage>Total</errorMessage></ValidationRule>`,
    );
    const [f] = byRule(
      run("objects/Order__c/validationRules/Needs_Total.validationRule-meta.xml", "added").findings,
      "validation-rule-vs-existing-automation",
    );
    expect(f?.detail).toContain("Data Mapper OrderLoad");
  });

  it("shows who uses an OmniStudio file and what it calls", () => {
    const model = loadProject(dir, { cache: false });
    const insight = insightFor(model, base + IP_CREATE);
    expect(insight.summary).toBe(
      "Used by 1 Integration Procedure, 1 OmniScript, 1 FlexCard · calls 3 Apex classes, 1 Data Mapper, 1 Integration Procedure",
    );
    expect(insightFor(model, `${base}classes/OrderService.cls`).summary).toContain("Called by 1 Integration Procedure");
  });

  it("counts OmniStudio as analyzed in depth, and its rules are documented", () => {
    // Coverage is reported only when part of the change is not analyzed in depth.
    expect(run(IP_CREATE).coverage).toBeUndefined();
    const ids = new Set(RULES.map((r) => r.id));
    for (const id of [
      "omnistudio-used-by",
      "omnistudio-missing-reference",
      "omnistudio-remote-not-callable",
      "omnistudio-inactive-in-use",
      "omnistudio-cycle",
      "apex-called-from-omnistudio",
    ])
      expect(ids.has(id)).toBe(true);
    for (const id of ["omnistudio-missing-reference", "omnistudio-remote-not-callable", "omnistudio-cycle"])
      expect(CONDITION_RULES.has(id)).toBe(true);
    expect(CONDITION_RULES.has("omnistudio-used-by")).toBe(false);
  });
});
