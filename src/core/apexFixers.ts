// SPDX-License-Identifier: Apache-2.0
import type { FixContext, ProposedFix } from "./fixers.js";
import { stripApex } from "./parsers/apex.js";

/**
 * Fix templates for Apex. Each edits the source as text, keeping the file's own formatting, and
 * proposes nothing when the code isn't in the shape the template understands; fix.ts then checks
 * every proposal by analyzing the fixed files again.
 */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- Remote Action classes that don't implement Callable ---------------------------------------

/** Method names that OmniStudio components call on `cls`, read from their settings. */
function remoteMethodsOf(cls: string, texts: string[]): string[] {
  const c = esc(cls);
  const found = new Set<string>();
  const patterns = [
    new RegExp(
      `"(?:remoteClass|className|apexClass)"\\s*:\\s*"${c}"[^{}]*?"(?:remoteMethod|methodName)"\\s*:\\s*"(\\w+)"`,
      "gi",
    ),
    new RegExp(
      `"(?:remoteMethod|methodName)"\\s*:\\s*"(\\w+)"[^{}]*?"(?:remoteClass|className|apexClass)"\\s*:\\s*"${c}"`,
      "gi",
    ),
  ];
  for (const text of texts) {
    const json = text.replace(/&quot;/g, '"');
    for (const re of patterns) for (const m of json.matchAll(re)) found.add(m[1]!);
  }
  return [...found];
}

/**
 * `implements System.Callable` with a `call` method that runs the methods the scripts name.
 * Only a method that takes one `Map<String, Object>` is dispatched to; the rest are listed in the
 * note, because their arguments need a person's decision.
 */
export function callableTemplate(ctx: FixContext): ProposedFix | undefined {
  const f = ctx.finding;
  const cls = f.title.split(" ")[0];
  if (!cls) return undefined;
  const file = f.files.find(
    (x) => x.toLowerCase().endsWith(`/${cls.toLowerCase()}.cls`) || x.toLowerCase() === `${cls.toLowerCase()}.cls`,
  );
  if (!file) return undefined;
  const before = ctx.read(file);
  if (before === undefined) return undefined;
  const code = stripApex(before);
  if (/\bcall\s*\(/i.test(code) || /\bExtensionMalformedCallException\b/.test(code)) return undefined;

  const head = new RegExp(`\\bclass\\s+${esc(cls)}\\b([^{]*)\\{`, "i").exec(code);
  if (!head) return undefined;
  const declEnd = head.index + head[0].length - 1; // the class's "{"
  const rest = head[1]!;
  const restStart = head.index + head[0].length - 1 - rest.length;
  const bare = rest.trimEnd();
  const gap = rest.slice(bare.length);
  const implementsAt = restStart + bare.length;
  const withInterface = /\bimplements\b/i.test(bare) ? `, System.Callable` : ` implements System.Callable`;

  const close = code.lastIndexOf("}");
  if (close < declEnd) return undefined;

  // One case per method the scripts call that is shaped for it.
  const called = remoteMethodsOf(
    cls,
    f.files.filter((x) => x !== file).map((x) => ctx.read(x) ?? ""),
  );
  const cases: string[] = [];
  const skipped: string[] = [];
  for (const name of called) {
    const sig = new RegExp(
      `([\\w.<>,\\[\\]]+)\\s+${esc(name)}\\s*\\(\\s*Map\\s*<\\s*String\\s*,\\s*Object\\s*>\\s+\\w+\\s*\\)\\s*\\{`,
      "i",
    ).exec(code);
    if (!sig) {
      skipped.push(name);
      continue;
    }
    cases.push(
      /^void$/i.test(sig[1]!)
        ? `            when '${name}' {\n                ${name}(args);\n                return null;\n            }`
        : `            when '${name}' {\n                return ${name}(args);\n            }`,
    );
  }
  if (!cases.length && called.length) {
    // Nothing to dispatch to: a skeleton that fails on every action isn't a fix.
    return undefined;
  }

  const nl = before.includes("\r\n") ? "\r\n" : "\n";
  const block = [
    "",
    "    /** Entry point for OmniStudio Remote Actions (System.Callable). */",
    "    public Object call(String action, Map<String, Object> args) {",
    "        switch on action {",
    ...cases,
    "            when else {",
    "                throw new ExtensionMalformedCallException('Method not implemented: ' + action);",
    "            }",
    "        }",
    "    }",
    "",
    "    public class ExtensionMalformedCallException extends Exception {}",
  ]
    .join("\n")
    .split("\n")
    .join(nl);

  // Insert the method before the class's closing brace, on its own lines.
  let lineStart = close;
  while (lineStart > 0 && before[lineStart - 1] !== "\n") lineStart--;
  const onOwnLine = before.slice(lineStart, close).trim() === "";
  const insertAt = onOwnLine ? lineStart : close;
  const body = onOwnLine ? block.slice(nl.length) + nl : block + nl;
  let after = before.slice(0, insertAt) + body + before.slice(insertAt);
  // The header goes in last: it comes earlier in the text, so the offsets above stay valid.
  after = after.slice(0, implementsAt) + withInterface + gap + after.slice(implementsAt + gap.length);
  if (after === before) return undefined;
  return {
    rule: f.rule,
    finding: f.title,
    label: `Make ${cls} callable from OmniStudio`,
    kind: "review",
    note: skipped.length
      ? `Not dispatched, because they don't take one Map<String, Object>: ${skipped.join(", ")}. Add a case for each.`
      : "Check that each method gets the arguments the script sends.",
    edits: [{ file, before, after }],
  };
}

// ---- DML in a loop ------------------------------------------------------------------------------

/** Index of the bracket matching the one at `open`, in code with comments and strings blanked. */
function matching(code: string, open: number, o: string, c: string): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === o) depth++;
    else if (code[i] === c && --depth === 0) return i;
  }
  return -1;
}

/**
 * Collect records in a list inside a `for (T x : items) { … update x; … }` loop and save the list
 * once after it. Only for the plain shape: the statement sits directly in the loop body, the
 * variable is used nowhere after it, and the loop has no `return`, `throw`, `break` or `try`.
 */
export function dmlOutOfLoop(ctx: FixContext): ProposedFix | undefined {
  const f = ctx.finding;
  const file = f.files[0];
  if (!file) return undefined;
  const before = ctx.read(file);
  if (before === undefined) return undefined;
  const code = stripApex(before);

  const dml = /(?<![\w.])(insert|update|delete|undelete)\s+([A-Za-z_]\w*)\s*;/gi;
  const loop = /\bfor\s*\(\s*([A-Za-z_][\w.<>,]*)\s+([A-Za-z_]\w*)\s*:\s*/gi;
  for (const lm of code.matchAll(loop)) {
    const [, type, variable] = lm as unknown as [string, string, string];
    const parenOpen = code.indexOf("(", lm.index!);
    const parenClose = matching(code, parenOpen, "(", ")");
    if (parenClose < 0) continue;
    const braceAt = code.slice(parenClose + 1).search(/\S/);
    const bodyOpen = parenClose + 1 + braceAt;
    if (braceAt < 0 || code[bodyOpen] !== "{") continue;
    const bodyClose = matching(code, bodyOpen, "{", "}");
    if (bodyClose < 0) continue;
    const body = code.slice(bodyOpen + 1, bodyClose);
    if (/\b(?:return|throw|break|try)\b/i.test(body)) continue;

    const statements = [...body.matchAll(dml)].filter((m) => m[2] === variable);
    if (statements.length !== 1) continue;
    const st = statements[0]!;
    // In the loop body, possibly inside an `if`, but not inside an inner loop.
    const prefix = body.slice(0, st.index!);
    const open: string[] = [];
    let last = 0;
    for (let i = 0; i < prefix.length; i++) {
      const ch = prefix[i];
      if (ch === "{") {
        open.push(prefix.slice(last, i));
        last = i + 1;
      } else if (ch === "}") {
        open.pop();
        last = i + 1;
      } else if (ch === ";") last = i + 1;
    }
    if (open.some((h) => /\b(?:for|while|do)\b/i.test(h))) continue;
    const after = body.slice(st.index! + st[0].length);
    if (new RegExp(`\\b${esc(variable)}\\b`).test(after)) continue;

    const op = st[1]!.toLowerCase();
    const listName = `${variable}${op[0]!.toUpperCase()}${op.slice(1)}List`.replace(/^(.)/, (c) => c.toLowerCase());
    if (new RegExp(`\\b${esc(listName)}\\b`).test(code)) continue;

    // The statement's own line(s) in the original text.
    const stAt = bodyOpen + 1 + st.index!;
    const stEnd = stAt + st[0].length;
    const nl = before.includes("\r\n") ? "\r\n" : "\n";

    // Where the loop starts and ends, for the declaration before it and the save after it.
    let loopLine = lm.index!;
    while (loopLine > 0 && before[loopLine - 1] !== "\n") loopLine--;
    const loopIndent = /^[ \t]*/.exec(before.slice(loopLine))?.[0] ?? "";
    const onLoopLine = before.slice(loopLine, lm.index!).trim() === "";
    if (!onLoopLine) continue;

    const edits: [number, number, string][] = [
      [loopLine, loopLine, `${loopIndent}List<${type}> ${listName} = new List<${type}>();${nl}`],
      [stAt, stEnd, `${listName}.add(${variable});`],
      [bodyClose + 1, bodyClose + 1, `${nl}${loopIndent}${op} ${listName};`],
    ];
    let text: string = before;
    for (const [a, b, s] of edits.sort((x, y) => y[0] - x[0])) text = text.slice(0, a) + s + text.slice(b);
    if (text === before) continue;
    return {
      rule: f.rule,
      finding: f.title,
      label: `Save the ${type} records once, after the loop`,
      kind: "review",
      note:
        op === "insert" || op === "update" || op === "delete" || op === "undelete"
          ? "One failing record now fails the whole save, and records are saved after the loop instead of one by one; check that nothing in the loop depends on an earlier save."
          : undefined,
      edits: [{ file, before, after: text }],
    };
  }
  return undefined;
}
