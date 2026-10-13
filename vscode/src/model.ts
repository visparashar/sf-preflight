// SPDX-License-Identifier: Apache-2.0
/**
 * What the extension shows, computed from an analysis result without the VS Code API, so it can
 * be tested on its own: problems per file, the blast-radius tree and the status bar text.
 */
import path from "node:path";
import type { AnalysisResult, Finding, SaveEvent, Severity } from "../../src/core/types.js";

export const RULES_URL = "https://github.com/visparashar/sf-preflight/blob/main/docs/RULES.md";
const ORDER: Severity[] = ["high", "medium", "low", "info"];
const rank = (s: Severity) => ORDER.indexOf(s);

export interface Problem {
  /** Absolute path of the file. */
  file: string;
  /** 0-based line. */
  line: number;
  severity: Severity;
  message: string;
  rule: string;
  /** Other files involved, for related information. */
  related: string[];
  /** The finding's title, to find the spot it is about (see `locate`). */
  title: string;
  /** The line came from the finding itself (an Apex statement), not a default. */
  exact: boolean;
}

export interface Span {
  line: number;
  start: number;
  end: number;
}

/** Names worth looking for in a file: API names and dotted paths from the finding's title, longest first. */
export function namesIn(title: string): string[] {
  const out = new Set<string>();
  for (const m of title.matchAll(/[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*/g)) {
    const t = m[0];
    for (const part of [t, ...t.split(".")]) {
      // Something that looks like an API name, not an English word.
      if (part.length >= 4 && (/_/.test(part) || /[a-z][A-Z]/.test(part) || /^[A-Z][a-z]+[A-Z]/.test(part)))
        out.add(part);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Where in a file a problem should be underlined: its own line when the finding gives one; else
 * the first place the file names something from the finding's title; else the file's first element.
 */
export function locate(text: string, p: Pick<Problem, "line" | "title" | "exact">): Span {
  const lines = text.split(/\r?\n/);
  const span = (line: number): Span => {
    const s = lines[line] ?? "";
    const start = s.length - s.trimStart().length;
    return { line, start, end: Math.max(start + 1, s.trimEnd().length) };
  };
  if (p.exact && p.line < lines.length) return span(p.line);
  for (const name of namesIn(p.title)) {
    const re = new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`);
    for (const [i, l] of lines.entries()) {
      const m = re.exec(l);
      if (m) return { line: i, start: m.index, end: m.index + name.length };
    }
  }
  const first = lines.findIndex((l) => l.trim() && !/^\s*<\?xml/.test(l));
  return span(first < 0 ? 0 : first);
}

/**
 * Findings as problems on their files: the primary file at the finding's line (or the top), and
 * each other file involved at its top. Findings below `minSeverity` are left out.
 */
export function problemsOf(result: AnalysisResult, minSeverity: Severity = "low"): Problem[] {
  const abs = (f: string) => path.resolve(result.projectDir, f);
  const out: Problem[] = [];
  for (const f of result.findings) {
    if (rank(f.severity) > rank(minSeverity) || !f.files.length) continue;
    const files = [...new Set(f.files)];
    for (const [i, file] of files.entries()) {
      out.push({
        file: abs(file),
        line: i === 0 && f.line ? Math.max(0, f.line - 1) : 0,
        severity: f.severity,
        message: messageOf(f),
        rule: f.rule,
        related: files.filter((x) => x !== file).map(abs),
        title: f.title,
        exact: i === 0 && !!f.line,
      });
    }
  }
  return out;
}

const messageOf = (f: Finding) => `${f.title}\n${f.detail}`.trim();

export interface TreeNode {
  label: string;
  description?: string;
  tooltip?: string;
  /** Codicon id, e.g. "error". */
  icon?: string;
  /** Absolute file to open, and 0-based line. */
  file?: string;
  line?: number;
  children?: TreeNode[];
  /** Expanded by default. */
  expanded?: boolean;
  /** Command run on click, when there's no file to open. */
  command?: string;
}

const SEVERITY_ICON: Record<Severity, string> = {
  high: "error",
  medium: "warning",
  low: "info",
  info: "circle-outline",
};
const CHANGE_ICON: Record<string, string> = {
  added: "diff-added",
  modified: "diff-modified",
  deleted: "diff-removed",
  renamed: "diff-renamed",
};
const AUTOMATION_ICON: Record<string, string> = {
  Flow: "type-hierarchy",
  ApexTrigger: "zap",
  ApexClass: "symbol-class",
  ValidationRule: "shield",
  RollUpSummary: "sum",
  Change: "edit",
};
const EVENT_LABEL: Record<SaveEvent, string> = {
  insert: "insert",
  update: "update",
  delete: "delete",
  undelete: "undelete",
};

/** The blast-radius tree for one project's analysis. */
export function treeOf(result: AnalysisResult, label?: string): TreeNode[] {
  const abs = (f: string) => path.resolve(result.projectDir, f);
  const s = result.summary;
  const counts = ORDER.filter((x) => s.findingsBySeverity[x])
    .map((x) => `${s.findingsBySeverity[x]} ${x}`)
    .join(", ");
  const nodes: TreeNode[] = [];
  nodes.push({
    label: `Risk: ${s.risk}`,
    description: [label, counts || "no findings"].filter(Boolean).join(" · "),
    icon: s.risk === "high" ? "error" : s.risk === "medium" ? "warning" : "pass",
    tooltip: `${s.changedComponents} changed component(s), ${s.impactedObjects} impacted object(s), ${s.automationsInvolved} automation(s) involved${result.base ? `, compared with ${result.base}` : ""}. Click for the graph.`,
    ...(result.changes.length ? { command: "sfPreflight.showGraph" } : {}),
  });

  if (!result.changes.length) {
    nodes.push({ label: "No Salesforce metadata changed", icon: "check" });
    return nodes;
  }

  const findings = [...result.findings].sort((a, b) => rank(a.severity) - rank(b.severity));
  if (findings.length) {
    nodes.push({
      label: "Findings",
      description: String(findings.length),
      icon: "checklist",
      expanded: true,
      children: findings.map((f) => ({
        label: f.title,
        description: f.rule,
        tooltip: `${f.severity.toUpperCase()}: ${f.detail}`,
        icon: SEVERITY_ICON[f.severity],
        ...(f.files[0] ? { file: abs(f.files[0]), line: f.line ? f.line - 1 : 0 } : {}),
      })),
    });
  }

  nodes.push({
    label: "Changed components",
    description: result.coverage
      ? `${result.changes.length} · ${result.coverage.deep} analyzed in depth`
      : String(result.changes.length),
    tooltip: result.coverage
      ? `${result.coverage.basic} of ${result.changes.length} are of types sf-preflight recognizes but does not analyze in depth yet (${result.coverage.basicByType.map((t) => `${t.type} ×${t.count}`).join(", ")}).`
      : undefined,
    icon: "git-commit",
    children: result.changes.map((c) => ({
      label: c.component.name,
      description: `${c.component.metadataType ?? c.component.type} · ${c.changeType}`,
      icon: CHANGE_ICON[c.changeType] ?? "file",
      ...(c.changeType === "deleted" ? {} : { file: abs(c.component.file), line: 0 }),
    })),
  });

  if (result.saveProcedures.length) {
    nodes.push({
      label: "What runs",
      description: `${result.saveProcedures.length} save(s)`,
      tooltip: "Each impacted object and event, with its automation in order of execution",
      icon: "run-all",
      expanded: true,
      children: result.saveProcedures.map((sp) => ({
        label: `${sp.object} ${EVENT_LABEL[sp.event]}`,
        description: `${sp.steps.length} step(s)`,
        icon: "database",
        children: sp.steps.map((st) => ({
          label: `${st.order}. ${st.automation.name}`,
          description: [st.phaseLabel, st.writes.length ? `writes ${st.writes.map((w) => w.object).join(", ")}` : ""]
            .filter(Boolean)
            .join(" · "),
          tooltip: st.notes.join("\n") || undefined,
          icon: AUTOMATION_ICON[st.automation.kind] ?? "symbol-event",
          ...(st.automation.file ? { file: abs(st.automation.file), line: 0 } : {}),
        })),
      })),
    });
  }

  if (result.cycles.length) {
    nodes.push({
      label: "Cycles",
      description: String(result.cycles.length),
      icon: "sync",
      children: result.cycles.map((c) => ({ label: c.join(" → "), icon: "warning" })),
    });
  }

  if (result.agents.length) {
    nodes.push({
      label: "Agent actions affected",
      description: String(result.agents.length),
      icon: "hubot",
      children: result.agents.map((a) => ({
        label: a.actionLabel ?? a.action,
        description: [a.agentLabel ?? a.agent, a.topic].filter(Boolean).join(" · "),
        tooltip: a.reasons.join("\n"),
        icon: "hubot",
      })),
    });
  }
  return nodes;
}

/** Status bar text for the analyses of all projects in the workspace. */
export function statusOf(results: AnalysisResult[]): {
  text: string;
  tooltip: string;
  level: "error" | "warning" | "ok";
} {
  if (!results.length) return { text: "$(shield) Preflight", tooltip: "sf-preflight", level: "ok" };
  const count = (s: Severity) => results.reduce((n, r) => n + (r.summary.findingsBySeverity[s] ?? 0), 0);
  const high = count("high");
  const medium = count("medium");
  const changed = results.reduce((n, r) => n + r.changes.length, 0);
  const level = high ? "error" : medium ? "warning" : "ok";
  const icon = level === "error" ? "$(error)" : level === "warning" ? "$(warning)" : "$(pass)";
  const text = !changed ? "$(shield) Preflight: no changes" : `${icon} Preflight: ${high} high, ${medium} medium`;
  const tooltip = `sf-preflight: ${changed} changed component(s). Click to open the risk dashboard.`;
  return { text, tooltip, level };
}

/** Is this file Salesforce source metadata worth re-analyzing on save? */
export function isMetadataFile(file: string): boolean {
  return /\.(cls|trigger|agent)$|-meta\.xml$|\.genAiPlannerBundle$|sfdx-project\.json$|\.preflight\.json$/.test(file);
}
