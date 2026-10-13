// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AnalysisResult,
  applyConfig,
  buildEvidence,
  canonicalJson,
  evaluateGate,
  evidenceToMarkdown,
  gateToMarkdown,
  globMatch,
  loadConfig,
  loadPolicy,
  parseApprovals,
  parseConfig,
  run,
  toJunit,
  toMarkdown,
  type ValidationResult,
  verifyEvidence,
} from "../src/core/index.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/sample-org");
const SRC = "force-app/main/default";
const VR = `${SRC}/objects/Opportunity/validationRules/Require_Contract_Signed_Date.validationRule-meta.xml`;
const FIELD = `${SRC}/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml`;

const fieldResult = () => run({ projectDir: FIXTURE, files: [path.join(FIXTURE, FIELD)], config: false });

describe("config file", () => {
  it("accepts rule overrides, ignores and gate settings", () => {
    expect(
      parseConfig({
        $schema: "x",
        rules: { "legacy-workflow": "off", "dml-or-soql-in-loop": "high" },
        ignore: { paths: ["force-app/**/Legacy*.cls"] },
        gate: { failOn: "medium", aiAssistedApprovals: 2, requireAgentTests: true, requireTestsPassed: false },
      }),
    ).toEqual({
      rules: { "legacy-workflow": "off", "dml-or-soql-in-loop": "high" },
      ignore: { paths: ["force-app/**/Legacy*.cls"] },
      gate: { failOn: "medium", aiAssistedApprovals: 2, requireAgentTests: true, requireTestsPassed: false },
    });
  });

  it("rejects typos and bad values with the setting's name", () => {
    expect(() => parseConfig({ gates: {} }, "p.json")).toThrow('p.json: unknown setting "gates"');
    expect(() => parseConfig({ gate: { failon: "high" } })).toThrow('unknown setting "gate.failon"');
    expect(() => parseConfig({ rules: { "no-such-rule": "off" } })).toThrow('unknown rule "no-such-rule"');
    expect(() => parseConfig({ rules: { "legacy-workflow": "critical" } })).toThrow("must be one of high");
    expect(() => parseConfig({ gate: { failOn: "info" } })).toThrow('"gate.failOn" must be one of none');
    expect(() => parseConfig({ gate: { aiAssistedApprovals: 1.5 } })).toThrow("whole number");
    expect(() => parseConfig({ ignore: { paths: "x" } })).toThrow("list of glob patterns");
    expect(() => parseConfig([])).toThrow("expected a JSON object");
    expect(parseConfig({ gate: { requireAgentTestsPassed: true } }).gate).toEqual({ requireAgentTestsPassed: true });
    expect(() => parseConfig({ gate: { requireAgentTestsPassed: "yes" } })).toThrow("requireAgentTestsPassed");
  });

  it("keeps the published JSON schema in line with the parser", () => {
    const schema = JSON.parse(readFileSync(path.resolve(__dirname, "../schema/preflight.schema.json"), "utf8"));
    expect(Object.keys(schema.properties).sort()).toEqual(["$schema", "baseline", "gate", "ignore", "rules"]);
    const gateKeys = Object.keys(schema.properties.gate.properties);
    expect(gateKeys.sort()).toEqual([
      "aiAssistedApprovals",
      "failOn",
      "requireAgentTests",
      "requireAgentTestsPassed",
      "requireTestsPassed",
    ]);
    expect(schema.properties.gate.properties.failOn.enum).toEqual(["none", "low", "medium", "high"]);
    expect(schema.properties.rules.additionalProperties.enum).toEqual(["high", "medium", "low", "info", "off"]);
  });

  it("matches globs", () => {
    expect(globMatch("force-app/**/*.cls", "force-app/main/default/classes/A.cls")).toBe(true);
    expect(globMatch("force-app/**/*.cls", "force-app/A.cls")).toBe(true);
    expect(globMatch("force-app/*/A.cls", "force-app/main/default/A.cls")).toBe(false);
    expect(globMatch("**/Legacy?.cls", "x/y/Legacy1.cls")).toBe(true);
    expect(globMatch("./a/b.xml", "a/b.xml")).toBe(true);
    expect(globMatch("a/*", "a/b/c")).toBe(false);
    // Long inputs stay fast.
    const started = Date.now();
    globMatch("**/**/**/**/*x", `${"a/".repeat(200)}b`);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("turns rules off, changes severities and ignores paths", () => {
    const result = fieldResult();
    expect(result.findings.some((f) => f.rule === "recursion-cycle")).toBe(true);
    const configured = applyConfig(result, {
      rules: { "recursion-cycle": "off", "after-save-self-update": "high" },
      ignore: { paths: [`${SRC}/classes/**`] },
    });
    expect(configured.findings.some((f) => f.rule === "recursion-cycle")).toBe(false);
    expect(configured.findings.find((f) => f.rule === "after-save-self-update")!.severity).toBe("high");
    expect(
      configured.findings.some((f) => f.files.length && f.files.every((x) => x.startsWith(`${SRC}/classes/`))),
    ).toBe(false);
    expect(configured.summary.findingsBySeverity.high).toBe(
      configured.findings.filter((f) => f.severity === "high").length,
    );
  });
});

describe("config discovery", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sf-preflight-m6-config-"));
    cpSync(FIXTURE, path.join(dir, "sfdx"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(path.join(dir, ".preflight.json"), JSON.stringify({ rules: { "recursion-cycle": "off" } }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds .preflight.json in the project, then the git root, and applies it in run()", () => {
    const project = path.join(dir, "sfdx");
    expect(loadConfig(project).file).toBe(path.join(dir, ".preflight.json"));
    const result = run({ projectDir: project, files: [path.join(project, FIELD)] });
    expect(result.config).toMatchObject({ file: "../.preflight.json", ref: undefined });
    expect(result.config!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.findings.some((f) => f.rule === "recursion-cycle")).toBe(false);
    expect(toMarkdown(result)).toContain("_Policy: `../.preflight.json`_");
    const ignored = run({ projectDir: project, files: [path.join(project, FIELD)], config: false });
    expect(ignored.config).toBeUndefined();
    expect(ignored.findings.some((f) => f.rule === "recursion-cycle")).toBe(true);
    writeFileSync(path.join(project, ".preflight.json"), JSON.stringify({ gate: { failOn: "low" } }));
    expect(loadConfig(project).config).toEqual({ gate: { failOn: "low" } });
    expect(() => loadConfig(project, path.join(dir, "missing.json"))).toThrow("Config file not found");
    writeFileSync(path.join(project, ".preflight.json"), "{ nope");
    expect(() => loadConfig(project)).toThrow("invalid JSON");
  });
});

const validation = (status: "passed" | "failed"): ValidationResult => ({
  org: "dev",
  orgKind: "developer",
  status,
  tests: [
    { method: "a", outcome: "pass" },
    { method: "b", outcome: status === "passed" ? "pass" : "fail", message: "boom" },
  ],
  componentErrors: [],
  coverageWarnings: [],
});

describe("quality gate", () => {
  const withAi = (r: AnalysisResult, ai: number): AnalysisResult => ({
    ...r,
    provenance: { range: "a..b", commits: 2, aiAssistedCommits: ai, tools: ai ? ["Claude"] : [], details: [] },
  });

  it("fails on findings at or above the threshold", () => {
    const r = fieldResult();
    const gate = evaluateGate({ result: r });
    expect(gate.status).toBe("fail");
    expect(gate.failOn).toBe("high");
    expect(gate.checks[0]!.detail).toMatch(/^\d+ high: Automation cycle/);
    expect(evaluateGate({ result: r, config: { failOn: "none" } }).status).toBe("pass");
  });

  it("requires approvals for AI-assisted changes", () => {
    const r = withAi(fieldResult(), 1);
    const config = { failOn: "none" as const, aiAssistedApprovals: 2 };
    const unknown = evaluateGate({ result: r, config });
    expect(unknown.checks[1]).toMatchObject({ id: "ai-approvals", status: "fail" });
    expect(unknown.checks[1]!.detail).toContain("no approval data was provided");
    const one = evaluateGate({ result: r, config, approvals: [{ reviewer: "alice" }, { reviewer: "alice" }] });
    expect(one.checks[1]).toMatchObject({ status: "fail", detail: "1 AI-assisted commit(s); 1 approval(s) (alice)." });
    const two = evaluateGate({ result: r, config, approvals: parseApprovals(["alice", { reviewer: "bob" }]) });
    expect(two.status).toBe("pass");
    expect(evaluateGate({ result: withAi(fieldResult(), 0), config }).checks[1]!.detail).toBe(
      "No AI-assisted commits.",
    );
    expect(evaluateGate({ result: fieldResult(), config }).checks[1]!.detail).toBe("No commit range was analyzed.");
  });

  it("requires Testing Center coverage for affected agent actions", () => {
    const gate = evaluateGate({ result: fieldResult(), config: { failOn: "none", requireAgentTests: true } });
    expect(gate.checks[1]).toMatchObject({
      id: "agent-tests",
      status: "fail",
      detail: "Not covered: Sales Agent › Close Opportunity.",
    });
  });

  it("requires the generated tests to have passed", () => {
    const config = { failOn: "none" as const, requireTestsPassed: true };
    const r = fieldResult();
    expect(evaluateGate({ result: r, config }).checks[1]!.detail).toContain("weren't run");
    expect(evaluateGate({ result: r, config, validation: validation("failed") }).checks[1]).toMatchObject({
      status: "fail",
      detail: "1 of 2 passed in dev.",
    });
    expect(evaluateGate({ result: r, config, validation: validation("passed") }).status).toBe("pass");
  });

  it("renders a table and validates approval files", () => {
    const md = gateToMarkdown(evaluateGate({ result: fieldResult() }));
    expect(md).toContain("### Quality gate: ❌ failed");
    expect(md).toContain("| No findings at or above high | ❌ fail |");
    expect(() => parseApprovals({})).toThrow("expected a JSON array");
    expect(() => parseApprovals([42], "a.json")).toThrow("a.json: entry 1 must be a reviewer name");
  });
});

describe("evidence pack", () => {
  let repo: string;
  let project: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Dev", "-c", "user.email=dev@example.com", ...args], {
      cwd: repo,
      stdio: "pipe",
    })
      .toString()
      .trim();
  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sf-preflight-m6-evidence-"));
    project = path.join(repo, "sfdx");
    cpSync(FIXTURE, project, { recursive: true });
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "https://someone:ghp_secret@github.com/acme/sf-app.git");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const vr = path.join(project, VR);
    writeFileSync(vr, readFileSync(vr, "utf8").replace("Closed Won", "Closed  Won"));
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Jane Doe",
        "-c",
        "user.email=jane@example.com",
        "commit",
        "-q",
        "-am",
        "Tighten rule\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      ],
      { cwd: repo },
    );
    writeFileSync(path.join(repo, ".preflight.json"), JSON.stringify({ gate: { aiAssistedApprovals: 1 } }));
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const make = () => {
    const result = run({ projectDir: project, base: "HEAD~1", head: "HEAD" });
    const { config } = loadConfig(project);
    const approvals = parseApprovals([{ reviewer: "alice", submittedAt: "2026-10-06T10:00:00Z" }]);
    const gate = evaluateGate({ result, config: config.gate, approvals, validation: validation("passed") });
    return buildEvidence({
      result,
      gate,
      version: "9.9.9",
      approvals,
      tests: { tests: [{ method: "a", kind: "bulk", title: "A" }], validation: validation("passed") },
    });
  };

  it("records what changed, who wrote it, findings, tests, approvals and the gate", () => {
    const e = make();
    expect(e).toMatchObject({
      evidenceVersion: 1,
      predicateType: "https://github.com/visparashar/sf-preflight/evidence/v1",
      tool: { name: "sf-preflight", version: "9.9.9" },
      repository: { url: "https://github.com/acme/sf-app.git", projectPath: "sfdx" },
      change: {
        base: { ref: "HEAD~1", sha: git("rev-parse", "HEAD~1") },
        head: { ref: "HEAD", sha: git("rev-parse", "HEAD") },
        authorship: { commits: 1, aiAssistedCommits: 1, tools: ["Claude"] },
      },
      approvals: [{ reviewer: "alice", submittedAt: "2026-10-06T10:00:00Z" }],
      tests: {
        generated: [{ method: "a", kind: "bulk", title: "A" }],
        validation: { org: "dev", passed: 2, failed: 0 },
      },
      config: { file: ".preflight.json" },
    });
    expect(e.change.authorship!.details[0]).toMatchObject({ author: "Jane Doe", subject: "Tighten rule" });
    const [component] = e.change.components;
    expect(component).toMatchObject({ changeType: "modified", type: "ValidationRule", file: VR });
    expect(component!.sha256).toBe(
      createHash("sha256")
        .update(readFileSync(path.join(project, VR)))
        .digest("hex"),
    );
    expect(e.gate.checks.map((c) => `${c.id}:${c.status}`)).toEqual(["findings:fail", "ai-approvals:pass"]);
    const text = JSON.stringify(e);
    expect(text).not.toContain("ghp_secret");
    expect(text).not.toContain("jane@example.com");
  });

  it("carries a digest that detects any change", () => {
    const e = make();
    expect(verifyEvidence(e)).toBe(true);
    expect(verifyEvidence({ ...e, analysis: { ...e.analysis, risk: "low" } })).toBe(false);
    expect(verifyEvidence(JSON.parse(JSON.stringify(e)))).toBe(true);
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"e":0,"f":1}]},"b":1}',
    );
  });

  it("summarizes the evidence", () => {
    const md = evidenceToMarkdown(make());
    expect(md).toContain("## Change evidence");
    expect(md).toMatch(/\| Change \| `HEAD~1` \([0-9a-f]{7}\) → `HEAD` \([0-9a-f]{7}\) \|/);
    expect(md).toContain("| Authorship | 1 commit(s), 1 AI-assisted (Claude) |");
    expect(md).toContain("| Tests | 1 generated; 2 passed, 0 failed in dev |");
    expect(md).toContain("| Approvals | alice |");
    expect(md).toContain("| Policy | `.preflight.json` |");
  });

  it("hashes file bytes from git and notes shallow clones", () => {
    expect(make().change.authorship!.complete).toBe(true);
    // A Latin-1 file (not valid UTF-8): the digest must match its bytes, not a decoded copy.
    const bin = `${SRC}/classes/Legacy.cls`;
    const bytes = Buffer.concat([
      Buffer.from("public class Legacy { // caf"),
      Buffer.from([0xe9]),
      Buffer.from(" }\n"),
    ]);
    mkdirSync(path.join(project, `${SRC}/classes`), { recursive: true });
    writeFileSync(path.join(project, bin), bytes);
    git("add", ".");
    git("-c", "user.name=Jane Doe", "-c", "user.email=jane@example.com", "commit", "-q", "-m", "Add logo");
    const result = run({ projectDir: project, base: "HEAD~1", head: "HEAD" });
    const e = buildEvidence({ result, gate: evaluateGate({ result }), version: "1" });
    expect(e.change.components.find((c) => c.file === bin)?.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );

    const shallow = mkdtempSync(path.join(tmpdir(), "sf-preflight-shallow-"));
    try {
      execFileSync("git", ["clone", "-q", "--depth", "2", `file://${repo}`, shallow]);
      const r = run({ projectDir: path.join(shallow, "sfdx"), base: "HEAD~1", head: "HEAD" });
      const pack = buildEvidence({ result: r, gate: evaluateGate({ result: r }), version: "1" });
      expect(pack.change.authorship!.complete).toBe(false);
      expect(evidenceToMarkdown(pack)).toContain("shallow clone, so earlier commits may be missing");
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });
});

describe("JUnit output", () => {
  it("reports gate checks and findings as test cases", () => {
    const result = fieldResult();
    result.gate = evaluateGate({ result, config: { failOn: "medium" } });
    const xml = toJunit(result);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="sf-preflight"')).toBe(true);
    const failures = result.findings.filter((f) => f.severity === "high" || f.severity === "medium").length;
    expect(xml).toContain(
      `<testsuite name="sf-preflight.findings" tests="${result.findings.length}" failures="${failures}">`,
    );
    expect(xml).toContain('<testsuite name="sf-preflight.gate" tests="1" failures="1">');
    expect(xml).toContain('classname="sf-preflight.recursion-cycle"');
    expect((xml.match(/<testcase /g) ?? []).length).toBe(result.findings.length + 1);
  });

  it("escapes XML and handles changes without findings", () => {
    const r = fieldResult();
    r.findings = [{ rule: "x", severity: "high", title: 'A & B <c> "d"', detail: "e\u0001f", files: ["g&h.xml"] }];
    const xml = toJunit(r, "high");
    expect(xml).toContain('name="[high] A &amp; B &lt;c&gt; &quot;d&quot;" file="g&amp;h.xml"');
    expect(xml).toContain(">ef</failure>");
    r.findings = [];
    expect(toJunit(r)).toContain('<testcase classname="sf-preflight.findings" name="No findings"></testcase>');
  });
});

describe("review fixes", () => {
  it("matches ** only across whole folders", () => {
    expect(globMatch("force-app/**/Legacy*", "force-app/main/default/classes/NotLegacyService.cls")).toBe(false);
    expect(globMatch("force-app/**/Legacy*", "force-app/main/default/classes/LegacyService.cls")).toBe(true);
    expect(globMatch("**/Foo.cls", "classes/NotFoo.cls")).toBe(false);
    expect(globMatch("**/Foo.cls", "Foo.cls")).toBe(true);
    expect(globMatch("**/Foo.cls", "a/b/Foo.cls")).toBe(true);
    expect(globMatch("a/**", "a/b/c.xml")).toBe(true);
    expect(globMatch("a/**/z", "a/z")).toBe(true);
    expect(globMatch("a/**/z", "a/xz")).toBe(false);
  });

  it("passes the tests check when the change generates no tests, and fails AI approvals on shallow clones", () => {
    const result = fieldResult();
    const none = evaluateGate({ result, config: { failOn: "none", requireTestsPassed: true }, testsGenerated: 0 });
    expect(none.checks.find((c) => c.id === "tests-passed")).toMatchObject({ status: "pass" });
    const unknown = evaluateGate({ result, config: { failOn: "none", requireTestsPassed: true } });
    expect(unknown.checks.find((c) => c.id === "tests-passed")).toMatchObject({ status: "fail" });
    const shallow: AnalysisResult = {
      ...result,
      provenance: { range: "a..b", shallow: true, commits: 1, aiAssistedCommits: 0, tools: [], details: [] },
    };
    const g = evaluateGate({ result: shallow, config: { failOn: "none", aiAssistedApprovals: 1 }, approvals: [] });
    expect(g.checks.find((c) => c.id === "ai-approvals")).toMatchObject({ status: "fail" });
    expect(g.checks.find((c) => c.id === "ai-approvals")!.detail).toContain("shallow clone");
  });

  it("marks medium findings as JUnit failures when failing on medium", () => {
    const result = fieldResult();
    const medium = result.findings.filter((f) => f.severity === "high" || f.severity === "medium").length;
    expect(toJunit(result, "medium")).toContain(`failures="${medium}"`);
  });

  it("refuses anything that isn't an evidence pack", () => {
    expect(verifyEvidence(null)).toBe(false);
    expect(verifyEvidence([])).toBe(false);
    expect(verifyEvidence({ digest: { algorithm: "sha256", value: "x" } })).toBe(false);
  });
});

describe("policy from a git ref, and evidence hygiene", () => {
  let repo: string;
  let project: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Dev", "-c", "user.email=dev@example.com", ...args], {
      cwd: repo,
      stdio: "pipe",
    })
      .toString()
      .trim();
  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sf-preflight-m6-ref-"));
    project = path.join(repo, "sfdx");
    cpSync(FIXTURE, project, { recursive: true });
    writeFileSync(path.join(project, ".preflight.json"), JSON.stringify({ gate: { failOn: "high" } }));
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "https://user:pa/ss@word@github.com/acme/sf-app.git");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const vr = path.join(project, VR);
    writeFileSync(vr, readFileSync(vr, "utf8").replace("Closed Won", "Closed  Won"));
    git("commit", "-q", "-am", "Fix rule, ping jane@example.com");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("uses the policy at the ref and says when the change edits it", () => {
    writeFileSync(path.join(project, ".preflight.json"), JSON.stringify({ gate: { failOn: "none" } }));
    const fromRef = loadPolicy(project, { ref: "HEAD" });
    expect(fromRef).toMatchObject({ config: { gate: { failOn: "high" } }, file: ".preflight.json", ref: "HEAD" });
    expect(fromRef.warning).toBe("This change edits .preflight.json; this run used the version at HEAD.");
    const result = run({ projectDir: project, base: "HEAD~1", head: "HEAD", configRef: "HEAD" });
    expect(result.config).toMatchObject({ file: ".preflight.json", ref: "HEAD" });
    expect(result.warnings).toContain("This change edits .preflight.json; this run used the version at HEAD.");
    expect(toMarkdown(result)).toContain("_Policy: `.preflight.json` at `HEAD`_");
    // A policy file the change adds closer to the project can't shadow the one at the ref.
    const rootPolicy = path.join(repo, ".preflight.json");
    writeFileSync(rootPolicy, JSON.stringify({ gate: { failOn: "low" } }));
    git("rm", "-q", "--cached", "sfdx/.preflight.json");
    git("add", ".preflight.json");
    git("commit", "-q", "-m", "Only a root policy");
    const shadowed = loadPolicy(project, { ref: "HEAD" });
    expect(shadowed).toMatchObject({ config: { gate: { failOn: "low" } }, file: "../.preflight.json", ref: "HEAD" });
    expect(shadowed.warning).toBe("This change adds .preflight.json; it takes effect once merged.");
    // A policy outside the repository isn't part of the change, so it's read from disk.
    const centralDir = mkdtempSync(path.join(tmpdir(), "sf-preflight-central-"));
    const central = path.join(centralDir, "policy.json");
    writeFileSync(central, JSON.stringify({ gate: { aiAssistedApprovals: 2 } }));
    try {
      expect(loadPolicy(project, { explicit: central, ref: "HEAD" }).config).toEqual({
        gate: { aiAssistedApprovals: 2 },
      });
    } finally {
      rmSync(centralDir, { recursive: true, force: true });
    }
    rmSync(rootPolicy);
    git("rm", "-q", "--cached", ".preflight.json");
    git("commit", "-q", "-m", "No root policy");
    // A policy the change adds doesn't apply until it's merged.
    writeFileSync(path.join(project, ".preflight.json"), JSON.stringify({ gate: { failOn: "none" } }));
    expect(loadPolicy(project, { ref: "HEAD" })).toEqual({
      config: {},
      warning:
        "This change adds .preflight.json; it takes effect once merged. This run used the default policy, as at HEAD.",
    });
  });

  it("keeps credentials, emails and usernames out of the evidence, and records the pull request", () => {
    const result = run({ projectDir: project, base: "HEAD~1", head: "HEAD" });
    const e = buildEvidence({
      result,
      gate: evaluateGate({ result }),
      version: "1",
      tests: { validation: { ...validation("passed"), org: "admin@acme.com" } },
      pullRequest: { number: 12, headSha: "a".repeat(40), url: "https://github.com/acme/sf-app/pull/12" },
    });
    const text = JSON.stringify(e);
    expect(e.repository!.url).toBe("https://github.com/acme/sf-app.git");
    expect(text).not.toContain("pa/ss");
    expect(text).not.toContain("jane@example.com");
    expect(text).not.toContain("admin@acme.com");
    expect(e.tests.validation!.org).toBe("target org");
    expect(e.change.pullRequest).toEqual({
      number: 12,
      headSha: "a".repeat(40),
      url: "https://github.com/acme/sf-app/pull/12",
    });
    const bad = buildEvidence({
      result,
      gate: evaluateGate({ result }),
      version: "1",
      pullRequest: { number: 3, headSha: "nope", url: "javascript:alert(1)" },
    });
    expect(bad.change.pullRequest).toEqual({ number: 3, headSha: undefined, url: undefined });
  });
});

describe("GitHub Action scripts", () => {
  it("are valid bash", () => {
    const lines = readFileSync(path.resolve(__dirname, "../action.yml"), "utf8").split("\n");
    const scripts: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)run: (.*)$/.exec(lines[i]!);
      if (!m) continue;
      if (m[2] !== "|") {
        scripts.push(m[2]!);
        continue;
      }
      const body: string[] = [];
      const indent = m[1]!.length;
      while (i + 1 < lines.length && (lines[i + 1]!.trim() === "" || lines[i + 1]!.search(/\S/) > indent)) {
        body.push(lines[++i]!);
      }
      scripts.push(body.join("\n"));
    }
    expect(scripts.length).toBeGreaterThan(5);
    for (const script of scripts) {
      expect(
        () => execFileSync("bash", ["-n"], { input: script, stdio: ["pipe", "pipe", "pipe"] }),
        script,
      ).not.toThrow();
    }
  });
});
