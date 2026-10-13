// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyze, summarizeFindings } from "./analyze.js";
import { assertSafeRef, git, gitRoot } from "./changes.js";
import { applyConfig, type PreflightConfig } from "./config.js";
import { classifyPath, loadProject } from "./project.js";
import type { AnalysisResult, Change, Finding } from "./types.js";
import { toPosix } from "./util.js";

/**
 * Baseline: report only the findings a change introduces, not those the org already had.
 *
 * Two sources of "already had":
 *  - "base": the same components analyzed as they are at the base ref. A finding that appears there
 *    too (same rule, same wording) was not caused by this change.
 *  - a baseline file (`preflight baseline`): a reviewed list of accepted findings, kept in git.
 *
 * Hidden findings are counted in the report, never silently dropped.
 */

export interface BaselineInfo {
  /** "base ref <ref>" or the baseline file. */
  source: string;
  /** Findings hidden because they were already there. */
  hidden: number;
}

/**
 * Findings that describe a state the org can already be in (a cycle, DML in a loop, an untested
 * agent action, a page naming a missing field). Only these can be "already there". Findings about the
 * effect of the change itself (a field it touches is used by a rule, something it deletes is still
 * referenced, access it grants or removes) are always shown.
 */
export const CONDITION_RULES: ReadonlySet<string> = new Set([
  "recursion-cycle",
  "automated-write-vs-validation-rule",
  "automated-write-vs-duplicate-rule",
  "after-save-self-update",
  "automation-density",
  "multiple-triggers",
  "dml-or-soql-in-loop",
  "permission-escalation",
  "permission-system",
  "permission-delete",
  "validation-rule-inactive",
  "flow-inactive",
  "org-only-automation",
  "agent-action-untested",
  "agent-action-target-missing",
  "agent-runtime-access",
  "agent-runtime-overprivileged",
  "agent-action-no-confirmation",
  "legacy-workflow",
  "lightning-missing-reference",
  "visualforce-missing-reference",
  "page-missing-reference",
  "missing-field-reference",
  "integration-insecure",
]);

/** What identifies a finding across runs: its rule and its wording. */
export const fingerprint = (f: Pick<Finding, "rule" | "title">) =>
  `${f.rule}|${f.title.replace(/\s+/g, " ").trim().toLowerCase()}`;

/** Keep only findings not in `known`; record how many were hidden. */
export function applyBaseline(result: AnalysisResult, known: Set<string>, source: string): AnalysisResult {
  const kept = result.findings.filter((f) => !CONDITION_RULES.has(f.rule) || !known.has(fingerprint(f)));
  const s = summarizeFindings(kept);
  return {
    ...result,
    findings: s.findings,
    summary: { ...result.summary, risk: s.risk, findingsBySeverity: s.findingsBySeverity },
    baseline: { source, hidden: result.findings.length - kept.length },
  };
}

/** Extract the project as it is at `ref` into a temporary folder. Returns the project's path there. */
function checkoutRef(projectDir: string, ref: string): { dir: string; cleanup: () => void } {
  assertSafeRef(ref, "baseline ref");
  const root = gitRoot(projectDir);
  if (!root) throw new Error(`Not a git repository: ${projectDir}`);
  const rel = toPosix(path.relative(root, path.resolve(projectDir))) || ".";
  const tmp = mkdtempSync(path.join(tmpdir(), "preflight-baseline-"));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  try {
    const tar = path.join(tmp, "base.tar");
    git(root, ["archive", "--format=tar", "-o", tar, ref, "--", rel]);
    execFileSync("tar", ["-xf", tar, "-C", tmp], { stdio: "ignore" });
    rmSync(tar);
    return { dir: path.join(tmp, rel), cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** The same changed components, as they were at the base ref (added ones didn't exist yet). */
function changesAtBase(changes: Change[]): Change[] {
  const out: Change[] = [];
  for (const c of changes) {
    if (c.changeType === "added" || c.manifest) continue;
    if (c.changeType === "renamed" && c.previousFile) {
      const before = classifyPath(c.previousFile);
      if (before.type !== "Other") out.push({ changeType: "modified", component: before });
      continue;
    }
    out.push({ changeType: "modified", component: c.component });
  }
  return out;
}

/** Fingerprints of the findings the changed components already had at `ref`. */
export function findingsAtRef(
  projectDir: string,
  ref: string,
  changes: Change[],
  policy: PreflightConfig,
  maxDepth?: number,
): Set<string> {
  const atBase = changesAtBase(changes);
  if (!atBase.length) return new Set();
  const { dir, cleanup } = checkoutRef(projectDir, ref);
  try {
    // The base copy shares the project's parse cache: almost every file is the same, so it is fast.
    const model = loadProject(dir, { cacheKey: path.resolve(projectDir) });
    const result = applyConfig(analyze({ model, changes: atBase, maxDepth }), policy);
    return new Set(result.findings.map(fingerprint));
  } finally {
    cleanup();
  }
}

// ---- Baseline files ------------------------------------------------------------------------

export const BASELINE_FILE = ".preflight-baseline.json";

interface BaselineFile {
  version: 1;
  /** Findings accepted as known; new ones are reported. */
  findings: { rule: string; title: string }[];
}

export function readBaselineFile(file: string): Set<string> {
  let json: BaselineFile;
  try {
    json = JSON.parse(readFileSync(file, "utf8")) as BaselineFile;
  } catch (err) {
    throw new Error(`Cannot read baseline ${file}: ${(err as Error).message}`);
  }
  if (json?.version !== 1 || !Array.isArray(json.findings)) throw new Error(`${file} is not an sf-preflight baseline.`);
  return new Set(
    json.findings.filter((f) => typeof f?.rule === "string" && typeof f?.title === "string").map(fingerprint),
  );
}

/** Write the findings of a whole-project analysis as the accepted baseline. */
export function writeBaselineFile(file: string, findings: Finding[]): number {
  const seen = new Set<string>();
  const entries = findings
    .filter((f) => CONDITION_RULES.has(f.rule))
    .filter((f) => {
      const k = fingerprint(f);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((f) => ({ rule: f.rule, severity: f.severity, title: f.title }))
    .sort((a, b) => a.rule.localeCompare(b.rule) || a.title.localeCompare(b.title));
  writeFileSync(file, `${JSON.stringify({ version: 1, findings: entries }, null, 2)}\n`);
  return entries.length;
}

/** Every metadata file in the project, as if all were changed (to record a baseline). */
export function wholeProjectChanges(projectDir: string): Change[] {
  const model = loadProject(projectDir);
  const changes: Change[] = [];
  const seen = new Set<string>();
  for (const c of model.components.values()) {
    if (c.type === "Other") continue;
    const k = `${c.type}|${c.metadataType ?? ""}|${c.name.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    changes.push({ changeType: "modified", component: c });
  }
  return changes;
}

export type AcceptResult =
  | { status: "added" | "present"; baselineFile: string; policyUpdated: boolean }
  | { status: "base" }
  | { status: "not-a-condition" };

/**
 * Accept one finding as known: add it to the project's baseline file, creating the file (and the
 * policy's `"baseline"` setting) when there is none. With `"baseline": "base"` nothing is needed: findings
 * already there are hidden anyway. Only findings about the org's state can be accepted.
 */
export function acceptIntoBaseline(
  projectDir: string,
  finding: Pick<Finding, "rule" | "title" | "severity">,
): AcceptResult {
  if (!CONDITION_RULES.has(finding.rule)) return { status: "not-a-condition" };
  const policyFile = path.join(projectDir, ".preflight.json");
  let policy: Record<string, unknown> = {};
  try {
    policy = JSON.parse(readFileSync(policyFile, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`Cannot read ${policyFile}: ${(err as Error).message}`);
  }
  if (policy.baseline === "base") return { status: "base" };
  const rel = typeof policy.baseline === "string" ? policy.baseline : BASELINE_FILE;
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes(".."))
    throw new Error(`"baseline" must be a path inside the project.`);
  const file = path.join(projectDir, rel);
  let data: { version: 1; findings: { rule: string; severity?: string; title: string }[] } = {
    version: 1,
    findings: [],
  };
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
    if (data?.version !== 1 || !Array.isArray(data.findings)) throw new Error("not an sf-preflight baseline");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`Cannot read ${file}: ${(err as Error).message}`);
  }
  const known = new Set(data.findings.map(fingerprint));
  const present = known.has(fingerprint(finding));
  if (!present) {
    data.findings.push({ rule: finding.rule, severity: finding.severity, title: finding.title });
    data.findings.sort((a, b) => a.rule.localeCompare(b.rule) || a.title.localeCompare(b.title));
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  }
  let policyUpdated = false;
  if (typeof policy.baseline !== "string") {
    policy.baseline = rel;
    writeFileSync(policyFile, `${JSON.stringify(policy, null, 2)}\n`);
    policyUpdated = true;
  }
  return { status: present ? "present" : "added", baselineFile: rel, policyUpdated };
}
