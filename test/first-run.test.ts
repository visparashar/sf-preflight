// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { analyzeChange, defaultBaseRef, findProjectRoot, projectsBelow } from "../src/core/index.js";

const CLI = path.resolve("dist/cli.js");
const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';
const OBJ = "force-app/main/default/objects/Account";
const FIELD_A = `${OBJ}/fields/Tier__c.field-meta.xml`;
const FIELD_B = `${OBJ}/fields/Region__c.field-meta.xml`;
const field = (name: string, label: string) =>
  `<CustomField ${NS}>\n    <fullName>${name}</fullName>\n    <label>${label}</label>\n    <type>Text</type>\n    <length>40</length>\n</CustomField>\n`;

let dir: string;
const write = (rel: string, body: string, root = dir) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), body);
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const changed = (r: { changes: { component: { name: string } }[] }) => r.changes.map((c) => c.component.name).sort();

/** An SFDX project in git on `main` with two fields. */
function sfdxRepo(root: string, branch = "main"): void {
  writeFileSync(path.join(root, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
  write(FIELD_A, field("Tier__c", "Tier"), root);
  write(FIELD_B, field("Region__c", "Region"), root);
  git(root, "init", "-q", "-b", branch);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
}

beforeAll(() => {
  if (!existsSync(CLI)) execFileSync("npm", ["run", "build", "--silent"], { stdio: "ignore" });
}, 180_000);
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "preflight-first-run-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the base branch", () => {
  it("defaults to the remote's default branch, then main/master", () => {
    const upstream = path.join(dir, "upstream");
    mkdirSync(upstream);
    sfdxRepo(upstream, "trunk");
    expect(defaultBaseRef(upstream)).toBeUndefined(); // no origin, no main or master
    git(upstream, "branch", "master");
    expect(defaultBaseRef(upstream)).toBe("master");

    const clone = path.join(dir, "clone");
    git(dir, "clone", "-q", upstream, clone);
    expect(defaultBaseRef(clone)).toBe("origin/trunk"); // origin/HEAD wins over origin/master
  });

  it("is used when no --base, --files or --staged is given", () => {
    sfdxRepo(dir);
    write(FIELD_A, field("Tier__c", "Customer tier"));
    const { result } = analyzeChange({ projectDir: dir });
    expect(result.base).toBe("main");
    expect(changed(result)).toEqual(["Account.Tier__c"]);
  });

  it("leaves out commits added to the base branch after this branch left it", () => {
    sfdxRepo(dir);
    git(dir, "checkout", "-q", "-b", "feature");
    write(FIELD_A, field("Tier__c", "Customer tier"));
    git(dir, "commit", "-q", "-am", "feature change");
    git(dir, "checkout", "-q", "main");
    write(FIELD_B, field("Region__c", "Sales region"));
    git(dir, "commit", "-q", "-am", "someone else's change on main");
    git(dir, "checkout", "-q", "feature");

    expect(changed(analyzeChange({ projectDir: dir, base: "main" }).result)).toEqual(["Account.Tier__c"]);
    expect(changed(analyzeChange({ projectDir: dir, base: "main", head: "HEAD" }).result)).toEqual(["Account.Tier__c"]);
  });

  it("names the branches to use when the ref doesn't exist", () => {
    sfdxRepo(dir, "master");
    git(dir, "branch", "develop");
    expect(() => analyzeChange({ projectDir: dir, base: "origin/main" })).toThrow(
      /Can't find the git base ref "origin\/main"[\s\S]*Branches you could compare with: master, develop/,
    );
  });

  it("points to --files outside git", () => {
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    write(FIELD_A, field("Tier__c", "Tier"));
    expect(() => analyzeChange({ projectDir: dir })).toThrow(/not inside a git repository[\s\S]*--files/);
    expect(changed(analyzeChange({ projectDir: dir, files: [path.join(dir, FIELD_A)] }).result)).toEqual([
      "Account.Tier__c",
    ]);
  });
});

describe("no silent all-clear", () => {
  it("fails when none of the --files exist, and warns about the ones that don't", () => {
    sfdxRepo(dir);
    expect(() => analyzeChange({ projectDir: dir, files: [path.join(dir, "force-app/Nope.field-meta.xml")] })).toThrow(
      /File not found/,
    );
    const { result } = analyzeChange({
      projectDir: dir,
      files: [path.join(dir, FIELD_A), path.join(dir, "force-app/Nope.field-meta.xml")],
    });
    expect(changed(result)).toEqual(["Account.Tier__c"]);
    expect(result.warnings.join("\n")).toMatch(/Skipped files that don't exist: .*Nope\.field-meta\.xml/);
  });

  it("warns when the folder has no sfdx-project.json", () => {
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(path.join(dir, "notes.txt"), "a");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    const { result } = analyzeChange({ projectDir: dir, base: "HEAD" });
    expect(result.warnings[0]).toMatch(/No sfdx-project\.json/);
  });
});

describe("the project folder", () => {
  it("is found from a subfolder, no higher than the git root", () => {
    sfdxRepo(dir);
    expect(findProjectRoot(path.join(dir, OBJ, "fields"), dir)).toBe(dir);
    expect(findProjectRoot(path.join(dir, OBJ), path.join(dir, OBJ))).toBeUndefined();
  });

  it("lists projects below a monorepo root", () => {
    for (const p of ["apps/sales", "apps/service"]) {
      mkdirSync(path.join(dir, p), { recursive: true });
      writeFileSync(path.join(dir, p, "sfdx-project.json"), "{}");
    }
    expect(projectsBelow(dir).map((d) => path.relative(dir, d).split(path.sep).join("/"))).toEqual([
      "apps/sales",
      "apps/service",
    ]);
  });
});

describe("the CLI on first run", () => {
  const cli = (cwd: string, ...args: string[]) =>
    spawnSync("node", [CLI, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PREFLIGHT_NO_UPDATE_CHECK: "1" },
    });

  it("analyzes with no options, from any folder in the project", () => {
    sfdxRepo(dir);
    write(FIELD_A, field("Tier__c", "Customer tier"));
    const r = cli(path.join(dir, OBJ, "fields"), "analyze", "--format", "json");
    expect(r.status).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.base).toBe("main");
    expect(changed(result)).toEqual(["Account.Tier__c"]);
  });

  it("uses the only project in a folder below", () => {
    const project = path.join(dir, "salesforce");
    mkdirSync(project);
    sfdxRepo(project);
    write(FIELD_A, field("Tier__c", "Customer tier"), project);
    const r = cli(dir, "analyze", "--format", "json");
    expect(r.status).toBe(0);
    expect(changed(JSON.parse(r.stdout))).toEqual(["Account.Tier__c"]);
  });

  it("shows where to start in --help", () => {
    const out = cli(dir, "--help").stdout;
    expect(out).toMatch(/Check a change:[\s\S]*analyze/);
    expect(out).toMatch(/Get started/);
  });
});
