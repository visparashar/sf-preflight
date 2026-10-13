// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { editedFiles, installAgentHook, projectOf, runAgentHook } from "../src/core/agentHook.js";

const CLI = path.resolve("dist/cli.js");
const CLS = "force-app/main/default/classes/ContactTriggerHandler.cls";

describe("agent hook", () => {
  let dir: string;
  beforeAll(() => {
    if (!existsSync(CLI)) execFileSync("npm", ["run", "build", "--silent"], { stdio: "ignore" });
  }, 180_000);
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-agent-hook-"));
    cpSync(path.resolve("fixtures/sample-org"), dir, { recursive: true });
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd: dir, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const edit = (fn: (s: string) => string) => {
    const f = path.join(dir, CLS);
    writeFileSync(f, fn(readFileSync(f, "utf8")));
    return f;
  };
  const addLoop = (s: string) =>
    s.replace(
      "public with sharing class ContactTriggerHandler {",
      "public with sharing class ContactTriggerHandler {\n    public static void touch(List<Account> xs) { for (Account a : xs) { update a; } }",
    );

  it("reads the edited file from a Claude Code tool call", () => {
    expect(editedFiles({ tool_name: "Edit", tool_input: { file_path: "/x/a.cls", old_string: "a" } })).toEqual([
      "/x/a.cls",
    ]);
    expect(editedFiles({ tool_name: "Bash", tool_input: { command: "ls" } })).toEqual([]);
    expect(editedFiles("nonsense")).toEqual([]);
    expect(projectOf(path.join(dir, CLS))).toBe(dir);
  });

  it("tells the agent about a problem its edit introduces", () => {
    const f = edit(addLoop);
    const { output } = runAgentHook([f]);
    expect(output?.decision).toBe("block");
    expect(output?.reason).toContain("dml-in-loop");
    expect(output?.reason).toContain("this edit introduces");
  });

  it("stays quiet for an edit that adds nothing, and for files that aren't metadata", () => {
    const f = edit((s) => `${s}\n// a comment\n`);
    expect(runAgentHook([f]).output).toBeUndefined();
    writeFileSync(path.join(dir, "notes.md"), "hi");
    expect(runAgentHook([path.join(dir, "notes.md")])).toEqual({});
  });

  it("answers Claude Code's hook JSON on stdin, and never fails the agent's turn", () => {
    const f = edit(addLoop);
    const run = (input: string) => spawnSync(process.execPath, [CLI, "agent-hook"], { input, encoding: "utf8" });
    const ok = run(
      JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Edit", cwd: dir, tool_input: { file_path: f } }),
    );
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).decision).toBe("block");
    const bad = run("{not json");
    expect(bad.status).toBe(0);
    expect(bad.stdout).toBe("");
  });

  it("installs into .claude/settings.json once, keeping what is there", () => {
    mkdirSync(path.join(dir, ".claude"));
    writeFileSync(
      path.join(dir, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(ls)"] },
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo" }] }] },
      }),
    );
    expect(installAgentHook(dir, "npx --yes sf-preflight@1.0.0 agent-hook").status).toBe("installed");
    expect(installAgentHook(dir, "npx --yes sf-preflight@1.0.0 agent-hook").status).toBe("present");
    const s = JSON.parse(readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
    expect(s.permissions.allow).toEqual(["Bash(ls)"]);
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.PostToolUse).toEqual([
      {
        matcher: "Write|Edit|MultiEdit",
        hooks: [{ type: "command", command: "npx --yes sf-preflight@1.0.0 agent-hook", timeout: 120 }],
      },
    ]);
  });
});
