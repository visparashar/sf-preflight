// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { analyze } from "./analyze.js";
import { applyBaseline, findingsAtRef, readBaselineFile } from "./baseline.js";
import { filesFromArgs, gitChangedFiles, gitRoot, gitShow, gitStagedFiles, hasHead, toChanges } from "./changes.js";
import { applyConfig, loadPolicy, type PreflightConfig } from "./config.js";
import { destructiveChanges } from "./destructive.js";
import { enrichWithOrg } from "./org/enrich.js";
import type { SfRunner } from "./org/sf.js";
import { loadProject, sourceRoots } from "./project.js";
import { gitProvenance } from "./provenance.js";
import { generateTests, type TestGenOptions, type TestGenResult } from "./testgen/generate.js";
import type { AnalysisResult, ChangeType, OrgModel } from "./types.js";
import { toPosix, uniq } from "./util.js";

export {
  type AgentExplanation,
  agentExplanationToMarkdown,
  agentListToMarkdown,
  allAgentActions,
  explainAgent,
} from "./agentImpact.js";
export { analyze, fieldReferences } from "./analyze.js";
export {
  acceptIntoBaseline,
  applyBaseline,
  BASELINE_FILE,
  fingerprint,
  wholeProjectChanges,
  writeBaselineFile,
} from "./baseline.js";
export { assertSafeRef, filesFromArgs, gitChangedFiles, gitRoot, toChanges } from "./changes.js";
export {
  applyConfig,
  CONFIG_FILE,
  type FailOn,
  type GateConfig,
  globMatch,
  type LoadedPolicy,
  loadConfig,
  loadPolicy,
  type PreflightConfig,
  parseConfig,
} from "./config.js";
export {
  buildEvidence,
  canonicalJson,
  changeFingerprint,
  EVIDENCE_PREDICATE_TYPE,
  type EvidencePack,
  evidenceDigest,
  evidenceToMarkdown,
  type TestsResultFile,
  verifyEvidence,
} from "./evidence.js";
export {
  type Approval,
  evaluateGate,
  type GateCheck,
  type GateResult,
  gateToMarkdown,
  parseApprovals,
} from "./gate.js";
export * from "./incidents/index.js";
export { type Insight, insightFor } from "./insight.js";
export {
  type AuditEntry,
  alertFromMonitor,
  classifyAudit,
  type MonitorFinding,
  type MonitorReport,
  monitorShouldNotify,
  monitorToMarkdown,
  readAuditTrail,
  runMonitor,
} from "./monitor.js";
export {
  type Alert,
  alertFromResult,
  assertSafeWebhook,
  detectTarget,
  type NotifyLevel,
  type NotifyTarget,
  payloadFor,
  readResult,
  type SendResult,
  sendWebhook,
  shouldNotify,
} from "./notify.js";
export { saveProcedure } from "./orderOfExecution.js";
export {
  type AgentTestCase,
  type AgentTestRun,
  type AgentTestsChange,
  type AgentTestsResult,
  agentTestsToMarkdown,
  noAgentTests,
  parseAgentTestsResult,
  readAgentTestResult,
  runAgentTests,
  selectAgentTests,
} from "./org/agentTests.js";
export { applyOrgContext, collectOrgContext, enrichWithOrg, GENERIC_ORG_LABEL } from "./org/enrich.js";
export { assertSafeOrg, createSfRunner, type SfCallOptions, SfError, type SfRunner } from "./org/sf.js";
export {
  type ComponentError,
  type OrgKind,
  readDeployResult,
  type TestOutcome,
  type ValidateTestsOptions,
  type ValidationResult,
  validateTests,
  validationToMarkdown,
} from "./org/validate.js";
export { classifyPath, loadProject, sourceRoots } from "./project.js";
export { detectAiTools, gitProvenance } from "./provenance.js";
export { toJunit } from "./report/junit.js";
export { toMarkdown } from "./report/markdown.js";
export { toSarif } from "./report/sarif.js";
export { RULES, ruleInfo } from "./rules.js";
export {
  type GeneratedFile,
  type GeneratedTest,
  generateTests,
  type SkippedTest,
  type TestGenOptions,
  type TestGenResult,
} from "./testgen/generate.js";
export { testsToMarkdown } from "./testgen/markdown.js";
export * from "./types.js";

export interface RunOptions {
  projectDir: string;
  /** Git base ref. Required unless `files` is given. */
  base?: string;
  /** Git head ref; defaults to the working tree. */
  head?: string;
  /** Explicit changed files (absolute, cwd-relative or project-relative). */
  files?: string[];
  /**
   * Unsaved editor text by file path (absolute or project-relative): analyzed instead of the file on
   * disk, and counted as changed.
   */
  overlay?: Record<string, string>;
  /** The files staged for the next commit, compared with HEAD (for a pre-commit hook). */
  staged?: boolean;
  /**
   * Report only new findings: "base" (compare with the base ref), a baseline file path (relative
   * to the working directory), or false to ignore the policy's baseline setting.
   */
  baseline?: string | false;
  /** The baseline to use when neither the option nor the policy sets one (the hook uses "base"). */
  defaultBaseline?: string;
  maxDepth?: number;
  /** Org alias or username already authorized with `sf org login`: adds read-only org context. */
  org?: string;
  /** Override how `sf` is invoked (tests). */
  sfRunner?: SfRunner;
  /**
   * `.preflight.json` to apply (rule overrides and ignores): a path, or false to ignore any.
   * By default the project directory and then the git root are searched.
   */
  config?: string | false;
  /** Read the policy from git at this ref (e.g. the pull request's base) instead of the checkout. */
  configRef?: string;
}

/** Load the project, work out what changed, and analyze it. */
export function run(opts: RunOptions): AnalysisResult {
  return analyzeChange(opts).result;
}

/** Like `run`, but also returns the parsed project (needed by test generation) and the policy used. */
export function analyzeChange(opts: RunOptions): { model: OrgModel; result: AnalysisResult; policy: PreflightConfig } {
  const projectDir = path.resolve(opts.projectDir);
  const overlay = new Map<string, string>();
  for (const [file, text] of Object.entries(opts.overlay ?? {})) {
    const rel = toPosix(path.relative(projectDir, path.resolve(projectDir, file)));
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) overlay.set(rel, text);
  }
  const model = loadProject(projectDir, { overlay });
  let changedFiles: { file: string; changeType: ChangeType; previousFile?: string }[];
  let partlyStaged: string[] = [];
  if (opts.staged) {
    const staged = gitStagedFiles(projectDir);
    changedFiles = staged.files;
    partlyStaged = staged.partlyStaged;
    if (hasHead(projectDir)) opts = { ...opts, base: "HEAD" };
  } else if (opts.files?.length) {
    changedFiles = filesFromArgs(projectDir, opts.files);
  } else if (opts.base) {
    changedFiles = gitChangedFiles({ projectDir, base: opts.base, head: opts.head });
  } else {
    throw new Error("Provide either --base <git ref> or --files <paths...>");
  }
  // Only package directories are Salesforce source: changes elsewhere in the project (generated
  // tests in preflight-tests/, scripts, docs) aren't deployed, so a git diff leaves them out.
  const outside: string[] = [];
  const outsideFiles: typeof changedFiles = [];
  if (!opts.files?.length) {
    const roots = sourceRoots(projectDir).map((r) => path.posix.normalize(r).replace(/\/$/, ""));
    if (!roots.includes(".")) {
      changedFiles = changedFiles.filter((f) => {
        const inside = roots.some((r) => f.file === r || f.file.startsWith(`${r}/`));
        if (!inside) {
          outside.push(f.file);
          outsideFiles.push(f);
        }
        return inside;
      });
    }
  }
  // Files edited in the editor but not saved are part of the change too.
  for (const rel of overlay.keys())
    if (!changedFiles.some((f) => f.file === rel)) changedFiles.push({ file: rel, changeType: "modified" });
  // Components deleted through a destructive manifest, which can sit outside the package directories.
  const destructive = destructiveChanges(projectDir, [...changedFiles, ...outsideFiles]);
  const parsed = toChanges(changedFiles);
  const notMetadata = parsed.ignored;
  const seen = new Set(parsed.changes.map((c) => `${c.component.type}|${c.component.name.toLowerCase()}`));
  const changes = [
    ...parsed.changes,
    ...destructive.changes.filter((c) => !seen.has(`${c.component.type}|${c.component.name.toLowerCase()}`)),
  ];
  const ignored = [...notMetadata, ...outside];
  const root = gitRoot(projectDir);
  const result = analyze({
    model,
    changes,
    ignoredFiles: ignored,
    base: opts.base,
    head: opts.head,
    maxDepth: opts.maxDepth,
    readBase: opts.base ? (file) => gitShow(projectDir, opts.base!, file) : undefined,
    provenance:
      opts.base && !opts.files?.length && !opts.staged ? gitProvenance(projectDir, opts.base, opts.head) : undefined,
  });
  if (destructive.changes.length) {
    // Point at the manifest that deletes each component, not the source path it would have.
    const real = (f: string) => destructive.manifestOf.get(f) ?? f;
    for (const f of result.findings) if (f.files) f.files = uniq(f.files.map(real));
    for (const c of result.changes) c.component = { ...c.component, file: real(c.component.file) };
  }
  if (destructive.warnings.length) result.warnings = [...result.warnings, ...destructive.warnings];
  if (partlyStaged.length)
    result.warnings = [
      ...result.warnings,
      `${partlyStaged.length} staged file(s) also have unstaged edits; checked as they are in the working tree: ${partlyStaged.slice(0, 5).join(", ")}${partlyStaged.length > 5 ? " ..." : ""}`,
    ];
  if (root) result.projectPathInRepo = toPosix(path.relative(root, projectDir));
  if (opts.org) enrichWithOrg(model, result, { org: opts.org, runner: opts.sfRunner });
  let final = result;
  let policyConfig: PreflightConfig = {};
  if (opts.config !== false) {
    const policy = loadPolicy(projectDir, { explicit: opts.config, ref: opts.configRef });
    if (policy.warning) result.warnings = [...result.warnings, policy.warning];
    if (policy.file) {
      final = applyConfig(result, policy.config);
      final.config = { file: policy.file, ref: policy.ref, sha256: policy.sha256 };
      policyConfig = policy.config;
    }
  }
  // Baseline: from the option, else the policy (a policy path is relative to the project).
  const baseline =
    opts.baseline === false
      ? undefined
      : (opts.baseline ??
        (policyConfig.baseline === undefined
          ? opts.defaultBaseline
          : policyConfig.baseline !== "base"
            ? path.join(projectDir, policyConfig.baseline)
            : policyConfig.baseline));
  if (baseline === "base") {
    if (opts.base) {
      final = applyBaseline(
        final,
        findingsAtRef(projectDir, opts.base, changes, policyConfig, opts.maxDepth),
        `base ref ${opts.base}`,
      );
    } else if (!opts.staged) {
      final.warnings = [
        ...final.warnings,
        'Baseline "base" needs a git base ref (--base or --staged); showing all findings.',
      ];
    }
  } else if (baseline) {
    final = applyBaseline(
      final,
      readBaselineFile(path.resolve(baseline)),
      toPosix(path.relative(projectDir, path.resolve(baseline))),
    );
  }
  return { model, result: final, policy: policyConfig };
}

/** Analyze a change and generate Apex tests for it. Nothing is written to disk. */
export function runTests(opts: RunOptions & TestGenOptions): { result: AnalysisResult; tests: TestGenResult } {
  const { model, result } = analyzeChange(opts);
  return { result, tests: generateTests(model, result, opts) };
}
