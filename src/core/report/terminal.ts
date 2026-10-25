// SPDX-License-Identifier: Apache-2.0
import type { AnalysisResult, CascadeNode, Finding, Severity } from "../types.js";

/** How to draw the terminal report. */
export interface TerminalOptions {
  /** Use ANSI colors (default: false). */
  color?: boolean;
  /** Line width to wrap details at (default 100). */
  width?: number;
  /** Most findings to list before pointing to the full report (default 15). */
  maxFindings?: number;
  /** Which findings show their details: "high" (default) or "all". */
  details?: "high" | "all";
  /** Options to repeat in the suggested next commands, e.g. `--base develop`. */
  nextArgs?: string;
}

const ANSI = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, cyan: 36 } as const;
type Style = keyof typeof ANSI;

/** Wrap `text` to `width` columns, every line starting with `indent`. */
export function wrapText(text: string, width: number, indent: string): string[] {
  const room = Math.max(20, width - indent.length);
  const lines: string[] = [];
  let line = "";
  for (const word of text
    .replace(/[ \t\r\n]+/g, " ")
    .trim()
    .split(" ")) {
    if (line && line.length + 1 + word.length > room) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(indent + line);
  return lines;
}

const VIA: Record<string, string> = {
  Flow: "flow",
  ApexTrigger: "trigger",
  ApexClass: "class",
  RollUpSummary: "roll-up",
};

function cascadeLines(node: CascadeNode, prefix: string, isLast: boolean, isRoot: boolean, out: string[]): void {
  const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
  const via =
    !isRoot && node.via && node.via.kind !== "Change"
      ? `${VIA[node.via.kind] ?? node.via.kind} ${node.via.name} → `
      : "";
  const flags = `${node.cycle ? "  ⟲ cycle" : ""}${node.async ? "  ⇢ runs later (platform event)" : ""}${node.truncated ? "  … (depth limit)" : ""}`;
  const rootNote = isRoot && node.via ? `   [changed: ${node.via.name}]` : "";
  out.push(`${prefix}${connector}${via}${node.object} (${node.event})${flags}${rootNote}`);
  const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
  node.children.forEach((c, i) => {
    cascadeLines(c, childPrefix, i === node.children.length - 1, false, out);
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A report for a person at a terminal: the risk, what to look at first and what to do next, in
 * short lines. The Markdown report (for pull requests) has every table; this one points to it.
 */
export function toTerminal(result: AnalysisResult, opts: TerminalOptions = {}): string {
  const paint = (style: Style, s: string) => (opts.color ? `\x1b[${ANSI[style]}m${s}\x1b[0m` : s);
  const width = opts.width ?? 100;
  const maxFindings = opts.maxFindings ?? 15;
  const s = result.summary;
  const out: string[] = [];
  const heading = (title: string) => out.push("", paint("bold", title));

  const riskColor: Record<string, Style> = { high: "red", medium: "yellow", low: "green" };
  out.push(
    `${paint("bold", "sf-preflight")}  ${paint(riskColor[s.risk] ?? "bold", paint("bold", `${s.risk.toUpperCase()} risk`))}`,
  );
  if (result.base) out.push(paint("dim", `Compared ${result.base} → ${result.head ?? "working tree"}`));
  out.push(
    `${plural(s.changedComponents, "changed component")} → ${plural(s.impactedObjects, "impacted object")} · ${plural(s.automationsInvolved, "automation")} · ${plural(s.cycles, "cycle")}`,
  );
  if (result.provenance?.aiAssistedCommits) {
    const p = result.provenance;
    out.push(
      paint("cyan", `${p.aiAssistedCommits} of ${plural(p.commits, "commit")} AI-assisted (${p.tools.join(", ")})`),
    );
  }
  if (result.baseline?.hidden) {
    out.push(paint("dim", `${plural(result.baseline.hidden, "finding")} already there before this change not shown`));
  }

  // Warnings first: they say when the report may not be telling the whole story.
  if (result.warnings.length) {
    heading(paint("yellow", "Warnings"));
    for (const w of result.warnings) out.push(...wrapText(w, width, "  ").map((l, i) => (i ? l : `! ${l.slice(2)}`)));
  }

  if (result.gate) {
    const g = result.gate;
    heading(`Quality gate: ${g.status === "pass" ? paint("green", "passed") : paint("red", "failed")}`);
    for (const c of g.checks.filter((c) => c.status === "fail")) {
      out.push(`  ${paint("red", "✗")} ${c.label}`, ...wrapText(c.detail, width, "    ").map((l) => paint("dim", l)));
    }
  }

  heading("Changed");
  if (!result.changes.length) out.push("  No Salesforce metadata changes found.");
  for (const c of result.changes.slice(0, 20)) {
    out.push(`  ${c.changeType.padEnd(9)} ${c.component.name} ${paint("dim", `(${c.component.type})`)}`);
  }
  if (result.changes.length > 20) out.push(paint("dim", `  …and ${result.changes.length - 20} more`));

  const bySev = s.findingsBySeverity;
  heading(`Findings  ${paint("dim", `${bySev.high} high · ${bySev.medium} medium · ${bySev.low} low`)}`);
  if (!result.findings.length) out.push(`  ${paint("green", "None.")}`);
  const sevStyle: Record<Severity, Style> = { high: "red", medium: "yellow", low: "cyan", info: "dim" };
  const shown: Finding[] = result.findings.slice(0, maxFindings);
  for (const f of shown) {
    const label = `  ${paint(sevStyle[f.severity], paint("bold", f.severity.toUpperCase().padEnd(7)))} `;
    out.push(...wrapText(f.title, width, " ".repeat(10)).map((l, i) => (i ? l : label + l.slice(10))));
    // The why and the fix for high findings; the rest are one line each (all details: --format md).
    if (f.severity === "high" || opts.details === "all")
      out.push(...wrapText(f.detail, width, "          ").map((l) => paint("dim", l)));
    const file = f.files[0];
    if (file) out.push(paint("dim", `          ${file}${f.line ? `:${f.line}` : ""}`));
  }
  if (result.findings.length > maxFindings) {
    out.push(paint("dim", `  …and ${result.findings.length - maxFindings} more (see --format md or json)`));
  }

  if (result.agents?.length) {
    heading("Agent actions");
    for (const a of result.agents) {
      const action = `${a.agentLabel ?? a.agent} › ${a.topic ? `${a.topic} › ` : ""}${a.actionLabel ?? a.action}`;
      const tested = a.tests.length ? paint("green", "tested") : paint("yellow", "not tested");
      out.push(`  ${action}  ${tested}`);
    }
  }

  if (result.cascade.length) {
    heading("Cascade");
    const lines: string[] = [];
    for (const root of result.cascade) cascadeLines(root, "", true, true, lines);
    out.push(...lines.map((l) => `  ${l.replace(/⟲ cycle/g, paint("red", "⟲ cycle"))}`));
  }

  if (result.suggestedTests.length) {
    const kinds = new Map<string, number>();
    for (const t of result.suggestedTests) kinds.set(t.kind, (kinds.get(t.kind) ?? 0) + 1);
    heading(`Suggested tests  ${paint("dim", `${result.suggestedTests.length}`)}`);
    out.push(...wrapText([...kinds].map(([k, n]) => (n > 1 ? `${k}\u00a0×${n}` : k)).join(" · "), width, "  "));
  }

  heading("Next");
  const next: [string, string][] = [];
  if (result.findings.length) next.push(["preflight fix", "propose checked fixes for these findings"]);
  if (result.suggestedTests.length) next.push(["preflight tests", "write the Apex tests for this change"]);
  next.push(["preflight analyze --format md", "the full report for a pull request"]);
  const extra = opts.nextArgs ? ` ${opts.nextArgs}` : "";
  for (const n of next) n[0] = n[0].replace(/^(preflight \S+)/, `$1${extra}`);
  const pad = Math.max(...next.map(([c]) => c.length)) + 2;
  for (const [cmd, why] of next) out.push(`  ${paint("cyan", cmd.padEnd(pad))}${paint("dim", why)}`);
  return out.join("\n");
}
