// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeChange, applyFixes, findFixes } from "../src/core/index.js";

const SRC = "force-app/main/default/";
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
const json = (o: unknown) => JSON.stringify(o).replace(/"/g, "&quot;");

const procedure = (calls: unknown[]) =>
  `<OmniIntegrationProcedure ${NS}><isActive>true</isActive><isIntegrationProcedure>true</isIntegrationProcedure><language>Procedure</language><name>Order Create</name>${calls
    .map(
      (c, i) =>
        `<omniProcessElements><isActive>true</isActive><name>Call${i}</name><propertySetConfig>${json(c)}</propertySetConfig><type>Remote Action</type></omniProcessElements>`,
    )
    .join("")}<subType>Create</subType><type>Order</type><versionNumber>1.0</versionNumber></OmniIntegrationProcedure>`;

describe("fix templates for Apex", () => {
  let dir: string;
  const write = (rel: string, body: string) => {
    const f = path.join(dir, SRC, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  };
  const read = (rel: string) => readFileSync(path.join(dir, SRC, rel), "utf8");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "pipe" });
  const commit = () => {
    git("add", "-A");
    git("commit", "-q", "-m", "base");
  };
  const fixes = () => findFixes({ projectDir: dir, base: "HEAD", config: false });
  const rules = () =>
    analyzeChange({ projectDir: dir, base: "HEAD", config: false }).result.findings.map((f) => f.rule);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-fix-apex-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    git("init", "-q", "-b", "main");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const PRICING = [
    "public with sharing class Pricing {",
    "    public static Object price(Map<String, Object> args) {",
    "        return 1;",
    "    }",
    "    public void log(Map<String, Object> args) {}",
    "}",
    "",
  ].join("\n");

  it("makes a Remote Action class callable, dispatching to the methods the script calls", () => {
    write("classes/Pricing.cls", PRICING);
    write(
      "classes/Pricing.cls-meta.xml",
      `<ApexClass ${NS}><apiVersion>60.0</apiVersion><status>Active</status></ApexClass>`,
    );
    write("omniIntegrationProcedures/Order_Create.oip-meta.xml", procedure([]));
    commit();
    write(
      "omniIntegrationProcedures/Order_Create.oip-meta.xml",
      procedure([
        { remoteClass: "Pricing", remoteMethod: "price" },
        { remoteMethod: "log", remoteClass: "Pricing" },
      ]),
    );
    const report = fixes();
    const fix = report.fixes.find((f) => f.rule === "omnistudio-remote-not-callable");
    expect(fix?.kind).toBe("review");
    expect(fix?.diff).toContain("+public with sharing class Pricing implements System.Callable {");
    applyFixes(dir, [fix!]);
    const cls = read("classes/Pricing.cls");
    expect(cls).toContain("implements System.Callable {");
    expect(cls).toContain("when 'price' {\n                return price(args);");
    expect(cls).toContain("when 'log' {\n                log(args);\n                return null;");
    expect(cls).toContain("ExtensionMalformedCallException('Method not implemented: ' + action)");
    expect(rules()).not.toContain("omnistudio-remote-not-callable");
  });

  it("adds Callable to an existing implements list, and leaves methods with other arguments to a person", () => {
    write(
      "classes/Pricing.cls",
      "public class Pricing implements Queueable {\n    public void execute(QueueableContext c) {}\n    public static Object price(Map<String, Object> args) { return 1; }\n    public static Object quote(String id) { return 1; }\n}\n",
    );
    write("omniIntegrationProcedures/Order_Create.oip-meta.xml", procedure([]));
    commit();
    write(
      "omniIntegrationProcedures/Order_Create.oip-meta.xml",
      procedure([
        { remoteClass: "Pricing", remoteMethod: "price" },
        { remoteClass: "Pricing", remoteMethod: "quote" },
      ]),
    );
    const fix = fixes().fixes.find((f) => f.rule === "omnistudio-remote-not-callable");
    expect(fix?.note).toContain("quote");
    applyFixes(dir, [fix!]);
    expect(read("classes/Pricing.cls")).toContain("implements Queueable, System.Callable {");
  });

  it("proposes nothing when no method fits", () => {
    write("classes/Pricing.cls", "public class Pricing { public static Object quote(String id) { return 1; } }\n");
    write("omniIntegrationProcedures/Order_Create.oip-meta.xml", procedure([]));
    commit();
    write(
      "omniIntegrationProcedures/Order_Create.oip-meta.xml",
      procedure([{ remoteClass: "Pricing", remoteMethod: "quote" }]),
    );
    expect(fixes().fixes.map((f) => f.rule)).not.toContain("omnistudio-remote-not-callable");
  });

  const LOOP = (body: string) =>
    [
      "public with sharing class AccountService {",
      "    public static void rate(List<Account> accounts) {",
      "        for (Account a : accounts) {",
      body,
      "        }",
      "    }",
      "}",
      "",
    ].join("\n");

  it("saves records once after the loop instead of in it", () => {
    write("classes/AccountService.cls", LOOP("            a.Rating = 'Hot';\n            update a;"));
    write(
      "classes/AccountService.cls-meta.xml",
      `<ApexClass ${NS}><apiVersion>60.0</apiVersion><status>Active</status></ApexClass>`,
    );
    commit();
    write(
      "classes/AccountService.cls",
      LOOP("            a.Rating = 'Hot';\n            update a;\n").replace("Hot", "Warm"),
    );
    const fix = fixes().fixes.find((f) => f.rule === "dml-or-soql-in-loop");
    expect(fix?.label).toBe("Save the Account records once, after the loop");
    applyFixes(dir, [fix!]);
    expect(read("classes/AccountService.cls")).toBe(
      [
        "public with sharing class AccountService {",
        "    public static void rate(List<Account> accounts) {",
        "        List<Account> aUpdateList = new List<Account>();",
        "        for (Account a : accounts) {",
        "            a.Rating = 'Warm';",
        "            aUpdateList.add(a);",
        "",
        "        }",
        "        update aUpdateList;",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    expect(rules()).not.toContain("dml-or-soql-in-loop");
  });

  it.each([
    ["the variable is used after the save", "            insert a;\n            Id x = a.Id;"],
    ["the loop can leave early", "            if (a.Name == null) { return; }\n            update a;"],
    ["it is a different record", "            update new Account(Id = a.Id);"],
    ["it is in a try block", "            try { update a; } catch (Exception e) {}"],
  ])("leaves the loop alone when %s", (_why, body) => {
    write("classes/AccountService.cls", LOOP("            a.Name = 'x';"));
    commit();
    write("classes/AccountService.cls", LOOP(body));
    expect(fixes().fixes.map((f) => f.rule)).not.toContain("dml-or-soql-in-loop");
  });
});
