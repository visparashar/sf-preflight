// SPDX-License-Identifier: Apache-2.0
import type { Fix } from "./fix.js";

/**
 * A fix as a pull request "suggested change": a replacement for a run of lines in one file, which
 * the author can apply with one click. Only a fix that edits one file can be offered this way (the
 * parts of a multi-file fix would be applied separately).
 */
export interface Suggestion {
  id: string;
  rule: string;
  kind: Fix["kind"];
  label: string;
  /** The finding it fixes (its title). */
  finding: string;
  note?: string;
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** The lines being replaced, so the caller can check the pull request has them unchanged. */
  current: string[];
  /** The lines that replace them (empty to delete). */
  replacement: string[];
}

export function suggestionFor(fix: Fix): Suggestion | undefined {
  if (fix.edits.length !== 1) return undefined;
  const edit = fix.edits[0]!;
  if (edit.before.includes("\r") || edit.after.includes("\r")) return undefined;
  const a = edit.before.split("\n");
  const b = edit.after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  let from = start;
  let to = endA;
  let replacement = b.slice(start, endB);
  if (to === from) {
    // Only lines were added: a suggestion must replace a line, so replace a neighbor with itself plus them.
    if (from < a.length) {
      replacement = [...replacement, a[from]!];
      to = from + 1;
    } else if (from > 0) {
      replacement = [a[from - 1]!, ...replacement];
      from -= 1;
    } else return undefined;
  }
  if (to > a.length || (to === a.length && a[to - 1] === "")) return undefined;
  return {
    id: fix.id,
    rule: fix.rule,
    kind: fix.kind,
    label: fix.label,
    finding: fix.finding,
    note: fix.note,
    path: edit.file,
    startLine: from + 1,
    endLine: to,
    current: a.slice(from, to),
    replacement,
  };
}

/** Suggestions for the fixes that can be one; the rest need `preflight fix`. */
export function suggestionsFor(fixes: Fix[]): { suggestions: Suggestion[]; skipped: string[] } {
  const suggestions: Suggestion[] = [];
  const skipped: string[] = [];
  for (const fix of fixes) {
    const s = suggestionFor(fix);
    if (s) suggestions.push(s);
    else skipped.push(fix.id);
  }
  return { suggestions, skipped };
}
