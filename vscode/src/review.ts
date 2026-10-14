// SPDX-License-Identifier: Apache-2.0
/**
 * The model behind the Review tab: every finding of an analysis with its checked fix, what can be done
 * with it, and the save order around it. Computed without the VS Code API, so it can be tested on its own.
 * Findings are sent by key (their index in the result), never as file paths.
 */
import { CONDITION_RULES } from "../../src/core/baseline.js";
import type { FailOn } from "../../src/core/config.js";
import { type Fix, fixId } from "../../src/core/fix.js";
import type { AnalysisResult, Finding, SaveProcedure, Severity } from "../../src/core/types.js";
import { type DashboardModel, dashboardOf, RISK_FACTORS } from "./dashboard.js";

export interface ReviewFix {
  id: string;
  label: string;
  kind: "safe" | "undo" | "review";
  note?: string;
  /** Unified diff of every edit. */
  diff: string;
  alsoReports: string[];
  files: string[];
}

export interface ReviewFinding {
  key: number;
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
  object?: string;
  /** Project-relative. */
  files: string[];
  line?: number;
  factor: string;
  fix?: ReviewFix;
  /** A finding about the org's state, which can be accepted into the baseline. */
  canAccept: boolean;
  canTest: boolean;
}

export interface ReviewModel {
  risk: DashboardModel["risk"];
  sentence: string;
  counts: Record<Severity, number>;
  gate: DashboardModel["gate"];
  changed: boolean;
  factors: { id: string; label: string }[];
  findings: ReviewFinding[];
  /** Fixes are still being checked: they arrive in a second message. */
  fixesPending: boolean;
  /** Fixes that can be applied together without asking. */
  safeFixes: number;
}

const TEST_RULES = new Set(["recursion-cycle", "automated-write-vs-validation-rule", "dml-or-soql-in-loop"]);

export const reviewFixOf = (fix: Fix): ReviewFix => ({
  id: fix.id,
  label: fix.label,
  kind: fix.kind,
  ...(fix.note ? { note: fix.note } : {}),
  diff: fix.diff,
  alsoReports: fix.alsoReports,
  files: fix.edits.map((e) => e.file),
});

/** The safe fixes that touch files no other chosen fix touches, in finding order. */
export function independentSafeFixes(fixes: Fix[]): { apply: Fix[]; later: Fix[] } {
  const taken = new Set<string>();
  const apply: Fix[] = [];
  const later: Fix[] = [];
  for (const fix of fixes) {
    if (fix.kind !== "safe") continue;
    const files = fix.edits.map((e) => e.file);
    if (files.some((f) => taken.has(f))) {
      later.push(fix);
      continue;
    }
    for (const f of files) taken.add(f);
    apply.push(fix);
  }
  return { apply, later };
}

export function reviewOf(result: AnalysisResult, failOn: FailOn | undefined, fixes: Fix[] | undefined): ReviewModel {
  const dash = dashboardOf(result, failOn);
  const factorOf = new Map<string, string>();
  for (const f of RISK_FACTORS) for (const rule of f.rules) factorOf.set(rule, f.id);
  const byId = new Map((fixes ?? []).map((f) => [f.id, f]));
  const findings: ReviewFinding[] = result.findings.map((f: Finding, key) => {
    const fix = byId.get(fixId({ rule: f.rule, title: f.title }));
    return {
      key,
      rule: f.rule,
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      ...(f.object ? { object: f.object } : {}),
      files: f.files,
      ...(f.line ? { line: f.line } : {}),
      factor: factorOf.get(f.rule) ?? "other",
      ...(fix ? { fix: reviewFixOf(fix) } : {}),
      canAccept: CONDITION_RULES.has(f.rule),
      canTest: TEST_RULES.has(f.rule),
    };
  });
  return {
    risk: dash.risk,
    sentence: dash.sentence,
    counts: dash.counts,
    gate: dash.gate,
    changed: dash.changed > 0,
    factors: [...RISK_FACTORS.map((f) => ({ id: f.id, label: f.label })), { id: "other", label: "Other" }],
    findings,
    fixesPending: fixes === undefined,
    safeFixes: independentSafeFixes(fixes ?? []).apply.length,
  };
}

export interface SaveOrderStep {
  order: number;
  phase: string;
  name: string;
  kind: string;
  notes: string[];
  writes: string[];
  /** The step the finding is about. */
  hit: boolean;
}

/** The steps of a save order, with the ones the finding names marked. */
export function saveOrderOf(procedure: SaveProcedure, finding: Pick<Finding, "title" | "detail" | "files">) {
  const text = `${finding.title}\n${finding.detail}`;
  const files = finding.files.map((f) => f.toLowerCase());
  const steps: SaveOrderStep[] = procedure.steps.map((s) => {
    const name = s.automation.name;
    const named =
      name.length > 2 && new RegExp(`(^|[^\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`).test(text);
    const inFile = s.automation.file !== undefined && files.includes(s.automation.file.toLowerCase());
    return {
      order: s.order,
      phase: s.phaseLabel,
      name,
      kind: s.automation.kind,
      notes: s.notes,
      writes: s.writes.map((w) => `${w.object} (${w.op})`),
      hit: named || inFile,
    };
  });
  return { object: procedure.object, event: procedure.event, steps };
}
