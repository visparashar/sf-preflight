// SPDX-License-Identifier: Apache-2.0
/**
 * The risk dashboard: an analysis result summed up as risk factors (recursion, rule collisions,
 * access, broken references, Agentforce, integrations, code and automation load), where the risk
 * sits, and how the findings changed over the recent analyses of a branch. Computed without the
 * VS Code API, so it can be tested on its own.
 */
import type { FailOn } from "../../src/core/config.js";
import { evaluateGate } from "../../src/core/gate.js";
import type { AnalysisResult, Severity } from "../../src/core/types.js";

export interface RiskFactor {
  id: string;
  label: string;
  /** What the factor means for the change, in a sentence. */
  meaning: string;
  rules: string[];
}

/**
 * Every rule belongs to one factor (or to OTHER_RULES); a test checks this against the rule catalog,
 * so a new rule can't be left out of the dashboard.
 */
export const RISK_FACTORS: RiskFactor[] = [
  {
    id: "recursion",
    label: "Recursion",
    meaning:
      "Saves that come back round to an object already being saved. They can double-apply or hit limits at bulk or agent volume.",
    rules: ["recursion-cycle", "after-save-self-update"],
  },
  {
    id: "collisions",
    label: "Rule collisions",
    meaning:
      "Automation that can fail on a validation or duplicate rule, and rules that now constrain existing automation.",
    rules: [
      "automated-write-vs-validation-rule",
      "field-used-by-validation-rule",
      "validation-rule-vs-existing-automation",
      "automated-write-vs-duplicate-rule",
      "save-rule-changed",
      "validation-rule-removed",
      "validation-rule-inactive",
    ],
  },
  {
    id: "access",
    label: "Access and sharing",
    meaning: "Permissions added or taken away, guest access, and sharing that opens up or tightens.",
    rules: [
      "permission-escalation",
      "permission-system",
      "permission-delete",
      "permission-field-edit",
      "permission-access-removed",
      "permission-group-changed",
      "guest-access",
      "sharing-model-opened",
      "sharing-model-restricted",
      "sharing-rule-changed",
    ],
  },
  {
    id: "references",
    label: "Broken references",
    meaning:
      "Things deleted or renamed that are still used, and pages, components and records that point at what changed.",
    rules: [
      "deleted-still-referenced",
      "deleted-still-named",
      "renamed-still-named",
      "missing-field-reference",
      "picklist-value-removed",
      "record-type-values-removed",
      "record-type-deactivated",
      "record-type-still-referenced",
      "label-removed-still-used",
      "cmdt-record-still-referenced",
      "cmdt-record-changed",
      "field-used-by-lightning",
      "apex-called-from-lightning",
      "lightning-missing-reference",
      "visualforce-missing-reference",
      "apex-used-by-page",
      "field-on-page",
      "lightning-on-page",
      "page-missing-reference",
      "page-element-removed",
    ],
  },
  {
    id: "agents",
    label: "Agentforce",
    meaning:
      "Agent actions the change reaches, whether Testing Center covers them, and the access their runtime user has.",
    rules: [
      "agent-metadata-changed",
      "agent-action-affected",
      "agent-action-untested",
      "agent-action-target-missing",
      "agent-runtime-access",
      "agent-runtime-overprivileged",
      "agent-action-no-confirmation",
    ],
  },
  {
    id: "integrations",
    label: "Integrations",
    meaning: "Endpoints, credentials, allowed sites, connected apps and platform events that other systems depend on.",
    rules: [
      "integration-endpoint-changed",
      "integration-insecure",
      "integration-allowlist-removed",
      "connected-app-access",
      "platform-event-contract",
    ],
  },
  {
    id: "omnistudio",
    label: "OmniStudio",
    meaning:
      "OmniScripts, Integration Procedures, Data Mappers and FlexCards the change reaches, and what they call that is missing or can't be called.",
    rules: [
      "omnistudio-remote-not-callable",
      "omnistudio-missing-reference",
      "omnistudio-inactive-in-use",
      "omnistudio-cycle",
      "omnistudio-used-by",
      "apex-called-from-omnistudio",
    ],
  },
  {
    id: "load",
    label: "Code and automation load",
    meaning:
      "DML or SOQL in loops, saves that ignore failed records, crowded objects, legacy and inactive automation, and automation only in the org.",
    rules: [
      "dml-or-soql-in-loop",
      "ignored-save-result",
      "automation-density",
      "multiple-triggers",
      "legacy-workflow",
      "flow-inactive",
      "org-only-automation",
    ],
  },
];

/** Rules that describe the analysis rather than a risk; shown under "Other" if they appear. */
export const OTHER_RULES = ["metadata-not-analyzed"];

const ORDER: Severity[] = ["high", "medium", "low", "info"];
const rank = (s?: Severity) => (s ? ORDER.indexOf(s) : ORDER.length);
const worse = (a: Severity | undefined, b: Severity) => (rank(b) < rank(a) ? b : a);

export interface DashboardFinding {
  /** Index into the result's findings; the panel opens the file from it. */
  key: number;
  title: string;
  severity: Severity;
  rule: string;
  object?: string;
  /** Project-relative file and 1-based line, for display. */
  file?: string;
  line?: number;
}

export interface FactorView {
  id: string;
  label: string;
  meaning: string;
  count: number;
  worst?: Severity;
  findings: DashboardFinding[];
}

export interface Hotspot {
  object: string;
  findings: number;
  worst?: Severity;
  /** Automation that runs when the object is saved. */
  automations: number;
  /** Recursion cycles the object is on. */
  cycles: number;
}

export interface DashboardModel {
  risk: AnalysisResult["summary"]["risk"];
  sentence: string;
  changed: number;
  counts: Record<Severity, number>;
  /** The gate's findings check, with the project's `failOn`; approvals and test runs are checked in the pipeline. */
  gate: { status: "pass" | "fail"; failOn: FailOn; label: string; detail: string };
  factors: FactorView[];
  hotspots: Hotspot[];
  agents: { affected: number; untested: number };
  base?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One plain sentence on how far the change reaches. */
export function reachSentence(r: AnalysisResult): string {
  const s = r.summary;
  if (!r.changes.length) return "No Salesforce metadata changed compared with the base.";
  let out = `${plural(r.changes.length, "changed component")} ${r.changes.length === 1 ? "reaches" : "reach"} ${plural(s.impactedObjects, "object")}`;
  if (s.automationsInvolved) out += ` through ${plural(s.automationsInvolved, "automation")}`;
  out += ".";
  if (s.cycles) out += ` The saves loop back in ${plural(s.cycles, "recursion cycle")}.`;
  if (r.agents.length)
    out += ` ${plural(r.agents.length, "Agentforce action")} ${r.agents.length === 1 ? "is" : "are"} affected.`;
  return out;
}

export function dashboardOf(result: AnalysisResult, failOn: FailOn = "high"): DashboardModel {
  const factorOf = new Map<string, string>();
  for (const f of RISK_FACTORS) for (const rule of f.rules) factorOf.set(rule, f.id);
  const views = new Map<string, FactorView>(
    RISK_FACTORS.map((f) => [f.id, { id: f.id, label: f.label, meaning: f.meaning, count: 0, findings: [] }]),
  );
  const other: FactorView = {
    id: "other",
    label: "Other",
    meaning: "Findings about the analysis itself, such as metadata it recognizes but doesn't analyze in depth.",
    count: 0,
    findings: [],
  };

  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const [key, f] of result.findings.entries()) {
    counts[f.severity]++;
    const view = views.get(factorOf.get(f.rule) ?? "") ?? other;
    view.count++;
    view.worst = worse(view.worst, f.severity);
    view.findings.push({
      key,
      title: f.title,
      severity: f.severity,
      rule: f.rule,
      ...(f.object ? { object: f.object } : {}),
      ...(f.files[0] ? { file: f.files[0] } : {}),
      ...(f.line ? { line: f.line } : {}),
    });
  }
  const factors = [...views.values(), ...(other.count ? [other] : [])];
  for (const v of factors) v.findings.sort((a, b) => rank(a.severity) - rank(b.severity));

  // Where the risk sits: objects by their worst finding, then how many, then how much runs on them.
  const spots = new Map<string, Hotspot>();
  const spot = (object: string) => {
    let s = spots.get(object);
    if (!s) {
      s = { object, findings: 0, automations: 0, cycles: 0 };
      spots.set(object, s);
    }
    return s;
  };
  for (const object of result.impactedObjects) spot(object);
  for (const f of result.findings) {
    if (!f.object) continue;
    const s = spot(f.object);
    s.findings++;
    s.worst = worse(s.worst, f.severity);
  }
  // Recursion findings name the cycle, not an object: each object on a cycle carries its severity.
  const cycleSeverity = result.findings
    .filter((f) => f.rule === "recursion-cycle")
    .reduce<Severity | undefined>((w, f) => worse(w, f.severity), undefined);
  for (const cycle of result.cycles) {
    for (const object of new Set(cycle.map((step) => step.split(" (")[0]!.trim()).filter(Boolean))) {
      const s = spot(object);
      s.cycles++;
      if (cycleSeverity) s.worst = worse(s.worst, cycleSeverity);
    }
  }
  const running = new Map<string, Set<string>>();
  for (const sp of result.saveProcedures) {
    const names = running.get(sp.object) ?? new Set<string>();
    for (const st of sp.steps) names.add(`${st.automation.kind}:${st.automation.name}`);
    running.set(sp.object, names);
  }
  for (const [object, names] of running) spot(object).automations = names.size;
  const hotspots = [...spots.values()]
    .filter((s) => s.findings || s.automations || s.cycles)
    .sort(
      (a, b) =>
        rank(a.worst) - rank(b.worst) ||
        b.cycles - a.cycles ||
        b.findings - a.findings ||
        b.automations - a.automations ||
        a.object.localeCompare(b.object),
    )
    .slice(0, 6);

  const check = evaluateGate({ result, config: { failOn } }).checks.find((c) => c.id === "findings")!;
  return {
    risk: result.summary.risk,
    sentence: reachSentence(result),
    changed: result.changes.length,
    counts,
    gate: { status: check.status, failOn, label: check.label, detail: check.detail },
    factors,
    hotspots,
    agents: { affected: result.agents.length, untested: result.agents.filter((a) => !a.tests.length).length },
    ...(result.base ? { base: result.base } : {}),
  };
}

// ---------------------------------------------------------------- history

export interface HistoryEntry {
  /** ISO time of the analysis. */
  at: string;
  risk: AnalysisResult["summary"]["risk"];
  high: number;
  medium: number;
  low: number;
  info: number;
  changed: number;
}

/** Analyses kept per project and branch. */
export const MAX_HISTORY = 30;

export function historyEntryOf(result: AnalysisResult, at = new Date().toISOString()): HistoryEntry {
  const c = result.summary.findingsBySeverity;
  return {
    at,
    risk: result.summary.risk,
    high: c.high ?? 0,
    medium: c.medium ?? 0,
    low: c.low ?? 0,
    info: c.info ?? 0,
    changed: result.changes.length,
  };
}

const same = (a: HistoryEntry, b: HistoryEntry) =>
  a.risk === b.risk &&
  a.high === b.high &&
  a.medium === b.medium &&
  a.low === b.low &&
  a.info === b.info &&
  a.changed === b.changed;

/**
 * Adds an analysis to a branch's history. Saving a file re-runs the analysis, so a run with the
 * same outcome as the last one isn't added again: each bar in the trend is a change in the risk.
 */
export function addToHistory(history: readonly HistoryEntry[], entry: HistoryEntry, max = MAX_HISTORY): HistoryEntry[] {
  const last = history.at(-1);
  if (last && same(last, entry)) return [...history];
  return [...history, entry].slice(-max);
}

/** Reads stored history, dropping anything malformed. */
export function readHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const n = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : undefined);
  return raw
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .flatMap((e): HistoryEntry[] => {
      const risk = e.risk;
      const at = typeof e.at === "string" ? e.at : undefined;
      const [high, medium, low, info, changed] = [n(e.high), n(e.medium), n(e.low), n(e.info), n(e.changed)];
      if (!at || (risk !== "high" && risk !== "medium" && risk !== "low")) return [];
      if ([high, medium, low, info, changed].some((v) => v === undefined)) return [];
      return [{ at, risk, high: high!, medium: medium!, low: low!, info: info!, changed: changed! }];
    })
    .slice(-MAX_HISTORY);
}
