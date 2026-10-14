// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeChange } from "../src/core/index.js";

const SRC = "force-app/main/default/classes/";
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

describe("ignored-save-result", () => {
  let dir: string;
  const write = (name: string, body: string) => {
    mkdirSync(path.join(dir, SRC), { recursive: true });
    writeFileSync(path.join(dir, SRC, `${name}.cls`), body);
    writeFileSync(
      path.join(dir, SRC, `${name}.cls-meta.xml`),
      `<ApexClass ${NS}><apiVersion>60.0</apiVersion><status>Active</status></ApexClass>`,
    );
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "pipe" });
  const findings = () =>
    analyzeChange({ projectDir: dir, base: "HEAD", config: false }).result.findings.filter(
      (f) => f.rule === "ignored-save-result",
    );

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-ignored-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    git("init", "-q", "-b", "main");
    write("Syncer", "public class Syncer { public static void go(List<Account> a) { update a; } }");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports a changed class that throws away a partial-success result", () => {
    write(
      "Syncer",
      "public class Syncer {\n  public static void go(List<Account> a) {\n    Database.update(a, false);\n  }\n}\n",
    );
    const [f] = findings();
    expect(f).toMatchObject({ severity: "medium", line: 3 });
    expect(f?.title).toBe("1 partial-success save(s) in Syncer ignore failed records (changed)");
    expect(f?.detail).toContain("line 3 update result thrown away: Database.update(a, false);");
  });

  it("is quiet when the result is read, when the save stops on failure, and in test classes", () => {
    write(
      "Syncer",
      "public class Syncer { public static void go(List<Account> a) { for (Database.SaveResult r : Database.update(a, false)) { if (!r.isSuccess()) { System.debug(r.getErrors()); } } Database.update(a); } }",
    );
    write(
      "SyncerTest",
      "@isTest private class SyncerTest { @isTest static void t() { Database.insert(new List<Account>(), false); } }",
    );
    expect(findings()).toEqual([]);
  });
});
