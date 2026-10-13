// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOOK_MARKER, hookScript, installHook, uninstallHook } from "../src/core/hook.js";
import { analyzeChange } from "../src/core/index.js";

const CLI = path.resolve("dist/cli.js");
const FIELD = "force-app/main/default/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml";

describe("pre-commit hook", () => {
  let dir: string;
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd: dir, encoding: "utf8" });

  beforeAll(() => {
    if (!existsSync(CLI)) execFileSync("npm", ["run", "build", "--silent"], { stdio: "ignore" });
  }, 180_000);
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-hook-"));
    cpSync(path.resolve("fixtures/sample-org"), dir, { recursive: true });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const change = () => {
    const f = path.join(dir, FIELD);
    writeFileSync(f, readFileSync(f, "utf8").replace("<type>Date</type>", "<type>DateTime</type>"));
  };

  it("analyzes only what is staged, against HEAD", () => {
    change();
    expect(analyzeChange({ projectDir: dir, staged: true }).result.changes).toEqual([]);
    git("add", FIELD);
    const { result } = analyzeChange({ projectDir: dir, staged: true });
    expect(result.changes.map((c) => c.component.name)).toEqual(["Opportunity.Contract_Signed_Date__c"]);
    expect(result.summary.risk).toBe("high");
    // Edited again after staging: still checked, with a note.
    writeFileSync(path.join(dir, FIELD), `${readFileSync(path.join(dir, FIELD), "utf8")}\n`);
    expect(analyzeChange({ projectDir: dir, staged: true }).result.warnings.join()).toContain("unstaged edits");
  });

  it("installs an executable hook, updates and uninstalls it", () => {
    const r = installHook(dir, { version: "9.9.9" });
    expect(r.status).toBe("installed");
    const fd = openSync(r.file, "r");
    expect(fstatSync(fd).mode & 0o111).not.toBe(0);
    expect(readFileSync(fd, "utf8")).toContain(HOOK_MARKER);
    closeSync(fd);
    expect(installHook(dir, { version: "9.9.9" }).status).toBe("updated");
    expect(uninstallHook(dir).removed).toBe(true);
  });

  it("leaves someone else's hook alone", () => {
    const theirs = path.join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(theirs, "#!/bin/sh\necho mine\n");
    expect(installHook(dir, { version: "9.9.9" }).status).toBe("exists-other");
    expect(uninstallHook(dir).removed).toBe(false);
    expect(readFileSync(theirs, "utf8")).toContain("echo mine");
  });

  it("quotes the project path in the script", () => {
    expect(hookScript("sub dir/it's", "1.0.0")).toContain(`-p 'sub dir/it'\\''s'`);
  });

  it("blocks a risky commit, allows it below the threshold, and stays quiet without metadata", () => {
    installHook(dir, { version: "9.9.9" });
    const env = { ...process.env, PREFLIGHT_BIN: `${process.execPath} ${CLI}` };
    const commit = (msg: string) =>
      spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", msg], {
        cwd: dir,
        env,
        encoding: "utf8",
      });

    writeFileSync(path.join(dir, "notes.txt"), "hi");
    git("add", "notes.txt");
    const quiet = commit("notes");
    expect(quiet.status).toBe(0);
    expect(quiet.stderr).toBe("");

    change();
    git("add", FIELD);
    const blocked = commit("risky");
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain("sf-preflight: HIGH risk in 1 staged component");
    expect(blocked.stderr).toContain("Commit blocked");
    expect(git("diff", "--cached", "--name-only")).toContain("Contract_Signed_Date__c");

    installHook(dir, { version: "9.9.9", failOn: "none" });
    const allowed = commit("risky but allowed");
    expect(allowed.status).toBe(0);
    expect(allowed.stderr).toContain("HIGH risk");
  });
});
