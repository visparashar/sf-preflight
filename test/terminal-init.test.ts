// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { analyzeChange, initProject, loadPolicy, toTerminal } from "../src/core/index.js";
import { remoteHost } from "../src/core/init.js";

const CLI = path.resolve("dist/cli.js");
const SAMPLE = path.resolve("fixtures/sample-org");
const FIELD = "force-app/main/default/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml";

let dir: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const cli = (cwd: string, ...args: string[]) =>
  spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, PREFLIGHT_NO_UPDATE_CHECK: "1" } });

/** The sample org in git, optionally inside a subfolder, with a GitHub remote when asked. */
function sampleRepo(opts: { sub?: string; github?: boolean } = {}): string {
  const project = opts.sub ? path.join(dir, opts.sub) : dir;
  execFileSync("cp", ["-r", `${SAMPLE}/.`, project]);
  git(dir, "init", "-q", "-b", "main");
  if (opts.github) git(dir, "remote", "add", "origin", "https://github.com/acme/crm.git");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return project;
}

beforeAll(() => {
  if (!existsSync(CLI)) execFileSync("npm", ["run", "build", "--silent"], { stdio: "ignore" });
}, 180_000);
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "preflight-terminal-init-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("terminal report", () => {
  it("leads with the risk, explains high findings and says what to run next", () => {
    const { result } = analyzeChange({ projectDir: SAMPLE, files: [path.join(SAMPLE, FIELD)] });
    const text = toTerminal(result, { width: 90, nextArgs: "--base develop" });
    const lines = text.split("\n");
    expect(lines[0]).toBe("sf-preflight  HIGH risk");
    expect(text.includes("\x1b[")).toBe(false); // no colors unless asked
    expect(text).not.toMatch(/<details>|\| ---|\*\*/); // no Markdown
    expect(lines.every((l) => l.length <= 90 || l.includes("/"))).toBe(true); // only paths may run long

    // A high finding has its explanation; a medium one only its title and file.
    const high = lines.findIndex((l) => l.includes("Automation cycle: Opportunity → Opportunity"));
    expect(lines[high + 1]).toMatch(/^ {10}Opportunity \(update\)/);
    expect(text).not.toMatch(/re-runs the whole save procedure/); // a medium finding's detail
    const medium = lines.findIndex((l) => /^ {2}MEDIUM\s+After-save flow/.test(l));
    const file = lines.slice(medium + 1).find((l) => l.includes("force-app/"));
    expect(file).toMatch(/^ {10}force-app\/.*Opportunity_Closed_Won_Followup\.flow-meta\.xml$/);

    expect(text).toMatch(/Cascade[\s\S]*⟲ cycle/);
    expect(text).toMatch(/preflight fix --base develop/);
    expect(text).toMatch(/preflight analyze --base develop --format md/);
  });

  it("puts warnings first and colors on request", () => {
    const { result } = analyzeChange({
      projectDir: SAMPLE,
      files: [path.join(SAMPLE, FIELD), path.join(SAMPLE, "force-app/Nope.xml")],
    });
    const text = toTerminal(result);
    expect(text.indexOf("Warnings")).toBeLessThan(text.indexOf("Findings"));
    expect(text).toMatch(/! Skipped files that don't exist/);
    expect(toTerminal(result, { color: true }).includes("\x1b[31m")).toBe(true);
  });

  it("is what analyze prints on a terminal; pipes and --out keep Markdown", () => {
    sampleRepo();
    writeFileSync(path.join(dir, FIELD), readFileSync(path.join(dir, FIELD), "utf8").replace("</label>", " X</label>"));
    expect(cli(dir, "analyze").stdout).toMatch(/^## Preflight: 🔴 HIGH risk/);
    expect(cli(dir, "analyze", "--format", "text").stdout).toMatch(/^sf-preflight {2}HIGH risk/);
  });
});

describe("preflight init", () => {
  it("writes a policy the analyzer accepts and the workflow for the project's folder", () => {
    const project = sampleRepo({ sub: "salesforce", github: true });
    const r = initProject({ projectDir: project });
    expect(r.baseBranch).toBe("main");
    expect(r.files.map((f) => [f.file, f.status])).toEqual([
      [".preflight.json", "created"],
      ["../.github/workflows/preflight.yml", "created"],
    ]);
    const policy = loadPolicy(project);
    expect(policy.warning).toBeUndefined();
    expect(policy.config).toMatchObject({ baseline: "base", gate: { failOn: "high" } });
    const workflow = readFileSync(path.join(dir, ".github/workflows/preflight.yml"), "utf8");
    expect(workflow).toMatch(/fetch-depth: 0/);
    expect(workflow).toMatch(/uses: visparashar\/sf-preflight@v0\n {8}with:\n {10}project: salesforce\n/);
    expect(workflow).toMatch(/branches: \[main\]/);
  });

  it("leaves existing files alone, and writes nothing on a dry run", () => {
    sampleRepo({ github: true });
    writeFileSync(path.join(dir, ".preflight.json"), '{ "gate": { "failOn": "medium" } }\n');
    const dry = initProject({ projectDir: dir, dryRun: true });
    expect(dry.files.map((f) => f.status)).toEqual(["exists", "would create"]);
    expect(existsSync(path.join(dir, ".github/workflows/preflight.yml"))).toBe(false);
    initProject({ projectDir: dir });
    expect(readFileSync(path.join(dir, ".preflight.json"), "utf8")).toMatch(/medium/);
    initProject({ projectDir: dir, force: true });
    expect(readFileSync(path.join(dir, ".preflight.json"), "utf8")).toMatch(/"baseline": "base"/);
  });

  it("recognizes GitHub remotes by their host only", () => {
    expect(remoteHost("https://github.com/acme/crm.git")).toBe("github.com");
    expect(remoteHost("git@github.com:acme/crm.git")).toBe("github.com");
    expect(remoteHost("ssh://git@github.com/acme/crm.git")).toBe("github.com");
    expect(remoteHost("https://evil.example/github.com/acme/crm.git")).toBe("evil.example");
    expect(remoteHost("https://github.com.evil.example/acme/crm.git")).toBe("github.com.evil.example");
    expect(remoteHost("/srv/git/crm.git")).toBeUndefined();
  });

  it("skips the workflow outside GitHub unless asked", () => {
    sampleRepo();
    expect(initProject({ projectDir: dir, dryRun: true }).workflowSkipped).toMatch(/isn't on GitHub/);
    expect(initProject({ projectDir: dir, dryRun: true, workflow: true }).files.map((f) => f.file)).toContain(
      ".github/workflows/preflight.yml",
    );
  });

  it("installs the pre-commit hook with --hook, from the repository root", () => {
    sampleRepo({ sub: "salesforce", github: true });
    mkdirSync(path.join(dir, "docs"));
    const r = cli(dir, "init", "--hook");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/created\s+salesforce\/\.preflight\.json/);
    expect(r.stdout).toMatch(/installed\s+\.git\/hooks\/pre-commit/);
    expect(readFileSync(path.join(dir, ".git/hooks/pre-commit"), "utf8")).toMatch(/hook run/);
  });
});
