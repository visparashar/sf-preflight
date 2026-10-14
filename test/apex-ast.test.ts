// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyze, fieldReferences, loadProject, toChanges } from "../src/core/index.js";
import { analyzeApexAst } from "../src/core/parsers/apexAst.js";

const objects = new Set(["account", "contact", "opportunity", "invoice__c", "order_event__e"]);
const parseClass = (src: string) => {
  const r = analyzeApexAst(src, { projectObjects: objects, kind: "class" });
  if ("errors" in r) throw new Error(JSON.stringify(r.errors));
  return r;
};
const writes = (src: string) =>
  parseClass(src)
    .writes.map((w) => `${w.object}:${w.op}`)
    .sort();

describe("AST: DML target resolution", () => {
  it("resolves locals, parameters, for-each variables, class fields and properties", () => {
    const src = `
      public class S {
        public Map<Id, Account> accountMap { get; set; }
        void run(List<Contact> contacts) {
          Opportunity[] opps = new Opportunity[]{};
          for (Invoice__c inv : [SELECT Id FROM Invoice__c]) { update inv; }
          update contacts;
          insert opps;
          upsert accountMap.values();
          delete this.pending;
        }
        private List<Case> pending;
      }`;
    expect(writes(src)).toEqual([
      "Account:upsert",
      "Case:delete",
      "Contact:update",
      "Invoice__c:update",
      "Opportunity:insert",
    ]);
  });

  it("resolves new, casts, inline SOQL, method return types and Database.* calls", () => {
    const src = `
      public class S {
        List<Account> load() { return [SELECT Id FROM Account]; }
        void run(Object o) {
          insert new Contact(LastName = 'x');
          update (List<Opportunity>) o;
          delete [SELECT Id FROM Invoice__c WHERE Paid__c = false];
          update load();
          Database.insert(new List<Case>(), false);
          Database.upsertImmediate(new Account(Name = 'y'));
        }
      }`;
    expect(writes(src)).toEqual([
      "Account:update",
      "Account:upsert",
      "Case:insert",
      "Contact:insert",
      "Invoice__c:delete",
      "Opportunity:update",
    ]);
  });

  it("counts unresolved DML instead of guessing", () => {
    const r = parseClass("public class S { void run(List<SObject> recs, Object x) { update recs; insert x; } }");
    expect(r.writes).toEqual([]);
    expect(r.unresolvedDml).toBe(2);
  });

  it("treats EventBus.publish as an insert of the platform event", () => {
    expect(writes("public class S { void f() { EventBus.publish(new Order_Event__e()); } }")).toEqual([
      "Order_Event__e:insert",
    ]);
  });
});

describe("AST: loops", () => {
  it("flags DML/SOQL in loop bodies but not in the SOQL-for collection", () => {
    const r = parseClass(`
      public class S {
        void f(List<Contact> cs) {
          for (Account a : [SELECT Id FROM Account]) {
            Contact c = [SELECT Id FROM Contact WHERE AccountId = :a.Id LIMIT 1];
          }
          Integer i = 0;
          while (i < 3) { insert new Case(); i++; }
          do { update cs; } while (false);
          for (Integer j = 0; j < 2; j++) Database.delete(cs);
        }
      }`);
    expect(r.loopIssues.map((l) => `${l.line}:${l.kind}`)).toEqual([
      "5:soql-in-loop",
      "8:dml-in-loop",
      "9:dml-in-loop",
      "10:dml-in-loop",
    ]);
  });

  it("does not report DML in a method just because the method is called elsewhere", () => {
    const r = parseClass("public class S { void a() { update new Account(); } void b() { a(); } }");
    expect(r.loopIssues).toEqual([]);
  });
});

describe("AST: ignored save results", () => {
  const issues = (body: string) =>
    parseClass(`public class S { void f(List<Account> accs, List<Id> ids) { ${body} } }`).saveIssues?.map(
      (i) => `${i.op}:${i.kind}`,
    );

  it("flags partial-success saves whose result is thrown away or never read", () => {
    expect(issues("Database.update(accs, false);")).toEqual(["update:discarded"]);
    expect(issues("Database.delete(ids, false);")).toEqual(["delete:discarded"]);
    expect(issues("Database.upsert(accs, Account.Id, false);")).toEqual(["upsert:discarded"]);
    expect(issues("List<Database.SaveResult> r = Database.insert(accs, false);")).toEqual(["insert:unread"]);
    expect(issues("Database.SaveResult[] r; r = Database.update(accs, false);")).toEqual(["update:unread"]);
  });

  it("does not flag saves that stop on failure, or whose result is used", () => {
    expect(issues("Database.update(accs);")).toEqual([]);
    expect(issues("Database.update(accs, true);")).toEqual([]);
    expect(issues("update accs;")).toEqual([]);
    expect(
      issues(
        "List<Database.SaveResult> r = Database.update(accs, false); for (Database.SaveResult s : r) { s.isSuccess(); }",
      ),
    ).toEqual([]);
    expect(issues("Boolean ok = Database.update(accs, false)[0].isSuccess();")).toEqual([]);
    expect(
      issues("Database.SaveResult[] r; r = Database.update(accs, false); if (r[0].isSuccess()) { return; }"),
    ).toEqual([]);
  });
});

describe("AST: triggers, annotations and field references", () => {
  it("parses trigger headers and marks Trigger.new updates as self updates", () => {
    const r = analyzeApexAst(
      "trigger T on Account (before update, after insert) { update Trigger.new; Database.update(Trigger.newMap.values()); }",
      { projectObjects: objects, kind: "trigger" },
    );
    if ("errors" in r) throw new Error("parse failed");
    expect(r.triggerObject).toBe("Account");
    expect(r.triggerEvents).toEqual([
      { timing: "before", event: "update" },
      { timing: "after", event: "insert" },
    ]);
    expect(r.writes.every((w) => w.object === "Account" && w.selfUpdate)).toBe(true);
  });

  it("detects @isTest classes and @InvocableMethod methods", () => {
    expect(parseClass("@isTest private class T { @isTest static void t() {} }").isTest).toBe(true);
    const inv = parseClass("public class A { @InvocableMethod(label='x') public static void go(List<Id> ids) {} }");
    expect(inv.invocable).toBe(true);
    expect(inv.methods?.find((m) => m.name === "go")?.invocable).toBe(true);
  });

  it("collects field references and writes from code and SOQL", () => {
    const r = parseClass(`
      public class S {
        void f(Account a, Opportunity o) {
          a.Rating = 'Hot';
          String s = o.StageName;
          List<Contact> cs = [SELECT Id, Account.Industry FROM Contact WHERE Email != null ORDER BY LastName];
          insert new Invoice__c(Amount__c = 10);
          unknownThing.Custom__c = 1;
        }
      }`);
    expect(r.fieldWrites).toEqual(expect.arrayContaining(["Account.Rating", "Invoice__c.Amount__c"]));
    expect(r.fieldRefs).toEqual(
      expect.arrayContaining([
        "Opportunity.StageName",
        "Contact.Id",
        "Contact.Account.Industry",
        "Contact.Email",
        "Contact.LastName",
        "Invoice__c.Amount__c",
        "*.Custom__c",
      ]),
    );
  });

  it("reports syntax errors so callers can fall back", () => {
    const r = analyzeApexAst("public class Broken { void f( { }", { projectObjects: objects, kind: "class" });
    expect("errors" in r && r.errors.length > 0).toBe(true);
  });
});

describe("project-level: call graph, references and fallback", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-preflight-ast-"));
  const src = path.join(dir, "force-app/main/default");
  const write = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    writeFileSync(path.join(src, rel), body);
  };
  write("../../../sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
  write(
    "objects/Account/fields/Industry.field-meta.xml",
    `<?xml version="1.0"?><CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Industry</fullName><type>Picklist</type></CustomField>`,
  );
  write(
    "triggers/ContactTrigger.trigger",
    "trigger ContactTrigger on Contact (after update) { ContactService.sync(Trigger.new); }",
  );
  write(
    "classes/ContactService.cls",
    `public class ContactService {
      public static void sync(List<Contact> contacts) {
        for (Contact c : contacts) {
          AccountRepo.touch(c.AccountId);
          stamp(c);
        }
      }
      static void stamp(Contact c) { Audit.log(c.Id); }
    }`,
  );
  write(
    "classes/AccountRepo.cls",
    `public class AccountRepo {
      public static void touch(Id accountId) {
        Account a = [SELECT Id, Industry FROM Account WHERE Id = :accountId];
        update a;
      }
    }`,
  );
  write(
    "classes/Audit.cls",
    "public class Audit { public static void log(Id i) { insert new Task(Subject = String.valueOf(i)); } }",
  );
  write("classes/Broken.cls", "public class Broken { void f( { update [SELECT Id FROM Account]; } ");
  const model = loadProject(dir);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds DML and SOQL hidden in helpers called from a loop, across classes", () => {
    const issues = model.classes.get("contactservice")!.loopIssues.map((l) => `${l.line}:${l.kind}:${l.via}`);
    expect(issues).toEqual([
      "4:soql-in-loop:AccountRepo.touch",
      "4:dml-in-loop:AccountRepo.touch",
      "5:dml-in-loop:ContactService.stamp",
    ]);
  });

  it("explains the indirect loop issue in the finding", () => {
    const { changes } = toChanges([
      { file: "force-app/main/default/classes/ContactService.cls", changeType: "modified" },
    ]);
    const r = analyze({ model, changes });
    const f = r.findings.find((x) => x.rule === "dml-or-soql-in-loop" && x.title.includes("ContactService"));
    expect(f?.severity).toBe("high");
    expect(f?.detail).toContain("(inside AccountRepo.touch())");
  });

  it("follows the trigger → service → repo chain for cascades", () => {
    const { changes } = toChanges([
      { file: "force-app/main/default/triggers/ContactTrigger.trigger", changeType: "modified" },
    ]);
    const r = analyze({ model, changes });
    expect(r.impactedObjects).toEqual(expect.arrayContaining(["Contact", "Account", "Task"]));
  });

  it("matches standard-field references precisely via the AST, including SOQL", () => {
    const refs = fieldReferences(model, "Account", "Industry").map((r) => `${r.from.kind}:${r.from.name}`);
    expect(refs).toEqual(["ApexClass:AccountRepo"]);
  });

  it("falls back to heuristic analysis for files with syntax errors and warns", () => {
    const broken = model.classes.get("broken")!;
    expect(broken.parser).toBe("heuristic");
    expect(broken.writes.map((w) => w.object)).toEqual(["Account"]);
    expect(model.warnings.some((w) => w.includes("Broken.cls") && w.includes("heuristic"))).toBe(true);
  });
});
