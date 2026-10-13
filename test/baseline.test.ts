// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONDITION_RULES } from "../src/core/baseline.js";
import { parseConfig } from "../src/core/config.js";
import {
  analyze,
  analyzeChange,
  applyConfig,
  BASELINE_FILE,
  loadProject,
  wholeProjectChanges,
  writeBaselineFile,
} from "../src/core/index.js";

const FIELD = "force-app/main/default/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml";

describe("baseline", () => {
  let dir: string;
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd: dir, encoding: "utf8" });
  const changeField = () => {
    const f = path.join(dir, FIELD);
    writeFileSync(f, readFileSync(f, "utf8").replace("<type>Date</type>", "<type>DateTime</type>"));
  };
  const rules = (fs: { rule: string; title: string }[]) => fs.map((f) => f.rule);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-baseline-"));
    cpSync(path.resolve("fixtures/sample-org"), dir, { recursive: true });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('"base" hides conditions that were already there, and keeps what the change itself affects', () => {
    changeField();
    const all = analyzeChange({ projectDir: dir, base: "HEAD" }).result;
    const { result } = analyzeChange({ projectDir: dir, base: "HEAD", baseline: "base" });
    expect(rules(all.findings)).toContain("recursion-cycle");
    expect(rules(result.findings)).not.toContain("recursion-cycle");
    expect(rules(result.findings)).toEqual(
      expect.arrayContaining(["agent-action-affected", "field-used-by-validation-rule"]),
    );
    expect(result.baseline).toEqual({ source: "base ref HEAD", hidden: all.findings.length - result.findings.length });
    expect(result.findings.every((f) => !CONDITION_RULES.has(f.rule) || !all.findings.includes(f))).toBe(true);
  });

  it("still reports a condition the change introduces", () => {
    changeField();
    writeFileSync(
      path.join(dir, "force-app/main/default/triggers/TaskTrigger.trigger"),
      "trigger TaskTrigger on Task (after insert) { update new Opportunity(Name = 'x'); }",
    );
    writeFileSync(
      path.join(dir, "force-app/main/default/triggers/TaskTrigger.trigger-meta.xml"),
      '<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexTrigger>',
    );
    const { result } = analyzeChange({ projectDir: dir, base: "HEAD", baseline: "base" });
    const cycles = result.findings.filter((f) => f.rule === "recursion-cycle").map((f) => f.title);
    expect(cycles.some((t) => t.includes("Task"))).toBe(true);
    expect(cycles.some((t) => t === "Automation cycle: Account → Contact → Account")).toBe(false);
  });

  it("records a baseline file of conditions only, and uses it from the policy", () => {
    const model = loadProject(dir, { cache: false });
    const whole = analyze({ model, changes: wholeProjectChanges(dir) });
    const n = writeBaselineFile(path.join(dir, BASELINE_FILE), whole.findings);
    const saved = JSON.parse(readFileSync(path.join(dir, BASELINE_FILE), "utf8"));
    expect(n).toBeGreaterThan(0);
    expect(saved.findings.every((f: { rule: string }) => CONDITION_RULES.has(f.rule))).toBe(true);

    writeFileSync(path.join(dir, ".preflight.json"), JSON.stringify({ baseline: BASELINE_FILE }));
    changeField();
    const { result } = analyzeChange({ projectDir: dir, base: "HEAD" });
    expect(result.baseline?.source).toBe(BASELINE_FILE);
    expect(rules(result.findings)).not.toContain("recursion-cycle");
    expect(analyzeChange({ projectDir: dir, base: "HEAD", baseline: false }).result.baseline).toBeUndefined();
    expect(applyConfig).toBeTypeOf("function");
  });

  it('accepts only "base" or a path inside the project in the policy', () => {
    expect(parseConfig({ baseline: "base" }).baseline).toBe("base");
    expect(() => parseConfig({ baseline: "../outside.json" })).toThrow(/inside the project/);
    expect(() => parseConfig({ baseline: "/etc/x.json" })).toThrow(/inside the project/);
  });
});
