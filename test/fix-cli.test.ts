// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLI = path.resolve("dist/cli.js");
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
const SRC = "force-app/main/default";
const NC = `${SRC}/namedCredentials/Pay.namedCredential-meta.xml`;
const PS = `${SRC}/permissionsets/Support.permissionset-meta.xml`;

const nc = (url: string) =>
  `<NamedCredential ${NS}>\n    <endpoint>${url}</endpoint>\n    <label>Pay</label>\n    <principalType>NamedUser</principalType>\n    <protocol>Password</protocol>\n</NamedCredential>\n`;
const ps = (modifyAll: boolean) =>
  `<PermissionSet ${NS}>\n    <label>Support</label>\n    <objectPermissions>\n        <allowCreate>true</allowCreate>\n        <allowDelete>false</allowDelete>\n        <allowEdit>true</allowEdit>\n        <allowRead>true</allowRead>\n        <modifyAllRecords>${modifyAll}</modifyAllRecords>\n        <object>Account</object>\n        <viewAllRecords>false</viewAllRecords>\n    </objectPermissions>\n</PermissionSet>\n`;

describe("preflight fix", () => {
  let dir: string;
  const write = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  };
  const read = (rel: string) => readFileSync(path.join(dir, rel), "utf8");
  const cli = (...args: string[]) =>
    spawnSync("node", [CLI, "fix", "--base", "HEAD", ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PREFLIGHT_NO_UPDATE_CHECK: "1" },
    });
  const json = (...args: string[]) => JSON.parse(cli("--format", "json", ...args).stdout);

  beforeAll(() => {
    if (!existsSync(CLI)) execFileSync("npm", ["run", "build", "--silent"], { stdio: "ignore" });
  }, 180_000);
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-fix-cli-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    write(NC, nc("https://api.pay.example.com"));
    write(PS, ps(false));
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    write(NC, nc("http://api.pay.example.com"));
    write(PS, ps(true));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the fixes that fit a pull request suggestion", () => {
    const out = path.join(dir, "suggestions.json");
    cli("--format", "json", "--kinds", "safe,undo", "--suggestions-out", out);
    const { suggestions } = JSON.parse(readFileSync(out, "utf8")) as {
      suggestions: { path: string; startLine: number; endLine: number; current: string[]; replacement: string[] }[];
    };
    const https = suggestions.find((x) => x.path === NC)!;
    expect(https).toMatchObject({
      startLine: 2,
      endLine: 2,
      current: ["    <endpoint>http://api.pay.example.com</endpoint>"],
      replacement: ["    <endpoint>https://api.pay.example.com</endpoint>"],
    });
    expect(suggestions.find((x) => x.path === PS)).toMatchObject({
      current: ["        <modifyAllRecords>true</modifyAllRecords>"],
    });
    // Only the kinds asked for.
    cli("--format", "json", "--suggestions-out", out);
    expect((JSON.parse(readFileSync(out, "utf8")).suggestions as unknown[]).length).toBe(1);
  });

  it("shows checked fixes as diffs, without writing anything", () => {
    const r = cli();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("## Preflight fixes: 2 of 2 finding(s)");
    expect(r.stdout).toContain("+    <endpoint>https://api.pay.example.com</endpoint>");
    expect(read(NC)).toBe(nc("http://api.pay.example.com"));
    const report = json();
    expect(report.fixes.map((f: { kind: string }) => f.kind).sort()).toEqual(["safe", "undo"]);
  });

  it("--apply writes only the safe fixes", () => {
    const r = cli("--apply");
    expect(r.stdout).toContain("1 applied");
    expect(read(NC)).toBe(nc("https://api.pay.example.com"));
    expect(read(PS)).toBe(ps(true));
  });

  it("--apply --only writes the fixes named, whatever their kind; --kinds widens the default", () => {
    const undo = json().fixes.find((f: { kind: string }) => f.kind === "undo");
    expect(json("--apply", "--only", undo.id).applied).toEqual([undo.id]);
    expect(read(PS)).toBe(ps(false));
    expect(read(NC)).toBe(nc("http://api.pay.example.com"));
    write(PS, ps(true));
    expect(json("--apply", "--kinds", "safe,undo").applied).toHaveLength(2);
    expect(read(PS)).toBe(ps(false));
    expect(read(NC)).toBe(nc("https://api.pay.example.com"));
    // Nothing left to fix.
    expect(json().fixes).toEqual([]);
  });

  it("refuses unknown kinds and --apply with --head", () => {
    expect(cli("--apply", "--kinds", "everything").stderr).toContain('Unknown fix kind "everything"');
    expect(cli("--apply", "--head", "HEAD").stderr).toContain("can't be used with --head");
    expect(read(NC)).toBe(nc("http://api.pay.example.com"));
  });
});
