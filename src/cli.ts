#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { editedFiles, installAgentHook, runAgentHook } from "./core/agentHook.js";
import { blocking, hookSummary, installHook, uninstallHook } from "./core/hook.js";
import type { AnalysisResult, AppliedRollback, FailOn, SaveEvent, Severity, TestsResultFile } from "./core/index.js";
import {
  type ApplyResult,
  agentExplanationToMarkdown,
  agentListToMarkdown,
  agentTestsToMarkdown,
  alertFromMonitor,
  alertFromResult,
  allAgentActions,
  analyze,
  analyzeChange,
  applyConfig,
  applyFixes,
  applyRollback,
  assertSafeOrg,
  assertSafeRef,
  assertSafeWebhook,
  BASELINE_FILE,
  buildEvidence,
  changeAt,
  changeFingerprint,
  detectTarget,
  evaluateGate,
  evidenceToMarkdown,
  explainAgent,
  type Fix,
  findFixes,
  fixesToMarkdown,
  GENERIC_ORG_LABEL,
  gateToMarkdown,
  generateTests,
  incidentsToMarkdown,
  investigateIncidents,
  loadPolicy,
  loadProject,
  monitorShouldNotify,
  monitorToMarkdown,
  type NotifyLevel,
  type NotifyTarget,
  noAgentTests,
  parseAgentTestsResult,
  parseApprovals,
  parseSince,
  payloadFor,
  planRollback,
  type RunOptions,
  readResult,
  rollbackToMarkdown,
  runAgentTests,
  runMonitor,
  runTests,
  saveProcedure,
  selectAgentTests,
  sendWebhook,
  shouldNotify,
  sourceRoots,
  testsToMarkdown,
  toJunit,
  toMarkdown,
  toSarif,
  type ValidationResult,
  validateTests,
  validationToMarkdown,
  verifyEvidence,
  wholeProjectChanges,
  writeBaselineFile,
} from "./core/index.js";
import { bundledSkillDir, installSkill } from "./core/skill.js";
import { startUpdateCheck } from "./updateNotice.js";

// `preflight analyze | head` closes stdout early; exit quietly instead of crashing on EPIPE.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw err;
});

const RISK_RANK = { low: 0, medium: 1, high: 2 } as const;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

type Format = "md" | "json" | "sarif" | "junit";

function render(result: AnalysisResult, format: Format, failOn?: FailOn): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  if (format === "sarif") return JSON.stringify(toSarif(result, { toolVersion: version }), null, 2);
  if (format === "junit") return toJunit(result, result.gate?.failOn ?? failOn);
  return toMarkdown(result);
}

/** Parser for a whole number in a range; rejects "5.9" and "10m" rather than truncating. */
function wholeNumber(min: number, max: number, unit = "") {
  return (v: string): number => {
    const n = /^\d+$/.test(v.trim()) ? Number(v) : Number.NaN;
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new InvalidArgumentError(`Expected a whole number${unit ? ` of ${unit}` : ""} from ${min} to ${max}.`);
    }
    return n;
  };
}
const minutes = (min: number, max: number) => wholeNumber(min, max, "minutes");

/** Org for commands printed in reports: an alias as given, never a username. */
const orgLabelFor = (org: string) => (org.includes("@") ? "<org>" : assertSafeOrg(org));

function readJson(file: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not read ${what} ${file}: ${(err as Error).message}`);
  }
}

interface PolicyOptions {
  project: string;
  base?: string;
  head?: string;
  files?: string[];
  staged?: boolean;
  baseline?: string | false;
  depth: number;
  org?: string;
  failOn?: FailOn;
  /** Path, or false for --no-config. */
  config?: string | false;
  configRef?: string;
  approvals?: string;
  testsResult?: string;
  agentTestsResult?: string;
  prNumber?: number;
  prHeadSha?: string;
  prUrl?: string;
}

const pullRequestOf = (opts: PolicyOptions) =>
  opts.prNumber ? { number: opts.prNumber, headSha: opts.prHeadSha, url: opts.prUrl } : undefined;

/** Analyze, then evaluate the quality gate from `.preflight.json`, approvals and test results. */
function analyzeWithPolicy(opts: PolicyOptions, withGate: boolean) {
  if (opts.configRef) assertSafeRef(opts.configRef, "config ref");
  const { model, result, policy } = analyzeChange({
    projectDir: opts.project,
    base: opts.base,
    head: opts.head,
    files: opts.files,
    staged: opts.staged,
    baseline: opts.baseline,
    maxDepth: opts.depth,
    org: opts.org,
    config: opts.config,
    configRef: opts.configRef,
  });
  const approvals = opts.approvals ? parseApprovals(readJson(opts.approvals, "approvals"), opts.approvals) : undefined;
  const tests = opts.testsResult ? (readJson(opts.testsResult, "tests result") as TestsResultFile) : undefined;
  const agentTests = opts.agentTestsResult
    ? parseAgentTestsResult(readJson(opts.agentTestsResult, "agent tests result"), opts.agentTestsResult)
    : undefined;
  if (withGate) {
    // When the policy needs passing tests but none were run, check whether the change has any.
    let testsGenerated = Array.isArray(tests?.tests) ? tests.tests.length : undefined;
    if (policy.gate?.requireTestsPassed && !tests) {
      try {
        testsGenerated = generateTests(model, result).tests.length;
      } catch {
        testsGenerated = undefined;
      }
    }
    result.gate = evaluateGate({
      result,
      config: { ...policy.gate, ...(opts.failOn ? { failOn: opts.failOn } : {}) },
      approvals,
      validation: tests?.validation,
      testsGenerated,
      agentTests,
      expectedAgentTests: policy.gate?.requireAgentTestsPassed
        ? selectAgentTests(model, result).map((t) => t.name)
        : undefined,
      changeFingerprint: policy.gate?.requireAgentTestsPassed && agentTests ? changeFingerprint(result) : undefined,
    });
  }
  return { result, approvals, tests, agentTests };
}

const program = new Command();
program
  .name("preflight")
  .description("Preflight checks for Salesforce changes: what will this change set off?")
  .version(version);

const policyOptions = (cmd: Command) =>
  cmd
    .option("-p, --project <dir>", "SFDX project directory", ".")
    .option("-b, --base <ref>", "git base ref (e.g. origin/main)")
    .option("--head <ref>", "git head ref (default: working tree)")
    .option("-f, --files <paths...>", "explicit changed files instead of a git diff")
    .option("--staged", "the files staged for the next commit, compared with HEAD")
    .option(
      "--baseline <source>",
      'report only findings the change introduces: "base" (compare with the base ref) or a baseline file',
    )
    .option("--no-baseline", "show every finding, even if .preflight.json sets a baseline")
    .option("--depth <n>", "max cascade depth", (v) => Number.parseInt(v, 10), 4)
    .option("--org <alias>", "add read-only context from an org authorized with `sf org login` (beta)")
    .option("--config <file>", "policy file (default: .preflight.json in the project, then the git root)")
    .option("--no-config", "ignore .preflight.json")
    .option("--config-ref <ref>", "read the policy from git at this ref, e.g. the pull request's base branch")
    .option("--approvals <file>", "JSON list of approvals (reviewer names), for the gate and evidence")
    .option("--tests-result <file>", "output of `preflight tests --validate --format json`, for the gate and evidence")
    .option("--agent-tests-result <file>", "output of `preflight agent-tests --format json`, for the gate and evidence")
    .option("--pr-number <n>", "pull request number, recorded in the evidence", (v) => Number.parseInt(v, 10))
    .option("--pr-head-sha <sha>", "pull request head commit, recorded in the evidence")
    .option("--pr-url <url>", "pull request URL, recorded in the evidence");

policyOptions(
  program.command("analyze").description("Analyze a change (git diff or explicit files) in an SFDX project"),
)
  .addOption(new Option("--format <format>", "output format").choices(["md", "json", "sarif", "junit"]).default("md"))
  .option("-o, --out <file>", "write the report to a file instead of stdout")
  .option("--md-out <file>", "also write a Markdown report to this file")
  .option("--json-out <file>", "also write a JSON report to this file")
  .option("--sarif-out <file>", "also write a SARIF report to this file")
  .option("--junit-out <file>", "also write JUnit XML (for CI test reports) to this file")
  .option("--evidence-out <file>", "also write the change's evidence pack (JSON) to this file")
  .option("--gate", "evaluate the quality gate from .preflight.json; exit with code 2 when it fails")
  .addOption(
    new Option(
      "--fail-on <level>",
      "exit with code 2 when risk is at or above this level (with --gate: the gate's threshold)",
    ).choices(["low", "medium", "high", "none"]),
  )
  .action(
    (
      opts: PolicyOptions & {
        format: Format;
        out?: string;
        mdOut?: string;
        jsonOut?: string;
        sarifOut?: string;
        junitOut?: string;
        evidenceOut?: string;
        gate?: boolean;
      },
    ) => {
      const { result, approvals, tests, agentTests } = analyzeWithPolicy(opts, !!opts.gate || !!opts.evidenceOut);
      const output = render(result, opts.format, opts.failOn);
      if (opts.out) writeFileSync(opts.out, `${output}\n`);
      else process.stdout.write(`${output}\n`);
      if (opts.mdOut) writeFileSync(opts.mdOut, `${render(result, "md")}\n`);
      if (opts.jsonOut) writeFileSync(opts.jsonOut, `${render(result, "json")}\n`);
      if (opts.sarifOut) writeFileSync(opts.sarifOut, `${render(result, "sarif")}\n`);
      if (opts.junitOut) writeFileSync(opts.junitOut, `${render(result, "junit", opts.failOn)}\n`);
      if (opts.evidenceOut) {
        const pack = buildEvidence({
          result,
          gate: result.gate!,
          version,
          approvals,
          tests,
          agentTests,
          pullRequest: pullRequestOf(opts),
        });
        writeFileSync(opts.evidenceOut, `${JSON.stringify(pack, null, 2)}\n`);
      }
      if (opts.gate) {
        if (result.gate?.status === "fail") process.exitCode = 2;
      } else if (opts.failOn && opts.failOn !== "none" && RISK_RANK[result.summary.risk] >= RISK_RANK[opts.failOn]) {
        process.exitCode = 2;
      }
    },
  );

program
  .command("fix")
  .description("Propose checked fixes for a change's findings; --apply writes them")
  .option("-p, --project <dir>", "SFDX project directory", ".")
  .option("-b, --base <ref>", "git base ref (e.g. origin/main)")
  .option("--head <ref>", "git head ref (default: working tree)")
  .option("-f, --files <paths...>", "explicit changed files instead of a git diff")
  .option("--staged", "the files staged for the next commit, compared with HEAD")
  .option("--baseline <source>", 'fix only findings the change introduces: "base" or a baseline file')
  .option("--no-baseline", "consider every finding, even if .preflight.json sets a baseline")
  .option("--depth <n>", "max cascade depth", (v) => Number.parseInt(v, 10), 4)
  .option("--config <file>", "policy file (default: .preflight.json in the project, then the git root)")
  .option("--no-config", "ignore .preflight.json")
  .option("--rule <ids...>", "only fixes for these rules")
  .option("--apply", "write the fixes (by default only the safe ones; see --kinds and --only)")
  .option("--kinds <kinds>", "with --apply: which kinds to write, comma-separated (safe,undo,review)", "safe")
  .option("--only <ids...>", "with --apply: write exactly these fixes, by id, whatever their kind")
  .addOption(new Option("--format <format>", "output format").choices(["md", "json"]).default("md"))
  .action(
    (opts: {
      project: string;
      base?: string;
      head?: string;
      files?: string[];
      staged?: boolean;
      baseline?: string | false;
      depth: number;
      config?: string | false;
      rule?: string[];
      apply?: boolean;
      kinds: string;
      only?: string[];
      format: "md" | "json";
    }) => {
      if (opts.base) assertSafeRef(opts.base, "base ref");
      const run: RunOptions = {
        projectDir: opts.project,
        base: opts.base,
        head: opts.head,
        files: opts.files,
        staged: opts.staged,
        baseline: opts.baseline,
        maxDepth: opts.depth,
        config: opts.config,
      };
      if (opts.apply && opts.head) throw new Error("--apply writes the working tree; it can't be used with --head.");
      const kinds = new Set(opts.kinds.split(",").map((k) => k.trim()));
      for (const k of kinds)
        if (!["safe", "undo", "review"].includes(k)) throw new Error(`Unknown fix kind "${k}" (safe, undo, review).`);
      const only = opts.only?.length ? new Set(opts.only) : undefined;
      const wanted = (f: Fix) => (only ? only.has(f.id) : kinds.has(f.kind));
      let report = findFixes(run, { rules: opts.rule });
      let applied: ApplyResult | undefined;
      if (opts.apply) {
        // Two fixes can edit the same file: apply what is still current, then look again (a few rounds).
        const done: ApplyResult = { applied: [], stale: [] };
        applied = done;
        const first = report;
        for (let round = 0; round < 5; round++) {
          const todo = report.fixes.filter((f) => wanted(f) && !done.applied.includes(f.id));
          if (!todo.length) break;
          const r = applyFixes(run.projectDir, todo);
          done.applied.push(...r.applied);
          done.stale = r.stale;
          if (!r.stale.length || !r.applied.length) break;
          report = findFixes(run, { rules: opts.rule });
        }
        report = first;
        if (only) {
          const missing = [...only].filter((id) => !first.fixes.some((f) => f.id === id));
          if (missing.length) process.stderr.write(`preflight: no checked fix with id ${missing.join(", ")}.\n`);
        }
      }
      if (opts.format === "json")
        process.stdout.write(
          `${JSON.stringify({ fixes: report.fixes, rejected: report.rejected, withoutFix: report.withoutFix, applied: applied?.applied, stale: applied?.stale }, null, 2)}\n`,
        );
      else process.stdout.write(`${fixesToMarkdown(report, applied)}\n`);
    },
  );

policyOptions(
  program
    .command("evidence")
    .description("Write the evidence pack for a change: what changed, who wrote it, findings, tests, approvals, gate"),
)
  .option("-o, --out <file>", "where to write the evidence JSON", "preflight-evidence.json")
  .option("--gate", "exit with code 2 when the quality gate fails")
  .addOption(
    new Option("--fail-on <level>", "the gate's severity threshold").choices(["low", "medium", "high", "none"]),
  )
  .option("--verify <file>", "check an evidence file's digest instead of creating one")
  .action((opts: PolicyOptions & { out: string; gate?: boolean; verify?: string }) => {
    if (opts.verify) {
      const pack = readJson(opts.verify, "evidence");
      if (!verifyEvidence(pack)) {
        process.stderr.write(
          `${opts.verify}: not an sf-preflight evidence pack, or its digest doesn't match its content.\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `${opts.verify}: digest matches (sha256:${pack.digest.value}). This shows the file is intact; to show who produced it, verify its attestation (see docs/EVIDENCE.md).\n`,
      );
      return;
    }
    const { result, approvals, tests, agentTests } = analyzeWithPolicy(opts, true);
    const pack = buildEvidence({
      result,
      gate: result.gate!,
      version,
      approvals,
      tests,
      agentTests,
      pullRequest: pullRequestOf(opts),
    });
    writeFileSync(opts.out, `${JSON.stringify(pack, null, 2)}\n`);
    process.stdout.write(`${evidenceToMarkdown(pack)}\n\n${gateToMarkdown(pack.gate)}\n`);
    process.stderr.write(`Wrote ${opts.out}\n`);
    if (opts.gate && pack.gate.status === "fail") process.exitCode = 2;
  });

program
  .command("tests")
  .description("Generate Apex tests for what a change touches (bulk, recursion, idempotency, swallowed errors)")
  .option("-p, --project <dir>", "SFDX project directory", ".")
  .option("-b, --base <ref>", "git base ref (e.g. origin/main)")
  .option("--head <ref>", "git head ref (default: working tree)")
  .option("-f, --files <paths...>", "explicit changed files instead of a git diff")
  .option("-o, --out <dir>", "directory to write the classes to (default: <project>/preflight-tests)")
  .option("--prefix <name>", "prefix for generated class names", "Preflight")
  .option("--class-name <name>", "test class name (default: <prefix>ChangeTest)")
  .option("--bulk-size <n>", "records per bulk test", (v) => Number.parseInt(v, 10), 200)
  .option("--depth <n>", "max cascade depth", (v) => Number.parseInt(v, 10), 4)
  .option("--dry-run", "print the summary without writing files")
  .option("--validate", "run the tests in --org with a check-only deployment (nothing is saved)")
  .option("--org <alias>", "org for --validate: a sandbox, scratch org or Developer Edition org")
  .option("--allow-production", "allow --validate in a production org")
  .option("--wait <minutes>", "minutes to wait for --validate (1-600)", minutes(1, 600), 33)
  .addOption(new Option("--format <format>", "summary format").choices(["md", "json"]).default("md"))
  .action(
    (opts: {
      project: string;
      base?: string;
      head?: string;
      files?: string[];
      out?: string;
      prefix: string;
      className?: string;
      bulkSize: number;
      depth: number;
      dryRun?: boolean;
      validate?: boolean;
      org?: string;
      allowProduction?: boolean;
      wait: number;
      format: "md" | "json";
    }) => {
      if (opts.validate && !opts.org) throw new Error("--validate needs --org <alias>.");
      if (opts.validate && opts.dryRun) throw new Error("--validate can't be combined with --dry-run.");
      if (opts.org && !opts.validate) throw new Error("--org is only used with --validate.");
      const { tests } = runTests({
        projectDir: opts.project,
        base: opts.base,
        head: opts.head,
        files: opts.files,
        maxDepth: opts.depth,
        prefix: opts.prefix,
        className: opts.className,
        bulkSize: opts.bulkSize,
      });
      const outDir = path.resolve(opts.out ?? path.join(opts.project, "preflight-tests"));
      if (!opts.dryRun) {
        for (const f of tests.files) {
          const target = path.join(outDir, f.path);
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, f.content);
        }
      }
      const shown = (p: string) => {
        const rel = path.relative(process.cwd(), p);
        return rel === "" ? "." : rel.startsWith("..") ? p : rel;
      };
      const shownDir = shown(outDir);
      const projectAbs = path.resolve(opts.project);
      const sourceDirs = sourceRoots(projectAbs);
      // Paths in the suggested `sf` command are relative to the project, where `sf` has to run.
      const inProject = path.relative(projectAbs, outDir);
      const insideSource = sourceDirs.some((d) => {
        const rel = path.relative(path.resolve(projectAbs, d), outDir);
        return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      });
      const outForSf = insideSource
        ? undefined
        : inProject.startsWith("..") || path.isAbsolute(inProject)
          ? outDir
          : inProject.split(path.sep).join("/");
      if (!opts.dryRun && tests.files.length) {
        process.stderr.write(`Wrote ${tests.files.length} files to ${shownDir}\n`);
      }
      let validation: ValidationResult | undefined;
      if (opts.validate && opts.org && tests.tests.length) {
        process.stderr.write(
          "Running the generated tests with a check-only deployment (nothing is saved); this can take a few minutes...\n",
        );
        validation = validateTests({
          org: opts.org,
          projectDir: projectAbs,
          sourceDirs,
          testsDir: outForSf,
          className: tests.className,
          methods: tests.tests.map((t) => t.method),
          waitMinutes: opts.wait,
          allowProduction: opts.allowProduction,
        });
        if (validation.status === "failed") process.exitCode = 2;
      }
      if (opts.format === "json") {
        const { files, ...rest } = tests;
        const json = {
          ...rest,
          outDir: opts.dryRun ? undefined : shownDir,
          files: files.map((f) => f.path),
          validation,
        };
        process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
      } else {
        const results = validation ? validationToMarkdown(validation) : undefined;
        process.stdout.write(
          `${testsToMarkdown(tests, {
            projectDir: shown(projectAbs),
            sourceDirs,
            outDir: outForSf,
            results,
            targetOrg: validation && validation.org !== GENERIC_ORG_LABEL ? validation.org : undefined,
          })}\n`,
        );
      }
    },
  );

program
  .command("agents")
  .description("List Agentforce agents, or explain what one agent's actions call, save and need")
  .argument("[agent]", "agent API name, e.g. Sales_Agent")
  .option("-p, --project <dir>", "SFDX project directory", ".")
  .option("--depth <n>", "max cascade depth", (v) => Number.parseInt(v, 10), 4)
  .addOption(new Option("--format <format>", "output format").choices(["md", "json"]).default("md"))
  .action((agent: string | undefined, opts: { project: string; depth: number; format: "md" | "json" }) => {
    const model = loadProject(opts.project);
    if (!agent) {
      if (opts.format === "json") {
        const list = [...model.agents.values()].map((a) => ({
          name: a.name,
          label: a.label,
          source: a.source,
          topics: a.topics.map((t) => t.name),
          actions: allAgentActions(model)
            .filter((r) => r.agent === a)
            .map((r) => r.action.name),
          file: a.file,
        }));
        process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
      } else {
        process.stdout.write(`${agentListToMarkdown(model)}\n`);
      }
      return;
    }
    const e = explainAgent(model, agent, opts.depth);
    if (!e) {
      const known = [...model.agents.values()].map((a) => a.name).join(", ");
      throw new Error(`No agent named ${agent} in the project${known ? ` (agents: ${known})` : ""}.`);
    }
    process.stdout.write(`${opts.format === "json" ? JSON.stringify(e, null, 2) : agentExplanationToMarkdown(e)}\n`);
  });

program
  .command("agent-tests")
  .description(
    "Run the Testing Center tests that cover the agent actions a change affects (in an org the change is deployed to)",
  )
  .option("-p, --project <dir>", "SFDX project directory", ".")
  .option("-b, --base <ref>", "git base ref (e.g. origin/main)")
  .option("--head <ref>", "git head ref (default: working tree)")
  .option("-f, --files <paths...>", "explicit changed files instead of a git diff")
  .option("--org <alias>", "sandbox, scratch org or Developer Edition org with the change deployed")
  .option("--test <names...>", "run these Testing Center tests instead of picking them from the change")
  .option("--all", "run every test of the affected agents, not only those expecting an affected action or topic")
  .option("--allow-production", "allow running in a production org")
  .option("--wait <minutes>", "minutes to wait for each test run (1-120)", minutes(1, 120), 10)
  .option("--dry-run", "list the tests that would run, without running them")
  .addOption(new Option("--format <format>", "output format").choices(["md", "json"]).default("md"))
  .option("-o, --out <file>", "write the output to a file instead of stdout")
  .action(
    (opts: {
      project: string;
      base?: string;
      head?: string;
      files?: string[];
      org?: string;
      test?: string[];
      all?: boolean;
      allowProduction?: boolean;
      wait: number;
      dryRun?: boolean;
      format: "md" | "json";
      out?: string;
    }) => {
      if (!opts.org && !opts.dryRun) throw new Error("agent-tests needs --org <alias> (or --dry-run).");
      if (opts.all && opts.test?.length) throw new Error("Use either --all or --test, not both.");
      const changed = !!(opts.base || opts.files?.length);
      if (!changed && !opts.test?.length)
        throw new Error("Provide --base or --files to pick tests from a change, or --test <names...>.");
      const { model, result } = changed
        ? analyzeChange({ projectDir: opts.project, base: opts.base, head: opts.head, files: opts.files })
        : { model: loadProject(opts.project), result: undefined };
      const tests = selectAgentTests(model, result ?? ({ agents: [] } as unknown as AnalysisResult), {
        all: opts.all,
        names: opts.test,
      });
      const write = (text: string) => {
        if (opts.out) writeFileSync(opts.out, `${text}\n`);
        else process.stdout.write(`${text}\n`);
      };
      // With a change, the result records it so the gate can tell results from other changes.
      const change = result ? { fingerprint: changeFingerprint(result), files: result.changes.length } : undefined;
      if (!opts.dryRun && !tests.length && opts.format === "json") {
        // A result the gate and evidence can read: nothing to run, so nothing failed.
        write(JSON.stringify(noAgentTests(opts.org!, change), null, 2));
        return;
      }
      if (opts.dryRun || !tests.length) {
        if (opts.format === "json") {
          write(
            JSON.stringify({ tests: tests.map((t) => ({ name: t.name, agent: t.subject, file: t.file })) }, null, 2),
          );
        } else if (!tests.length) {
          write(
            result?.agents.length
              ? "No Testing Center tests in the project cover the affected agent actions. Add test cases for them (see `preflight analyze`)."
              : "The change affects no agent actions, so there are no Testing Center tests to run.",
          );
        } else {
          write(["Testing Center tests to run:", ...tests.map((t) => `- \`${t.name}\` (${t.subject})`)].join("\n"));
        }
        return;
      }
      process.stderr.write(`Running ${tests.length} Testing Center test(s); each can take a few minutes...\n`);
      const r = runAgentTests({
        org: opts.org!,
        tests,
        waitMinutes: opts.wait,
        allowProduction: opts.allowProduction,
        change,
      });
      write(opts.format === "json" ? JSON.stringify(r, null, 2) : agentTestsToMarkdown(r));
      if (r.status === "failed") process.exitCode = 2;
    },
  );

program
  .command("incidents")
  .description(
    "Trace production errors (failed flows, Apex exceptions, failed jobs, Agentforce action errors) back to the recent changes that most likely caused them",
  )
  .option("-p, --project <dir>", "SFDX project directory", ".")
  .option("--org <alias>", "org to read errors from, read-only (production is fine)")
  .option("--since <when>", "errors since a duration (7d, 24h, 2w) or a date", "7d")
  .option("--ref <ref>", "branch whose history to search", "HEAD")
  .option("--max-changes <n>", "most recent changes to consider", wholeNumber(1, 500), 50)
  .option("--lookback <days>", "days before --since to look for changes", wholeNumber(0, 366, "days"), 30)
  .option("--errors <file>", "also read errors from a JSON file (see docs/INCIDENTS.md)")
  .addOption(
    new Option("--source <sources...>", "org sources to read (default: all)").choices([
      "flow",
      "apex",
      "async-apex",
      "agent",
    ]),
  )
  .addOption(new Option("--format <format>", "output format").choices(["md", "json"]).default("md"))
  .option("-o, --out <file>", "write the report to a file instead of stdout")
  .action(
    (opts: {
      project: string;
      org?: string;
      since: string;
      ref: string;
      maxChanges: number;
      lookback: number;
      errors?: string;
      source?: ("flow" | "apex" | "async-apex" | "agent")[];
      format: "md" | "json";
      out?: string;
    }) => {
      if (!opts.org && !opts.errors) throw new Error("incidents needs --org <alias> or --errors <file>.");
      if (opts.org) process.stderr.write("Reading production errors from the org (read-only)...\n");
      const report = investigateIncidents({
        projectDir: opts.project,
        org: opts.org,
        since: parseSince(opts.since),
        ref: opts.ref,
        maxChanges: opts.maxChanges,
        lookbackDays: opts.lookback,
        errors: opts.errors ? { raw: readJson(opts.errors, "errors"), file: opts.errors } : undefined,
        sources: opts.source,
      });
      const text = opts.format === "json" ? JSON.stringify(report, null, 2) : incidentsToMarkdown(report);
      if (opts.out) writeFileSync(opts.out, `${text}\n`);
      else process.stdout.write(`${text}\n`);
    },
  );

program
  .command("rollback")
  .description("Plan a partial rollback of a change: restore or deactivate only the components that need it")
  .argument("<commit>", "the commit or merge commit to roll back")
  .option("-p, --project <dir>", "SFDX project directory", ".")
  .option("--component <names...>", "components to roll back (default: everything the commit changed)")
  .option("--org <alias>", "org alias to put in the deploy commands (nothing is deployed)")
  .option("--restore", "restore and edit the files in the working tree (nothing is committed or deployed)")
  .addOption(new Option("--format <format>", "output format").choices(["md", "json"]).default("md"))
  .option("-o, --out <file>", "write the plan to a file instead of stdout")
  .action(
    (
      commit: string,
      opts: {
        project: string;
        component?: string[];
        org?: string;
        restore?: boolean;
        format: "md" | "json";
        out?: string;
      },
    ) => {
      const projectDir = path.resolve(opts.project);
      const change = changeAt(projectDir, commit);
      const plan = planRollback({
        projectDir,
        model: loadProject(projectDir),
        change,
        components: opts.component,
        org: opts.org ? orgLabelFor(opts.org) : undefined,
      });
      let applied: AppliedRollback | undefined;
      if (opts.restore) applied = applyRollback(projectDir, plan);
      let text: string;
      if (opts.format === "json") text = JSON.stringify(applied ? { ...plan, applied } : plan, null, 2);
      else {
        text = rollbackToMarkdown(plan);
        if (applied) {
          const lines = [
            ...applied.restored.map((f) => `- restored \`${f}\``),
            ...applied.removed.map((f) => `- removed \`${f}\``),
            ...applied.edited.map((f) => `- deactivated in \`${f}\``),
            ...applied.created.map((f) => `- created \`${f}\``),
            ...applied.skipped.map(
              (f) => `- ⚠️ couldn't apply the edit to \`${f}\` (it changed since the plan): edit it by hand`,
            ),
          ];
          text += `\n\n**Applied to the working tree (nothing staged):**\n${lines.join("\n") || "- nothing to change"}\n\nReview with \`git status\` and \`git diff\`, then commit and open a pull request.`;
        }
      }
      if (opts.out) writeFileSync(opts.out, `${text}\n`);
      else process.stdout.write(`${text}\n`);
    },
  );

program
  .command("explain")
  .description("Show what runs, in order, when records of an object are saved")
  .argument("<object>", "object API name, e.g. Opportunity")
  .option("-p, --project <dir>", "SFDX project directory", ".")
  .addOption(
    new Option("-e, --event <event>", "DML event")
      .choices(["insert", "update", "delete", "undelete"])
      .default("update"),
  )
  .action((object: string, opts: { project: string; event: SaveEvent }) => {
    const model = loadProject(opts.project);
    const proc = saveProcedure(model, object, opts.event);
    if (!proc.steps.length) {
      console.log(`No modelled automation runs on ${object} ${opts.event}.`);
      return;
    }
    console.log(`${object} — ${opts.event}`);
    for (const s of proc.steps) {
      const writes = s.writes.length ? ` → writes ${s.writes.map((w) => `${w.object} (${w.op})`).join(", ")}` : "";
      const notes = s.notes.length ? `  [${s.notes.join("; ")}]` : "";
      console.log(`  ${s.order}. ${s.phaseLabel.padEnd(18)} ${s.automation.name}${writes}${notes}`);
    }
  });

program
  .command("notify")
  .description("Send an alert about a risky change to Slack, Microsoft Teams or another webhook")
  .requiredOption("--result <file>", "JSON report from `preflight analyze --json-out`")
  .addOption(
    new Option("--on <level>", "send when risk is at least this level, when the gate fails, or always")
      .choices(["low", "medium", "high", "gate-fail", "always"])
      .default("high"),
  )
  .addOption(
    new Option("--target <target>", "message format (default: from the webhook's host name)")
      .choices(["auto", "slack", "teams", "generic"])
      .default("auto"),
  )
  .option("--link <url>", "https link to show in the alert, e.g. the pull request")
  .option("--link-label <text>", "text of the link button", "Open")
  .option("--source <text>", 'where the change is from, e.g. "owner/repo PR #12"')
  .option("--title <text>", "alert title (default: from the risk level)")
  .option("--dry-run", "print the message instead of sending it")
  .option("--strict", "exit with code 1 when the alert cannot be sent (default: warn and exit 0)")
  .action(
    async (opts: {
      result: string;
      on: NotifyLevel;
      target: NotifyTarget | "auto";
      link?: string;
      linkLabel: string;
      source?: string;
      title?: string;
      dryRun?: boolean;
      strict?: boolean;
    }) => {
      const result = readResult(readJson(opts.result, "report"));
      if (!shouldNotify(result, opts.on)) {
        console.error(`No alert: risk is ${result.summary.risk}, below "${opts.on}".`);
        return;
      }
      // The URL is a secret: only from the environment, so it never appears in a command line or a policy file.
      const raw = process.env.PREFLIGHT_WEBHOOK_URL;
      if (!raw && !opts.dryRun) {
        throw new Error("Set PREFLIGHT_WEBHOOK_URL to the webhook URL (from a secret), or use --dry-run.");
      }
      const url = raw ? assertSafeWebhook(raw) : undefined;
      const target: NotifyTarget = opts.target === "auto" ? (url ? detectTarget(url) : "generic") : opts.target;
      const alert = alertFromResult(result, {
        link: opts.link ? { label: opts.linkLabel, url: opts.link } : undefined,
        source: opts.source,
        title: opts.title,
      });
      const payload = payloadFor(target, alert);
      if (opts.dryRun || !url) {
        console.log(JSON.stringify({ target, host: url?.hostname, payload }, null, 2));
        return;
      }
      const sent = await sendWebhook(url, payload);
      if (sent.ok) {
        console.error(`Alert sent to ${url.hostname} (${target}).`);
      } else {
        console.error(`Could not send the alert: ${sent.error}.`);
        if (opts.strict) process.exitCode = 1;
      }
    },
  );

program
  .command("monitor")
  .description(
    "Watch a production org's Setup Audit Trail (read-only) and alert on risky changes: validation rules or flows switched off, broad permissions, Apex, sharing and security settings",
  )
  .requiredOption("--org <alias>", "org to watch, read-only (production is fine)")
  .option("--since <when>", "changes since a duration (1h, 24h, 7d) or a date", "24h")
  .option("--state <file>", "remember the newest change seen, so each run reports only new ones")
  .option("-p, --project <dir>", "SFDX project: say whether each change names a component found in the repository")
  .option(
    "--ignore-user <names...>",
    "skip changes made by these users (e.g. your deployment user); names are never shown",
  )
  .addOption(new Option("--format <format>", "output format").choices(["md", "json"]).default("md"))
  .option("-o, --out <file>", "write the report to a file instead of stdout")
  .addOption(
    new Option("--notify-on <level>", "send an alert (PREFLIGHT_WEBHOOK_URL) when risk is at least this level").choices(
      ["medium", "high"],
    ),
  )
  .addOption(
    new Option("--target <target>", "alert format (default: from the webhook's host name)")
      .choices(["auto", "slack", "teams", "generic"])
      .default("auto"),
  )
  .option("--link <url>", "https link to show in the alert")
  .option("--dry-run", "print the alert instead of sending it")
  .option("--strict", "exit with code 1 when the alert cannot be sent (default: warn and exit 0)")
  .action(
    async (opts: {
      org: string;
      since: string;
      state?: string;
      project?: string;
      ignoreUser?: string[];
      format: "md" | "json";
      out?: string;
      notifyOn?: "medium" | "high";
      target: NotifyTarget | "auto";
      link?: string;
      dryRun?: boolean;
      strict?: boolean;
    }) => {
      let since = parseSince(opts.since);
      let exclusive = false;
      if (opts.state && existsSync(opts.state)) {
        try {
          const saved = new Date(
            (JSON.parse(readFileSync(opts.state, "utf8")) as { lastSeen?: string }).lastSeen ?? "",
          );
          if (!Number.isNaN(saved.getTime()) && saved > since) {
            since = saved;
            exclusive = true;
          }
        } catch {
          console.error(`Ignoring unreadable state file ${opts.state}.`);
        }
      }
      const raw = process.env.PREFLIGHT_WEBHOOK_URL;
      if (opts.notifyOn && !raw && !opts.dryRun) {
        throw new Error("Set PREFLIGHT_WEBHOOK_URL to the webhook URL (from a secret), or use --dry-run.");
      }
      const url = raw && opts.notifyOn ? assertSafeWebhook(raw) : undefined;
      console.error("Reading the Setup Audit Trail (read-only)...");
      const report = runMonitor({
        org: opts.org,
        since,
        exclusive,
        model: opts.project ? loadProject(path.resolve(opts.project)) : undefined,
        ignoreUsers: opts.ignoreUser,
      });
      const text = opts.format === "json" ? JSON.stringify(report, null, 2) : monitorToMarkdown(report);
      if (opts.out) writeFileSync(opts.out, `${text}\n`);
      else process.stdout.write(`${text}\n`);
      let delivered = true;
      if (opts.notifyOn && monitorShouldNotify(report, opts.notifyOn)) {
        const target: NotifyTarget = opts.target === "auto" ? (url ? detectTarget(url) : "generic") : opts.target;
        const payload = payloadFor(
          target,
          alertFromMonitor(report, { link: opts.link ? { label: "Open", url: opts.link } : undefined }),
        );
        if (opts.dryRun || !url) {
          console.log(JSON.stringify({ target, host: url?.hostname, payload }, null, 2));
        } else {
          const sent = await sendWebhook(url, payload);
          delivered = sent.ok;
          if (sent.ok) console.error(`Alert sent to ${url.hostname} (${target}).`);
          else {
            console.error(`Could not send the alert: ${sent.error}.`);
            if (opts.strict) process.exitCode = 1;
          }
        }
      }
      // Move the mark forward only once the alert went out, so a failed send is tried again next run.
      if (opts.state && report.newest && delivered && !opts.dryRun) {
        writeFileSync(opts.state, `${JSON.stringify({ lastSeen: report.newest })}\n`);
      }
    },
  );

program
  .command("agent-hook")
  .description(
    "For AI coding agents: after an edit, report what it introduces so the agent fixes it (a Claude Code PostToolUse hook)",
  )
  .argument("[action]", "run (reads the hook's JSON on stdin) or install (adds it to .claude/settings.json)", "run")
  .option("-p, --project <dir>", "project to install into", ".")
  .option("--file <paths...>", "run: check these files instead of reading the hook's JSON")
  .addOption(
    new Option("--fail-on <level>", "report findings at or above this level to the agent")
      .choices(["low", "medium", "high"])
      .default("medium"),
  )
  .action(async (action: string, opts: { project: string; file?: string[]; failOn: Severity }) => {
    if (action === "install") {
      const r = installAgentHook(opts.project, `npx --yes sf-preflight@${version} agent-hook`);
      console.log(
        r.status === "installed"
          ? `Added the sf-preflight hook to ${r.file}.\nAfter Claude Code edits Salesforce metadata, it now sees the findings its edit introduces.`
          : `The sf-preflight hook is already in ${r.file}.`,
      );
      return;
    }
    if (action !== "run") throw new Error(`Unknown agent-hook action: ${action} (run or install).`);
    // Never break the agent's turn: a problem here means no feedback, not an error.
    try {
      let files = opts.file ?? [];
      let cwd: string | undefined;
      if (!files.length) {
        if (process.stdin.isTTY) return;
        const chunks: Buffer[] = [];
        for await (const c of process.stdin) chunks.push(c as Buffer);
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { cwd?: string };
        files = editedFiles(input);
        cwd = typeof input.cwd === "string" ? input.cwd : undefined;
      }
      if (!files.length) return;
      const { output } = runAgentHook(files, { failOn: opts.failOn, cwd });
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch (err) {
      process.stderr.write(`sf-preflight agent hook: ${(err as Error).message}\n`);
    }
  });

program
  .command("baseline")
  .description("Record the findings the whole project has today, so only new ones are reported from now on")
  .option("-p, --project <dir>", "SFDX project directory", ".")
  .option("-o, --out <file>", "baseline file to write (default: .preflight-baseline.json in the project)")
  .action((opts: { project: string; out?: string }) => {
    const projectDir = path.resolve(opts.project);
    const model = loadProject(projectDir);
    const policy = loadPolicy(projectDir).config;
    const result = applyConfig(analyze({ model, changes: wholeProjectChanges(projectDir) }), policy);
    const out = opts.out ? path.resolve(opts.out) : path.join(projectDir, BASELINE_FILE);
    const n = writeBaselineFile(out, result.findings);
    const rel = path.relative(projectDir, out).split(path.sep).join("/");
    console.log(
      `Recorded ${n} known finding(s) in ${rel}.\nCommit it, and add "baseline": "${rel}" to .preflight.json so analyses, the hook and CI report only new findings.`,
    );
  });

program
  .command("hook")
  .description("Check staged Salesforce metadata before each commit (a git pre-commit hook)")
  .argument("[action]", "install, uninstall, or run (what the hook calls)", "install")
  .option("-p, --project <dir>", "SFDX project directory", ".")
  .addOption(
    new Option(
      "--fail-on <level>",
      "block the commit on findings at or above this level (default: the policy's, else high)",
    ).choices(["low", "medium", "high", "none"]),
  )
  .option("--force", "install: replace an existing pre-commit hook that isn't sf-preflight's")
  .option("--all", "run: report every finding, not only those the staged change introduces")
  .action((action: string, opts: { project: string; failOn?: Severity | "none"; force?: boolean; all?: boolean }) => {
    if (action === "install") {
      const r = installHook(opts.project, { version, failOn: opts.failOn, force: opts.force });
      if (r.status === "exists-other") {
        console.error(
          `A pre-commit hook already exists at ${r.file}. Add this line to it (or use --force to replace it):\n  npx --yes sf-preflight@${version} hook run -p ${JSON.stringify(opts.project)}`,
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        `${r.status === "installed" ? "Installed" : "Updated"} the pre-commit hook: ${r.file}\nEach commit now checks the staged Salesforce metadata. Skip once with \`git commit --no-verify\`.`,
      );
      return;
    }
    if (action === "uninstall") {
      const r = uninstallHook(opts.project);
      console.log(r.removed ? `Removed ${r.file}.` : `No sf-preflight pre-commit hook at ${r.file}.`);
      return;
    }
    if (action !== "run") throw new Error(`Unknown hook action: ${action} (install, uninstall or run).`);
    // By default only what the staged change introduces blocks the commit (compared with HEAD).
    const { result, policy } = analyzeChange({
      projectDir: opts.project,
      staged: true,
      baseline: opts.all ? false : undefined,
      defaultBaseline: "base",
    });
    if (!result.changes.length) return; // nothing Salesforce staged
    const failOn = opts.failOn ?? (policy.gate?.failOn as Severity | "none" | undefined) ?? "high";
    process.stderr.write(`${hookSummary(result, failOn)}\n`);
    if (blocking(result, failOn).length) process.exitCode = 2;
  });

program
  .command("skill")
  .description(
    "Install the sf-preflight agent skill for AI coding agents (Codex, Copilot, Cursor, Gemini CLI, Claude Code, …)",
  )
  .argument("[action]", "install (default) or path", "install")
  .option("-p, --project <dir>", "project to install into", ".")
  .option("--global", "install for your user (home directory) instead of the project")
  .option("--dir <dirs...>", "skills directories to install into instead of .agents/skills and .claude/skills")
  .option("--force", "replace an existing copy")
  .action((action: string, opts: { project: string; global?: boolean; dir?: string[]; force?: boolean }) => {
    if (action === "path") {
      console.log(bundledSkillDir());
      return;
    }
    if (action !== "install") throw new Error(`Unknown action "${action}": use install or path.`);
    const written = installSkill({ projectDir: opts.project, global: opts.global, dirs: opts.dir, force: opts.force });
    console.log(
      [
        "Installed the sf-preflight skill:",
        ...written.map((d) => `  ${d}`),
        "",
        "Agents load it when a task involves Salesforce metadata. For its tools, also add the MCP server",
        "(`npx -y sf-preflight mcp`): see https://github.com/visparashar/sf-preflight/blob/main/docs/AI_AGENTS.md",
      ].join("\n"),
    );
  });

program
  .command("mcp")
  .description("Run an MCP server over stdio so coding agents can call preflight")
  .option("--root <dir>", "directory the server may analyze (tool calls cannot reach outside it)", ".")
  .action(async (opts: { root: string }) => {
    const { startMcpServer } = await import("./mcp.js");
    await startMcpServer({ root: opts.root, version });
  });

// "A newer version is available", for a person at a terminal (see updateNotice.ts).
program.hook("preAction", (_root, action) => {
  let top: Command = action;
  while (top.parent && top.parent !== program) top = top.parent;
  startUpdateCheck({ command: top.name(), version, scriptPath: process.argv[1] ?? "" });
});

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`preflight: ${(err as Error).message}`);
  process.exitCode = 1;
});
