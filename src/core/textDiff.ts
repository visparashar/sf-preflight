// SPDX-License-Identifier: Apache-2.0

/**
 * A unified diff of two texts, for showing a proposed fix. The common start and end are skipped
 * first, so only the changed middle is compared line by line (fixes change a few lines of files
 * that can be thousands long).
 */
export function unifiedDiff(file: string, before: string, after: string, context = 3): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops = lineOps(midA, midB);

  const lines: { tag: " " | "-" | "+"; text: string; ai: number; bi: number }[] = [];
  for (let i = Math.max(0, start - context); i < start; i++) lines.push({ tag: " ", text: a[i]!, ai: i, bi: i });
  let ai = start;
  let bi = start;
  for (const op of ops) {
    if (op === "=") lines.push({ tag: " ", text: a[ai]!, ai: ai++, bi: bi++ });
    else if (op === "-") lines.push({ tag: "-", text: a[ai]!, ai: ai++, bi });
    else lines.push({ tag: "+", text: b[bi]!, ai, bi: bi++ });
  }
  for (let i = 0; i < context && endA + i < a.length; i++)
    lines.push({ tag: " ", text: a[endA + i]!, ai: endA + i, bi: endB + i });

  const aCount = lines.filter((l) => l.tag !== "+").length;
  const bCount = lines.filter((l) => l.tag !== "-").length;
  const first = lines[0];
  const aStart = first ? first.ai + 1 : 1;
  const bStart = first ? first.bi + 1 : 1;
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${aStart},${aCount} +${bStart},${bCount} @@`,
    ...lines.map((l) => `${l.tag}${l.text}`),
  ].join("\n");
}

/** Edit script between two short line lists (longest common subsequence). */
function lineOps(a: string[], b: string[]): ("=" | "-" | "+")[] {
  // Too large to compare cheaply: everything removed, then everything added.
  if (a.length * b.length > 4_000_000) return [...a.map(() => "-" as const), ...b.map(() => "+" as const)];
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: ("=" | "-" | "+")[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push("=");
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push("-");
      i++;
    } else {
      ops.push("+");
      j++;
    }
  }
  while (i++ < n) ops.push("-");
  while (j++ < m) ops.push("+");
  return ops;
}
