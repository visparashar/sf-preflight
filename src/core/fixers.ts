// SPDX-License-Identifier: Apache-2.0
import { classifyPath } from "./project.js";
import { namesOf, referencePatterns } from "./references.js";
import type { AnalysisResult, Finding } from "./types.js";
import { key } from "./util.js";

/**
 * Fixes for findings, as text edits of the project's files. Each fixer handles one kind of finding
 * and returns nothing when it can't be sure what to change. Fixes are only proposals: fix.ts checks
 * each one by analyzing the fixed files again before anyone sees it.
 *
 * Kinds:
 *  - "safe": one right answer that keeps what the change was for (use https, require confirmation).
 *  - "undo": puts one part of the change back as it was on the base branch (a permission, a sharing
 *    default, removed picklist values). Exact, but it reverses something someone chose to do.
 *  - "review": mechanical, but worth reading (references updated by name).
 */

export type FixKind = "safe" | "undo" | "review";

export interface FixEdit {
  /** Project-relative path. */
  file: string;
  before: string;
  after: string;
}

export interface ProposedFix {
  rule: string;
  /** The finding it fixes (its title). */
  finding: string;
  label: string;
  kind: FixKind;
  /** Something to know before applying it. */
  note?: string;
  edits: FixEdit[];
}

export interface FixContext {
  finding: Finding;
  result: AnalysisResult;
  /** A project file as it is now (with unsaved editor text), or undefined. */
  read(file: string): string | undefined;
  /** A project file at the base ref, or undefined (no base, or the file is new). */
  readBase(file: string): string | undefined;
}

type Fixer = (ctx: FixContext) => ProposedFix | undefined;

// ---- XML text helpers: edit in place, keeping the file's own formatting -----------------------

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Block {
  start: number;
  end: number;
  text: string;
}

/** Every `<tag>…</tag>` element (not nested in itself), in order. */
export function blocks(xml: string, tag: string): Block[] {
  const re = new RegExp(`<${esc(tag)}>[\\s\\S]*?</${esc(tag)}>`, "g");
  return [...xml.matchAll(re)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, text: m[0] }));
}

/** The text of a child element, trimmed. */
export function childText(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${esc(tag)}>([\\s\\S]*?)</${esc(tag)}>`).exec(block);
  return m ? m[1]!.trim() : undefined;
}

/** Set a child element's value, adding the element (after the opening tag) when it is missing. */
export function setChild(block: string, outer: string, tag: string, value: string): string {
  const re = new RegExp(`(<${esc(tag)}>)[\\s\\S]*?(</${esc(tag)}>)`);
  if (re.test(block)) return block.replace(re, `$1${value}$2`);
  const open = new RegExp(`<${esc(outer)}(\\s[^>]*)?>`).exec(block);
  if (!open) return block;
  const indent = /\n([ \t]+)</.exec(block.slice(open.index + open[0].length))?.[1] ?? "    ";
  const at = open.index + open[0].length;
  return `${block.slice(0, at)}\n${indent}<${tag}>${value}</${tag}>${block.slice(at)}`;
}

const splice = (s: string, b: Block, text: string) => s.slice(0, b.start) + text + s.slice(b.end);

/** Remove a block together with the whitespace before it on its line. */
function removeBlock(s: string, b: Block): string {
  let start = b.start;
  while (start > 0 && (s[start - 1] === " " || s[start - 1] === "\t")) start--;
  if (start > 0 && s[start - 1] === "\n") start--;
  return s.slice(0, start) + s.slice(b.end);
}

const single = (
  ctx: FixContext,
  rule: string,
  label: string,
  kind: FixKind,
  file: string,
  after: string,
  note?: string,
) => {
  const before = ctx.read(file);
  if (before === undefined || before === after) return undefined;
  return { rule, finding: ctx.finding.title, label, kind, note, edits: [{ file, before, after }] };
};

// ---- Integrations ------------------------------------------------------------------------------

const toHttps = (xml: string, tags: string[]) =>
  xml.replace(new RegExp(`(<(?:${tags.join("|")})>\\s*)http://`, "gi"), "$1https://");

const insecureIntegration: Fixer = (ctx) => {
  const f = ctx.finding;
  const file = f.files?.[0];
  if (!file) return undefined;
  const xml = ctx.read(file);
  if (xml === undefined) return undefined;
  if (/^Named credential \S+ sends callouts over plain http/.test(f.title))
    return single(
      ctx,
      f.rule,
      "Use https for the named credential",
      "safe",
      file,
      toHttps(xml, ["endpoint", "parameterValue"]),
      "Check that the service answers on https.",
    );
  if (/^(Remote site setting|CSP trusted site) \S+ allows callouts over plain http/.test(f.title)) {
    let after = xml.replace(/(<disableProtocolSecurity>)\s*true\s*(<\/disableProtocolSecurity>)/i, "$1false$2");
    after = toHttps(after, ["url", "endpointUrl"]);
    return single(
      ctx,
      f.rule,
      "Turn protocol security back on and use https",
      "safe",
      file,
      after,
      "Check that the host answers on https.",
    );
  }
  if (/^Connected app \S+ has its consumer secret in source control/.test(f.title)) {
    const b = blocks(xml, "consumerSecret")[0];
    if (!b) return undefined;
    return single(
      ctx,
      f.rule,
      "Remove the consumer secret from the file",
      "safe",
      file,
      removeBlock(xml, b),
      "The secret is still in the repository's history: rotate it in the org.",
    );
  }
  const outbound = /^Outbound message (\S+) (sends a session ID|posts to plain http)/.exec(f.title);
  if (outbound) {
    const b = blocks(xml, "outboundMessages").find(
      (x) => key(childText(x.text, "fullName") ?? "") === key(outbound[1]!),
    );
    if (!b) return undefined;
    if (outbound[2] === "posts to plain http")
      return single(
        ctx,
        f.rule,
        "Post the outbound message over https",
        "safe",
        file,
        splice(xml, b, toHttps(b.text, ["endpointUrl"])),
        "Check that the receiver answers on https.",
      );
    return single(
      ctx,
      f.rule,
      "Stop sending a session ID",
      "review",
      file,
      splice(xml, b, setChild(b.text, "outboundMessages", "includeSessionId", "false")),
      "Only if the receiver doesn't call back into Salesforce with it.",
    );
  }
  return undefined;
};

// ---- Agentforce --------------------------------------------------------------------------------

const agentConfirmation: Fixer = (ctx) => {
  const f = ctx.finding;
  const m = /^Agent action (.+) \(.+\) deletes records without asking for confirmation$/.exec(f.title);
  const file = f.files?.[0];
  if (!m || !file) return undefined;
  const text = ctx.read(file);
  if (text === undefined) return undefined;
  const label = "Ask the user to confirm before the action runs";
  if (file.endsWith(".genAiFunction-meta.xml")) {
    const root = /<GenAiFunction[^>]*>[\s\S]*<\/GenAiFunction>/.exec(text);
    if (!root) return undefined;
    const block = { start: root.index, end: root.index + root[0].length, text: root[0] };
    return single(
      ctx,
      f.rule,
      label,
      "safe",
      file,
      splice(text, block, setChild(block.text, "GenAiFunction", "isConfirmationRequired", "true")),
    );
  }
  if (file.endsWith(".agent")) {
    const after = confirmInAgentScript(text, m[1]!);
    return after ? single(ctx, f.rule, label, "safe", file, after) : undefined;
  }
  return undefined;
};

/** In an Agent Script, add `require_user_confirmation: True` to the action named or labelled `name`. */
export function confirmInAgentScript(script: string, name: string): string | undefined {
  const lines = script.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s+)(\w+):\s*$/.exec(lines[i]!);
    if (!head) continue;
    const indent = head[1]!.length;
    let end = i + 1;
    while (end < lines.length && (lines[end]!.trim() === "" || lines[end]!.search(/\S/) > indent)) end++;
    const body = lines.slice(i + 1, end);
    const targetAt = body.findIndex((l) => /^\s+target:\s*"/.test(l));
    if (targetAt < 0) continue;
    const labelled = body.some((l) => new RegExp(`^\\s+label:\\s*"${esc(name)}"\\s*$`).test(l));
    if (head[2] !== name && !labelled) continue;
    const existing = body.findIndex((l) => /^\s+require_user_confirmation:/.test(l));
    const pad = /^(\s+)/.exec(body[targetAt]!)![1]!;
    if (existing >= 0) lines[i + 1 + existing] = `${pad}require_user_confirmation: True`;
    else lines.splice(i + 1 + targetAt + 1, 0, `${pad}require_user_confirmation: True`);
    return lines.join("\n");
  }
  return undefined;
}

// ---- Access: put back what the base branch had -----------------------------------------------------

/** Set `flags` in the block for `object` (or field) to their value at the base ref (false when absent there). */
function revertFlags(
  cur: string,
  base: string | undefined,
  tag: string,
  idTag: string,
  id: string | undefined,
  flags: string[],
) {
  let out = cur;
  const baseBlocks = base ? blocks(base, tag) : [];
  for (const b of blocks(cur, tag).reverse()) {
    const bid = childText(b.text, idTag);
    if (!bid || (id && key(bid) !== key(id))) continue;
    const was = baseBlocks.find((x) => key(childText(x.text, idTag) ?? "") === key(bid));
    let text = b.text;
    for (const flag of flags) {
      if (!/^true$/i.test(childText(text, flag) ?? "")) continue;
      const before = was ? (childText(was.text, flag) ?? "false") : "false";
      if (!/^true$/i.test(before)) text = setChild(text, tag, flag, "false");
    }
    out = splice(out, b, text);
  }
  return out;
}

const permissionUndo: Fixer = (ctx) => {
  const f = ctx.finding;
  const file = f.files?.[0];
  if (!file || !/\.(permissionset|profile)-meta\.xml$/.test(file)) return undefined;
  const cur = ctx.read(file);
  if (cur === undefined) return undefined;
  const base = ctx.readBase(file);
  let after: string | undefined;
  let label = "";
  switch (f.rule) {
    case "permission-escalation":
      if (!f.object) return undefined;
      after = revertFlags(cur, base, "objectPermissions", "object", f.object, ["modifyAllRecords", "viewAllRecords"]);
      label = `Take back View All / Modify All on ${f.object}`;
      break;
    case "permission-delete":
      if (!f.object) return undefined;
      after = revertFlags(cur, base, "objectPermissions", "object", f.object, ["allowDelete", "modifyAllRecords"]);
      label = `Take back delete on ${f.object}`;
      break;
    case "permission-system": {
      const perm = /system permission (\w+)$/.exec(f.title)?.[1];
      if (!perm) return undefined;
      const b = blocks(cur, "userPermissions").find((x) => key(childText(x.text, "name") ?? "") === key(perm));
      if (!b) return undefined;
      const was = base
        ? blocks(base, "userPermissions").find((x) => key(childText(x.text, "name") ?? "") === key(perm))
        : undefined;
      after = was ? splice(cur, b, setChild(b.text, "userPermissions", "enabled", "false")) : removeBlock(cur, b);
      label = `Take back ${perm}`;
      break;
    }
    case "permission-field-edit":
      after = revertFlags(cur, base, "fieldPermissions", "field", undefined, ["editable"]);
      label = "Take back the new field edit access";
      break;
    default:
      return undefined;
  }
  return single(ctx, f.rule, label, "undo", file, after);
};

const sharingUndo: Fixer = (ctx) => {
  const f = ctx.finding;
  const file = f.files?.[0];
  const m = /default access for (internal|external)/.exec(f.title);
  if (!file || !m) return undefined;
  const cur = ctx.read(file);
  const base = ctx.readBase(file);
  if (cur === undefined || base === undefined) return undefined;
  const tag = m[1] === "internal" ? "sharingModel" : "externalSharingModel";
  const was = childText(base, tag);
  if (!was) return undefined;
  const after = cur.replace(new RegExp(`(<${tag}>)[^<]*(</${tag}>)`), `$1${was}$2`);
  return single(ctx, f.rule, `Put the ${m[1]} sharing default back to ${was}`, "undo", file, after);
};

const picklistUndo: Fixer = (ctx) => {
  const f = ctx.finding;
  const file = f.files?.[0];
  if (!file?.endsWith(".field-meta.xml")) return undefined;
  const cur = ctx.read(file);
  const base = ctx.readBase(file);
  if (cur === undefined || base === undefined) return undefined;
  const active = (b: string) => !/^false$/i.test(childText(b, "isActive") ?? "true");
  const nowActive = new Set(
    blocks(cur, "value")
      .filter((b) => active(b.text))
      .map((b) => key(childText(b.text, "fullName") ?? "")),
  );
  const missing = blocks(base, "value").filter(
    (b) => active(b.text) && !nowActive.has(key(childText(b.text, "fullName") ?? "")),
  );
  if (!missing.length) return undefined;
  let after = cur;
  const baseValues = blocks(base, "value");
  for (const m of missing) {
    const name = key(childText(m.text, "fullName") ?? "");
    const there = blocks(after, "value").find((b) => key(childText(b.text, "fullName") ?? "") === name);
    if (there) {
      after = splice(after, there, m.text);
      continue;
    }
    // Back where it was: after the value that came before it on the base branch, else first.
    const now = blocks(after, "value");
    const idx = baseValues.findIndex((b) => b.start === m.start);
    let anchor: Block | undefined;
    for (let i = idx - 1; i >= 0 && !anchor; i--) {
      const prev = key(childText(baseValues[i]!.text, "fullName") ?? "");
      anchor = now.find((b) => key(childText(b.text, "fullName") ?? "") === prev);
    }
    const lineStartOf = (at: number) => after.lastIndexOf("\n", at - 1) + 1;
    if (anchor) {
      const indent = after.slice(lineStartOf(anchor.start), anchor.start);
      after = `${after.slice(0, anchor.end)}\n${indent}${m.text}${after.slice(anchor.end)}`;
    } else if (now[0]) {
      const ls = lineStartOf(now[0].start);
      const indent = after.slice(ls, now[0].start);
      after = `${after.slice(0, ls)}${indent}${m.text}\n${after.slice(ls)}`;
    } else {
      const close = after.lastIndexOf("</valueSetDefinition>");
      if (close < 0) return undefined;
      const indent = /\n([ \t]*)<value>/.exec(base)?.[1] ?? "            ";
      const ls = lineStartOf(close);
      const at = after.slice(ls, close).trim() === "" ? ls : close;
      after = `${after.slice(0, at)}${at === ls ? indent : ""}${m.text}\n${after.slice(at)}`;
    }
  }
  const names = missing.map((m) => childText(m.text, "fullName"));
  return single(
    ctx,
    f.rule,
    `Keep ${names.length === 1 ? `value ${names[0]}` : `${names.length} values`} active`,
    "undo",
    file,
    after,
    "Or keep the change and update the record types, flows and code that still use them.",
  );
};

// ---- References ----------------------------------------------------------------------------------

const renamedReferences: Fixer = (ctx) => {
  const f = ctx.finding;
  const renamedFile = f.files?.[0];
  const change = ctx.result.changes.find(
    (c) => c.changeType === "renamed" && c.component.file === renamedFile && c.previousFile,
  );
  if (!change?.previousFile) return undefined;
  const previous = classifyPath(change.previousFile);
  const [from, to] = [namesOf(previous), namesOf(change.component)];
  if (key(from.plain) === key(to.plain)) return undefined;
  const patterns = referencePatterns(previous).map((re) => new RegExp(re.source, `${re.flags.replace("g", "")}g`));
  const edits: FixEdit[] = [];
  for (const file of (f.files ?? []).slice(1)) {
    const before = ctx.read(file);
    if (before === undefined) continue;
    let after = before;
    for (const re of patterns) {
      after = after.replace(re, (m) =>
        from.qualified && to.qualified && m.includes(from.qualified)
          ? m.split(from.qualified).join(to.qualified)
          : m.split(from.plain).join(to.plain),
      );
    }
    if (after !== before) edits.push({ file, before, after });
  }
  if (!edits.length) return undefined;
  return {
    rule: f.rule,
    finding: f.title,
    label: `Use the new name ${to.qualified ?? to.plain} in ${edits.length} file(s)`,
    kind: "review",
    note: "Found by name, not by parsing: read each change.",
    edits,
  };
};

const FIXERS: Record<string, Fixer[]> = {
  "integration-insecure": [insecureIntegration],
  "agent-action-no-confirmation": [agentConfirmation],
  "permission-escalation": [permissionUndo],
  "permission-delete": [permissionUndo],
  "permission-system": [permissionUndo],
  "permission-field-edit": [permissionUndo],
  "sharing-model-opened": [sharingUndo],
  "picklist-value-removed": [picklistUndo],
  "renamed-still-named": [renamedReferences],
};

export const FIXABLE_RULES: ReadonlySet<string> = new Set(Object.keys(FIXERS));

/** The first fixer's proposal for a finding, if any. */
export function proposeFix(ctx: FixContext): ProposedFix | undefined {
  for (const fixer of FIXERS[ctx.finding.rule] ?? []) {
    try {
      const fix = fixer(ctx);
      if (fix?.edits.some((e) => e.before !== e.after)) return fix;
    } catch {
      // a fixer that can't read the file proposes nothing
    }
  }
  return undefined;
}
