// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import path from "node:path";
import { readProjectFile } from "./files.js";
import type { ComponentRef, Finding, OrgModel } from "./types.js";
import { key, nodes, parseMetadataXml, text, type XmlNode } from "./util.js";

/**
 * Metadata that names fields without running anything: reports, report types, list views,
 * email templates, quick actions, compact layouts and field sets. Deleting or renaming a field
 * they name breaks them (or blocks the deployment), so they count as field references.
 */

export type FieldUserKind =
  | "Report"
  | "ReportType"
  | "ListView"
  | "EmailTemplate"
  | "QuickAction"
  | "CompactLayout"
  | "FieldSet";

export interface FieldUser {
  kind: FieldUserKind;
  name: string;
  file: string;
  /** `Object.Field`, as written (case kept). */
  fields: string[];
}

/** `Object.Field__r` relationship → `Field__c` object guess; standard names are kept. */
const relObject = (s: string) => s.replace(/__r$/i, "__c");

/** `Contact$Account.Industry`, `Opportunity.Total__c`, `Invoice__c$Amount__c` → `Object.Field`. */
export function qualify(token: string, fallbackObject?: string): string | undefined {
  const parts = token.split(/[$.]/).filter(Boolean);
  if (parts.length >= 2) return `${relObject(parts[parts.length - 2]!)}.${parts[parts.length - 1]}`;
  if (parts.length === 1 && fallbackObject && /^[A-Za-z]\w*$/.test(parts[0]!)) return `${fallbackObject}.${parts[0]}`;
  return undefined;
}

/** Every value of the named elements, anywhere below a node. */
function valuesOf(node: unknown, names: Set<string>, out: string[] = [], el?: string): string[] {
  if (Array.isArray(node)) for (const x of node) valuesOf(x, names, out, el);
  else if (node && typeof node === "object")
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) valuesOf(v, names, out, k);
  else if (el && names.has(el)) {
    const t = text(node);
    if (t) out.push(t);
  }
  return out;
}

const MERGE = [/\{!\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\}/g, /\{\{\{\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\}\}\}/g];
/** Merge fields in an email template body: `{!Opportunity.Amount}`, `{{{Opportunity.Amount}}}`. */
export function mergeFields(body: string): string[] {
  const out: string[] = [];
  for (const re of MERGE) for (const m of body.matchAll(re)) out.push(`${m[1]}.${m[2]}`);
  return out;
}

const childKind = (file: string): FieldUserKind | undefined =>
  /\.listView-meta\.xml$/.test(file)
    ? "ListView"
    : /\.compactLayout-meta\.xml$/.test(file)
      ? "CompactLayout"
      : /\.fieldSet-meta\.xml$/.test(file)
        ? "FieldSet"
        : undefined;

/** Parse one component's file, when it is a kind that names fields. */
export function parseFieldUser(comp: ComponentRef, read: (file: string) => string | undefined): FieldUser | undefined {
  const kind: FieldUserKind | undefined =
    comp.type === "ObjectChild"
      ? childKind(comp.file)
      : comp.metadataType === "Report" ||
          comp.metadataType === "ReportType" ||
          comp.metadataType === "QuickAction" ||
          comp.metadataType === "EmailTemplate"
        ? comp.metadataType
        : undefined;
  if (!kind) return undefined;
  if (kind === "EmailTemplate") {
    // The body sits next to the meta file: `Folder/Name.email`.
    const bodyFile = comp.file.replace(/-meta\.xml$/, "");
    const body = bodyFile === comp.file ? read(comp.file) : read(bodyFile);
    if (body === undefined) return undefined;
    return { kind, name: comp.name, file: bodyFile, fields: mergeFields(body) };
  }
  const xml = read(comp.file);
  if (!xml) return undefined;
  let body: XmlNode;
  try {
    body = parseMetadataXml(xml).body;
  } catch {
    return undefined;
  }
  const fields: string[] = [];
  const push = (token: string, object?: string) => {
    const q = qualify(token, object);
    if (q) fields.push(q);
  };
  switch (kind) {
    case "ListView":
    case "CompactLayout":
    case "FieldSet": {
      const object = comp.object;
      // List view columns of standard fields use legacy tokens (ACCOUNT.NAME): only custom ones are reliable.
      for (const v of valuesOf(body, new Set(["columns", "field", "fields"])))
        if (kind !== "ListView" || /__c$/i.test(v)) push(v, object);
      break;
    }
    case "QuickAction": {
      const object = text(body.targetObject) ?? comp.name.split(".")[0];
      for (const v of valuesOf([body.quickActionLayout, body.fieldOverrides], new Set(["field"]))) push(v, object);
      break;
    }
    case "ReportType": {
      for (const s of nodes(body.sections))
        for (const c of nodes(s.columns)) {
          const table = text(c.table) ?? text(body.baseObject) ?? "";
          const field = text(c.field);
          if (field) push(`${table.split(".").pop() ?? table}.${field}`);
        }
      break;
    }
    case "Report": {
      const rt = text(body.reportType) ?? "";
      for (const v of valuesOf(body, new Set(["field", "column", "aggregates"]))) {
        // Custom report types write `Base$Field`; standard ones `Object.Field__c` or legacy tokens.
        if (v.includes("$") || /\.\w+__c$/i.test(v)) push(v);
        else if (/^\w+__c$/i.test(v) && /^\w+__c$/i.test(rt)) push(v, rt);
      }
      break;
    }
  }
  return { kind, name: displayName(comp), file: comp.file, fields: [...new Set(fields)] };
}

const displayName = (c: ComponentRef) =>
  c.type === "ObjectChild" && c.object ? `${c.object}.${c.name.split(".").pop()}` : c.name;

/** `npe01__Type__c`: a managed package's field, which the project can't be expected to contain. */
export const isNamespaced = (field: string) => /^[A-Za-z0-9]+__\w+__c$/i.test(field);

const cache = new WeakMap<OrgModel, FieldUser[]>();
/** Every report, report type, list view, email template, quick action, compact layout and field set. */
export function fieldUsersOf(model: OrgModel): FieldUser[] {
  let users = cache.get(model);
  if (users) return users;
  const read = (file: string) => {
    try {
      return readProjectFile(model, file);
    } catch {
      return undefined;
    }
  };
  users = [];
  for (const c of model.components.values()) {
    if (c.metadataType === "EmailTemplate" && !c.file.endsWith("-meta.xml")) continue; // one entry per template
    const u = parseFieldUser(c, read);
    if (u?.fields.length) users.push(u);
  }
  cache.set(model, users);
  return users;
}

/** Who names `Object.Field`. */
export const fieldUsers = (model: OrgModel, object: string, field: string) => {
  const k = key(`${object}.${field}`);
  return fieldUsersOf(model).filter((u) => u.fields.some((f) => key(f) === k));
};

/** A changed report, list view, template, ... that names custom fields the project's objects lack. */
export function missingFieldFindings(model: OrgModel, comp: ComponentRef): Finding[] {
  const read = (file: string) => {
    try {
      return readProjectFile(model, file);
    } catch {
      return undefined;
    }
  };
  const u = parseFieldUser(comp, read);
  if (!u) return [];
  const missing = u.fields.filter((f) => {
    const [object, field] = f.split(".") as [string, string];
    const def = model.objects.get(key(object));
    return !!def && /__c$/i.test(field) && !isNamespaced(field) && def.fields.size > 0 && !def.fields.has(key(field));
  });
  if (!missing.length) return [];
  return [
    {
      rule: "missing-field-reference",
      severity: "medium",
      title: `${u.kind.replace(/([a-z])([A-Z])/g, "$1 $2")} ${u.name} names ${missing.length} field(s) the project does not have`,
      detail: `${missing.join(", ")}. The deployment fails, or the ${u.kind === "EmailTemplate" ? "merge field renders blank" : "column or filter breaks"}, unless they exist in the target org already.`,
      files: [comp.file],
    },
  ];
}
