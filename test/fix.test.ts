// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confirmInAgentScript, setChild } from "../src/core/fixers.js";
import { analyzeChange, applyFixes, findFixes, fixesToMarkdown } from "../src/core/index.js";
import { unifiedDiff } from "../src/core/textDiff.js";

const SRC = "force-app/main/default/";
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

describe("unified diff", () => {
  it("shows only the changed lines with context", () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const b = a.replace("line 10", "line ten");
    const d = unifiedDiff("x.xml", a, b);
    expect(d.split("\n")).toEqual([
      "--- a/x.xml",
      "+++ b/x.xml",
      "@@ -8,7 +8,7 @@",
      " line 7",
      " line 8",
      " line 9",
      "-line 10",
      "+line ten",
      " line 11",
      " line 12",
      " line 13",
    ]);
    expect(unifiedDiff("x", "same", "same")).toBe("");
  });
});

describe("text edits", () => {
  it("sets or adds a child element, keeping the indentation", () => {
    const block = "<GenAiFunction>\n    <masterLabel>X</masterLabel>\n</GenAiFunction>";
    expect(setChild(block, "GenAiFunction", "isConfirmationRequired", "true")).toBe(
      "<GenAiFunction>\n    <isConfirmationRequired>true</isConfirmationRequired>\n    <masterLabel>X</masterLabel>\n</GenAiFunction>",
    );
    expect(setChild("<a><b>1</b></a>", "a", "b", "2")).toBe("<a><b>2</b></a>");
  });

  it("asks for confirmation in an Agent Script action", () => {
    const script = [
      "subagent Care:",
      "    actions:",
      "        Remove_Case:",
      '            label: "Remove Case"',
      '            target: "flow://Remove_Case"',
      "            inputs:",
      "                recordId: string",
      "        Other:",
      '            target: "flow://Other"',
    ].join("\n");
    const out = confirmInAgentScript(script, "Remove Case")!.split("\n");
    expect(out[5]).toBe("            require_user_confirmation: True");
    expect(out.filter((l) => l.includes("require_user_confirmation"))).toHaveLength(1);
    expect(confirmInAgentScript(script, "Missing")).toBeUndefined();
  });
});

describe("fixes in a project", () => {
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
    dir = mkdtempSync(path.join(tmpdir(), "preflight-fix-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    git("init", "-q", "-b", "main");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("uses https for a named credential, checks the fix, applies it, and the finding is gone", () => {
    const nc = (url: string) =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<NamedCredential ${NS}>\n    <endpoint>${url}</endpoint>\n    <label>Pay</label>\n    <principalType>NamedUser</principalType>\n    <protocol>Password</protocol>\n</NamedCredential>\n`;
    write("namedCredentials/Pay.namedCredential-meta.xml", nc("https://api.pay.com"));
    commit();
    write("namedCredentials/Pay.namedCredential-meta.xml", nc("http://api.pay.com"));
    const report = fixes();
    expect(report.fixes.map((f) => [f.rule, f.kind, f.label])).toEqual([
      ["integration-insecure", "safe", "Use https for the named credential"],
    ]);
    const [fix] = report.fixes;
    expect(fix!.diff).toContain("-    <endpoint>http://api.pay.com</endpoint>");
    expect(fix!.diff).toContain("+    <endpoint>https://api.pay.com</endpoint>");
    expect(fixesToMarkdown(report)).toContain("```diff");
    expect(applyFixes(dir, report.fixes)).toEqual({ applied: [fix!.id], stale: [] });
    expect(read("namedCredentials/Pay.namedCredential-meta.xml")).toBe(nc("https://api.pay.com"));
    expect(rules()).not.toContain("integration-insecure");
  });

  it("does not apply a fix to a file that changed after it was analyzed", () => {
    write(
      "remoteSiteSettings/Geo.remoteSite-meta.xml",
      `<RemoteSiteSetting ${NS}><disableProtocolSecurity>false</disableProtocolSecurity><isActive>true</isActive><url>https://geo.example.org</url></RemoteSiteSetting>`,
    );
    commit();
    write(
      "remoteSiteSettings/Geo.remoteSite-meta.xml",
      `<RemoteSiteSetting ${NS}><disableProtocolSecurity>true</disableProtocolSecurity><isActive>true</isActive><url>http://geo.example.org</url></RemoteSiteSetting>`,
    );
    const report = fixes();
    expect(report.fixes[0]?.label).toBe("Turn protocol security back on and use https");
    write(
      "remoteSiteSettings/Geo.remoteSite-meta.xml",
      `${read("remoteSiteSettings/Geo.remoteSite-meta.xml")}\n<!-- edited -->`,
    );
    const r = applyFixes(dir, report.fixes);
    expect(r.applied).toEqual([]);
    expect(r.stale).toEqual([{ id: report.fixes[0]!.id, file: `${SRC}remoteSiteSettings/Geo.remoteSite-meta.xml` }]);
  });

  it("removes a committed consumer secret, with a note to rotate it", () => {
    const app = (secret: string) =>
      `<ConnectedApp ${NS}>\n    <label>App</label>\n    <oauthConfig>\n        <callbackUrl>https://x.example.com/cb</callbackUrl>${secret}\n        <scopes>Api</scopes>\n    </oauthConfig>\n</ConnectedApp>\n`;
    write("connectedApps/App.connectedApp-meta.xml", app(""));
    commit();
    write("connectedApps/App.connectedApp-meta.xml", app("\n        <consumerSecret>s3cr3t</consumerSecret>"));
    const [fix] = fixes().fixes;
    expect(fix?.note).toContain("rotate it");
    applyFixes(dir, [fix!]);
    expect(read("connectedApps/App.connectedApp-meta.xml")).toBe(app(""));
  });

  it("takes back Modify All a permission set newly grants, keeping the rest of the change", () => {
    const ps = (modifyAll: boolean, edit: boolean) =>
      `<PermissionSet ${NS}>\n    <label>Ops</label>\n    <objectPermissions>\n        <allowCreate>true</allowCreate>\n        <allowDelete>false</allowDelete>\n        <allowEdit>${edit}</allowEdit>\n        <allowRead>true</allowRead>\n        <modifyAllRecords>${modifyAll}</modifyAllRecords>\n        <object>Account</object>\n        <viewAllRecords>false</viewAllRecords>\n    </objectPermissions>\n</PermissionSet>\n`;
    write("permissionsets/Ops.permissionset-meta.xml", ps(false, false));
    commit();
    write("permissionsets/Ops.permissionset-meta.xml", ps(true, true));
    const report = fixes();
    const fix = report.fixes.find((f) => f.rule === "permission-escalation");
    expect(fix?.kind).toBe("undo");
    expect(fix?.label).toBe("Take back View All / Modify All on Account");
    applyFixes(dir, [fix!]);
    // Modify All is back to false; the edit access the change added stays.
    expect(read("permissionsets/Ops.permissionset-meta.xml")).toBe(ps(false, true));
  });

  it("takes back a system permission that the base branch didn't grant", () => {
    const ps = (extra: string) => `<PermissionSet ${NS}>\n    <label>Ops</label>${extra}\n</PermissionSet>\n`;
    write("permissionsets/Ops.permissionset-meta.xml", ps(""));
    commit();
    write(
      "permissionsets/Ops.permissionset-meta.xml",
      ps(
        "\n    <userPermissions>\n        <enabled>true</enabled>\n        <name>ModifyAllData</name>\n    </userPermissions>",
      ),
    );
    const fix = fixes().fixes.find((f) => f.rule === "permission-system");
    expect(fix?.label).toBe("Take back ModifyAllData");
    applyFixes(dir, [fix!]);
    expect(read("permissionsets/Ops.permissionset-meta.xml")).toBe(ps(""));
  });

  it("puts a sharing default back", () => {
    const obj = (model: string) =>
      `<CustomObject ${NS}>\n    <label>Invoice</label>\n    <sharingModel>${model}</sharingModel>\n</CustomObject>\n`;
    write("objects/Invoice__c/Invoice__c.object-meta.xml", obj("Private"));
    commit();
    write("objects/Invoice__c/Invoice__c.object-meta.xml", obj("ReadWrite"));
    const fix = fixes().fixes.find((f) => f.rule === "sharing-model-opened");
    expect(fix?.label).toBe("Put the internal sharing default back to Private");
    applyFixes(dir, [fix!]);
    expect(read("objects/Invoice__c/Invoice__c.object-meta.xml")).toBe(obj("Private"));
  });

  it("keeps removed picklist values", () => {
    const value = (name: string) =>
      `            <value>\n                <fullName>${name}</fullName>\n                <default>false</default>\n                <label>${name}</label>\n            </value>\n`;
    const field = (values: string[]) =>
      `<CustomField ${NS}>\n    <fullName>Stage__c</fullName>\n    <label>Stage</label>\n    <type>Picklist</type>\n    <valueSet>\n        <valueSetDefinition>\n            <sorted>false</sorted>\n${values.map(value).join("")}        </valueSetDefinition>\n    </valueSet>\n</CustomField>\n`;
    write("objects/Invoice__c/Invoice__c.object-meta.xml", `<CustomObject ${NS}><label>Invoice</label></CustomObject>`);
    write("objects/Invoice__c/fields/Stage__c.field-meta.xml", field(["Open", "Held", "Closed"]));
    commit();
    write("objects/Invoice__c/fields/Stage__c.field-meta.xml", field(["Open", "Closed"]));
    const fix = fixes().fixes.find((f) => f.rule === "picklist-value-removed");
    expect(fix?.label).toBe("Keep value Held active");
    applyFixes(dir, [fix!]);
    // Back in its place: the order is what users see.
    expect(read("objects/Invoice__c/fields/Stage__c.field-meta.xml")).toBe(field(["Open", "Held", "Closed"]));
    expect(rules()).not.toContain("picklist-value-removed");
    // The first value removed goes back first (the base still has all three).
    write("objects/Invoice__c/fields/Stage__c.field-meta.xml", field(["Held", "Closed"]));
    applyFixes(
      dir,
      fixes().fixes.filter((f) => f.rule === "picklist-value-removed"),
    );
    expect(read("objects/Invoice__c/fields/Stage__c.field-meta.xml")).toBe(field(["Open", "Held", "Closed"]));
  });

  it("updates the old name where a renamed component is still used", () => {
    write(
      "staticresources/Logo.resource-meta.xml",
      `<StaticResource ${NS}><cacheControl>Public</cacheControl><contentType>image/png</contentType></StaticResource>`,
    );
    write("staticresources/Logo.png", "png");
    write("pages/Home.page", `<apex:page><img src="{!$Resource.Logo}"/></apex:page>`);
    write("pages/Home.page-meta.xml", `<ApexPage ${NS}><apiVersion>62.0</apiVersion><label>Home</label></ApexPage>`);
    commit();
    git("mv", `${SRC}staticresources/Logo.resource-meta.xml`, `${SRC}staticresources/Brand.resource-meta.xml`);
    git("mv", `${SRC}staticresources/Logo.png`, `${SRC}staticresources/Brand.png`);
    git("add", "-A");
    const report = fixes();
    const fix = report.fixes.find((f) => f.rule === "renamed-still-named");
    expect(fix?.kind).toBe("review");
    expect(fix?.label).toBe("Use the new name Brand in 1 file(s)");
    applyFixes(dir, [fix!]);
    expect(read("pages/Home.page")).toBe(`<apex:page><img src="{!$Resource.Brand}"/></apex:page>`);
  });

  it("asks for confirmation on an agent action that deletes", () => {
    cpSync(path.resolve("fixtures/sample-org"), dir, { recursive: true });
    commit();
    const cls = `${SRC}classes/OpportunityCloser.cls`;
    const body = readFileSync(path.join(dir, cls), "utf8");
    writeFileSync(
      path.join(dir, cls),
      body.replace(/\}\s*$/, "    public static void purge(List<Opportunity> o) { delete o; }\n}\n"),
    );
    const fix = fixes().fixes.find((f) => f.rule === "agent-action-no-confirmation");
    expect(fix?.label).toBe("Ask the user to confirm before the action runs");
    expect(fix?.diff).toContain("+    <isConfirmationRequired>true</isConfirmationRequired>");
  });

  it("lists findings without a fix, and fixes only the rules asked for", () => {
    write(
      "namedCredentials/Pay.namedCredential-meta.xml",
      `<NamedCredential ${NS}><endpoint>https://a.com</endpoint><label>Pay</label><principalType>NamedUser</principalType><protocol>Password</protocol></NamedCredential>`,
    );
    commit();
    write(
      "namedCredentials/Pay.namedCredential-meta.xml",
      `<NamedCredential ${NS}><endpoint>http://b.com</endpoint><label>Pay</label><principalType>NamedUser</principalType><protocol>Password</protocol></NamedCredential>`,
    );
    const all = fixes();
    expect(all.fixes).toHaveLength(1);
    expect(all.withoutFix).toBeGreaterThan(0); // the endpoint moved host: a decision, not a fix
    expect(
      findFixes({ projectDir: dir, base: "HEAD", config: false }, { rules: ["sharing-model-opened"] }).fixes,
    ).toEqual([]);
  });

  it("does not touch the working tree while proposing", () => {
    write("namedCredentials/Pay.namedCredential-meta.xml", "<NamedCredential/>");
    commit();
    write(
      "namedCredentials/Pay.namedCredential-meta.xml",
      `<NamedCredential ${NS}><endpoint>http://b.com</endpoint><label>Pay</label><principalType>NamedUser</principalType><protocol>Password</protocol></NamedCredential>`,
    );
    const before = read("namedCredentials/Pay.namedCredential-meta.xml");
    fixes();
    expect(read("namedCredentials/Pay.namedCredential-meta.xml")).toBe(before);
    renameSync(path.join(dir, SRC), path.join(dir, "moved")); // nothing else holds the files open
  });
});
