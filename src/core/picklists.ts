// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import path from "node:path";
import { readProjectFile } from "./files.js";
import { parseField } from "./parsers/fields.js";
import { parseRecordType } from "./parsers/recordTypes.js";
import type { ComponentRef, Finding, OrgModel } from "./types.js";
import { key, uniq } from "./util.js";

/** Source that can name a picklist value or a record type in a string: Apex, flows, formulas, workflow. */
const CODE_FILE = /\.(cls|trigger|flow-meta\.xml|validationRule-meta\.xml|field-meta\.xml|workflow-meta\.xml)$/;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LISTED = 6;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A value as it appears in code (`'Closed Won'`, `"x"`) or in a flow (`<stringValue>x</stringValue>`). */
const literal = (value: string) =>
  new RegExp(`(?:["']|&quot;|&apos;|<stringValue>)${escapeRe(value)}(?:["']|&quot;|&apos;|</stringValue>)`, "i");

function read(model: OrgModel, file: string): string | undefined {
  try {
    const text = readProjectFile(model, file);
    return text.length > MAX_FILE_BYTES ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * Files that mention `mustMention` (a field or the word RecordType) and write one of `values` as a
 * string. Both are required: a bare 'Open' is everywhere; 'Open' in a file that names StageName
 * is almost certainly about it.
 */
function literalUses(model: OrgModel, mustMention: string, values: string[], ownFile: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const patterns = values.map((v) => [v, literal(v)] as const);
  const needle = mustMention.toLowerCase();
  for (const file of model.components.keys()) {
    if (file === ownFile || !CODE_FILE.test(file)) continue;
    const text = read(model, file);
    if (!text?.toLowerCase().includes(needle)) continue;
    for (const [v, re] of patterns) {
      if (re.test(text)) out.set(v, [...(out.get(v) ?? []), file]);
    }
  }
  return out;
}

const list = (xs: string[]) =>
  `${xs.slice(0, MAX_LISTED).join(", ")}${xs.length > MAX_LISTED ? ` and ${xs.length - MAX_LISTED} more` : ""}`;

/**
 * A changed picklist field: values that were active in the base and are gone or deactivated now,
 * with the record types, formulas, flows and Apex that still use them.
 */
export function picklistFindings(
  model: OrgModel,
  comp: ComponentRef,
  object: string,
  field: string,
  baseXml: string | undefined,
): Finding[] {
  const current = model.objects.get(key(object))?.fields.get(key(field));
  if (!baseXml || !current?.picklist?.values.length) return [];
  let previous: ReturnType<typeof parseField>;
  try {
    previous = parseField(baseXml, object, field, comp.file);
  } catch {
    return [];
  }
  const nowActive = new Set(current.picklist.values.filter((v) => v.active).map((v) => key(v.name)));
  const removed = (previous.picklist?.values ?? [])
    .filter((v) => v.active && !nowActive.has(key(v.name)))
    .map((v) => v.name);
  if (!removed.length) return [];

  const offeredBy = [...model.recordTypes.values()].filter(
    (rt) => key(rt.object) === key(object) && removed.some((v) => rt.picklists[field]?.some((x) => key(x) === key(v))),
  );
  const uses = literalUses(model, field, removed, comp.file);
  const usedIn = uniq([...uses.values()].flat());
  const where = [
    offeredBy.length ? `record types ${list(offeredBy.map((r) => r.name))} still offer it` : "",
    usedIn.length ? `written as text in ${list(usedIn)}` : "",
  ].filter(Boolean);
  return [
    {
      rule: "picklist-value-removed",
      severity: where.length ? "medium" : "low",
      title: `${removed.length} picklist value(s) removed from ${comp.name}: ${list(removed)}`,
      detail: where.length
        ? `${where.join("; ")}. Records that hold the old value keep it, but new saves with it fail or take the wrong branch.`
        : "Nothing in the project names them. Records that hold the old value keep it; reports and integrations may still filter on it.",
      object,
      files: uniq([comp.file, ...offeredBy.map((r) => r.file), ...usedIn]),
    },
  ];
}

/** A changed or deleted record type. */
export function recordTypeFindings(
  model: OrgModel,
  comp: ComponentRef,
  deleted: boolean,
  baseXml: string | undefined,
): Finding[] {
  const object = comp.object ?? "";
  const short = comp.name.split(".").pop() ?? comp.name;
  const findings: Finding[] = [];
  if (deleted) {
    const uses = literalUses(model, "RecordType", [short], comp.file);
    const files = uniq([...uses.values()].flat());
    if (files.length) {
      findings.push({
        rule: "record-type-still-referenced",
        severity: "medium",
        title: `Deleted record type ${object}.${short} is still named in code`,
        detail: `${list(files)} compare against it by name. They keep deploying, then quietly stop matching.`,
        object,
        files: uniq([comp.file, ...files]),
      });
    }
    return findings;
  }
  const current = model.recordTypes.get(key(`${object}.${short}`));
  if (!current || !baseXml) return findings;
  let previous: ReturnType<typeof parseRecordType>;
  try {
    previous = parseRecordType(baseXml, object, short, comp.file);
  } catch {
    return findings;
  }
  const dropped: string[] = [];
  for (const [field, values] of Object.entries(previous.picklists)) {
    const now = new Set((current.picklists[field] ?? []).map(key));
    for (const v of values) if (!now.has(key(v))) dropped.push(`${field}: ${v}`);
  }
  if (dropped.length) {
    findings.push({
      rule: "record-type-values-removed",
      severity: "low",
      title: `${current.name} no longer offers ${dropped.length} picklist value(s)`,
      detail: `${list(dropped)}. Users of ${object} records of this type can no longer pick them; existing records keep them.`,
      object,
      files: [comp.file],
    });
  }
  if (previous.active && !current.active) {
    findings.push({
      rule: "record-type-deactivated",
      severity: "low",
      title: `Record type ${object}.${current.name} was deactivated`,
      detail:
        "New records can no longer use it; existing records keep it. Flows or Apex that create records of this type may fail.",
      object,
      files: [comp.file],
    });
  }
  return findings;
}
