// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import path from "node:path";
import { readProjectFile } from "./files.js";
import type { Change, ComponentRef, Finding, OrgModel } from "./types.js";
import { key, uniq } from "./util.js";

/**
 * The reference check every metadata type gets: when a component is deleted or renamed, which
 * other files in the project still name it?
 *
 * Types with their own analysis (fields, classes, flows, Lightning components, labels, custom
 * metadata records, record types) find their references precisely and are skipped here. For
 * everything else this is a name match, not a parse, so findings say "named in" and list the files
 * to check. To keep the noise down:
 *  - A qualified name (`Folder/Name`, `Object.Child`, `Name__c`) is matched anywhere as a whole word.
 *  - A plain name is matched only where references live: as an XML element's whole value, as a
 *    quoted string, or in the type's own reference syntax (`$Resource.Name`, `callout:Name`, ...).
 *    Short or common-looking plain names are matched only in the type's own syntax.
 */

/** How a type is referenced, besides the generic forms. `n` is the escaped plain name. */
interface TypeSyntax {
  /** Regex sources that only ever mean a reference to this type. */
  patterns?: (n: string) => string[];
  /** XML elements whose value names a component of this type. */
  elements?: string[];
  /** Use only the patterns and elements above: the plain name is too common to match generically. */
  only?: boolean;
}

const SYNTAX: Record<string, TypeSyntax> = {
  StaticResource: {
    patterns: (n) => [
      `\\$Resource\\.${n}(?![\\w])`,
      `@salesforce/resourceUrl/${n}(?![\\w])`,
      `forResource\\(\\s*['"]${n}['"]`,
    ],
  },
  NamedCredential: { patterns: (n) => [`callout:${n}(?![\\w])`], elements: ["namedCredential"] },
  ExternalCredential: { elements: ["externalCredential", "parameterValue"] },
  CustomPermission: {
    patterns: (n) => [
      `\\$Permission\\.${n}(?![\\w])`,
      `@salesforce/customPermission/${n}(?![\\w])`,
      `checkPermission\\(\\s*['"]${n}['"]`,
    ],
  },
  ApexPage: { patterns: (n) => [`\\bPage\\.${n}(?![\\w])`, `/apex/${n}(?![\\w])`], elements: ["page", "apexPage"] },
  // Visualforce components are only ever used as tags.
  ApexComponent: { patterns: (n) => [`<c:${n}(?![\\w])`], only: true },
  ContentAsset: { patterns: (n) => [`@salesforce/contentAssetUrl/${n}(?![\\w])`] },
  CustomTab: { elements: ["tab", "tabs", "defaultLandingTab"], only: true },
  CustomApplication: { elements: ["application", "defaultApplication"], only: true },
  GlobalValueSet: { elements: ["valueSetName"], only: true },
  StandardValueSet: { elements: ["valueSetName"], only: true },
  PermissionSet: { elements: ["permissionSets", "permissionSet", "mutingPermissionSets"] },
  PermissionSetGroup: { elements: ["permissionSetGroup"] },
  Profile: { elements: ["profile", "profileName"] },
  Layout: { elements: ["layout"] },
  CompactLayout: { elements: ["compactLayoutAssignment", "compactLayouts"] },
  Queue: { elements: ["queue", "assignedTo"] },
  Group: { elements: ["sharedTo", "group", "assignedTo"] },
  Role: { elements: ["role", "parentRole", "roleAndSubordinates"] },
  EmailTemplate: { elements: ["template", "emailTemplate"] },
  RemoteSiteSetting: { only: true },
  ConnectedApp: { elements: ["connectedApp"] },
};

/** Types whose deletion is analyzed elsewhere, with references found precisely. */
const PRECISE_ON_DELETE = new Set([
  "CustomField",
  "ApexClass",
  "Flow",
  "AgentMetadata",
  "ValidationRule",
  "ApexTrigger",
  "WorkflowRule",
  "LightningComponentBundle",
  "AuraDefinitionBundle",
  "CustomLabels",
  "CustomMetadata",
]);

const TEXT_FILE = /\.(xml|cls|trigger|js|ts|html|cmp|app|evt|design|page|component|json|agent|yaml|yml)$/i;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LISTED = 8;
/** Elements whose value is a component's own name or display text, never a reference. */
const DECLARING =
  "fullName|label|masterLabel|pluralLabel|description|shortDescription|value|helpText|inlineHelpText|errorMessage";
/** Salesforce API name suffixes (`__c`, `__e`, `__mdt`, ...): names that end in one are unique enough to match anywhere. */
const SF_SUFFIX = /__(?:c|e|mdt|x|b|r|kav|share|history|feed|p|chn|dll)$/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const typeOf = (c: ComponentRef) => c.metadataType ?? c.type;

/** The name other files use, and whether it is distinctive enough to match anywhere. */
function namesOf(c: ComponentRef): { qualified?: string; plain: string } {
  if (c.type === "ObjectChild" && c.object) {
    const last = c.name.split(".").pop() ?? c.name;
    return { qualified: `${c.object}.${last}`, plain: last };
  }
  const cut = Math.max(c.name.lastIndexOf("/"), c.name.lastIndexOf("."));
  if (cut > 0) return { qualified: c.name, plain: c.name.slice(cut + 1) };
  // `Invoice__c`, `Order_Event__e`: unique enough on its own.
  if (SF_SUFFIX.test(c.name)) return { qualified: c.name, plain: c.name };
  // Layout names (`Account-Account Layout`) contain a dash.
  if (c.name.includes("-")) return { qualified: c.name, plain: c.name };
  return { plain: c.name };
}

/** A plain name that is unlikely to be an ordinary word or value. */
export const distinctive = (name: string): boolean =>
  name.length >= 4 && (/[_\d]/.test(name) || /[a-z][A-Z]/.test(name) || name.length >= 12);

/** The patterns that find a reference to a component in another file. */
export function referencePatterns(c: ComponentRef): RegExp[] {
  const { qualified, plain } = namesOf(c);
  const syntax = SYNTAX[typeOf(c)] ?? {};
  const n = escapeRe(plain);
  const sources: string[] = [];
  if (qualified && !syntax.only) sources.push(`(?<![\\w$./-])${escapeRe(qualified)}(?![\\w/-])`);
  // `Old__c`, `Invoice__c`: a whole word anywhere (code names fields and objects unquoted).
  if (!syntax.only && SF_SUFFIX.test(plain) && plain !== qualified) sources.push(`(?<![\\w$])${n}(?![\\w])`);
  sources.push(...(syntax.patterns?.(n) ?? []));
  for (const el of syntax.elements ?? []) sources.push(`<${el}>\\s*${n}\\s*</${el}>`);
  if (!syntax.only && distinctive(plain)) {
    // An XML element's whole value; not elements that declare a name or hold display text.
    sources.push(`<(?!(?:${DECLARING})>)[\\w:]+>\\s*${n}\\s*</`);
    sources.push(`(?:['"\`]|&quot;)${n}(?:['"\`]|&quot;)`); // a quoted string
  }
  return sources.map((s) => new RegExp(s));
}

const textCache = new WeakMap<OrgModel, Map<string, string | null>>();
function textOf(model: OrgModel, file: string): string | undefined {
  let cache = textCache.get(model);
  if (!cache) {
    cache = new Map();
    textCache.set(model, cache);
  }
  if (!cache.has(file)) {
    let text: string | null = null;
    try {
      const t = readProjectFile(model, file);
      text = t.length > MAX_FILE_BYTES ? null : t;
    } catch {
      text = null;
    }
    cache.set(file, text);
  }
  return cache.get(file) ?? undefined;
}

const sameComponent = (a: ComponentRef, b: ComponentRef) =>
  a.type === b.type && typeOf(a) === typeOf(b) && key(a.name) === key(b.name);

/** Project files, other than the component's own, that name it. */
export function filesNaming(model: OrgModel, c: ComponentRef, exclude: ComponentRef[] = []): string[] {
  const res = referencePatterns(c);
  if (!res.length) return [];
  const { plain } = namesOf(c);
  const out: string[] = [];
  for (const [file, ref] of model.components) {
    if (!TEXT_FILE.test(file) || sameComponent(ref, c) || exclude.some((e) => sameComponent(ref, e))) continue;
    const text = textOf(model, file);
    if (!text || !text.toLowerCase().includes(plain.toLowerCase())) continue;
    if (res.some((re) => re.test(text))) out.push(file);
  }
  return out.sort();
}

/** True when another file of the same component is still in the project (a bundle lost one file). */
const stillPresent = (model: OrgModel, c: ComponentRef) =>
  [...model.components.values()].some((r) => sameComponent(r, c));

/** Whether the generic check applies to a deleted component (its type isn't checked precisely). */
export function needsReferenceCheck(c: ComponentRef): boolean {
  if (PRECISE_ON_DELETE.has(c.type) || PRECISE_ON_DELETE.has(typeOf(c))) return false;
  if (c.type === "ObjectChild" && /\.recordType-meta\.xml$/.test(c.file)) return false;
  // A standard object's file leaving the repo doesn't delete the object.
  if (c.type === "CustomObject" && !SF_SUFFIX.test(c.name)) return false;
  return c.type !== "Other";
}

const label = (c: ComponentRef) => {
  const t = typeOf(c);
  return t === "ObjectChild" ? (c.file.match(/\.(\w+)-meta\.xml$/)?.[1] ?? "component") : t;
};

/** `Account.Manage_Household` for an object child, the component name otherwise. */
const display = (c: ComponentRef) => namesOf(c).qualified ?? c.name;

const listFiles = (files: string[]) =>
  `${files.slice(0, MAX_LISTED).join(", ")}${files.length > MAX_LISTED ? ` and ${files.length - MAX_LISTED} more` : ""}`;

/**
 * The reference check for one change: a deleted component of a type without precise analysis, or
 * a renamed component of any type (the old name is what other files may still use).
 */
export function referenceFindings(model: OrgModel, change: Change, previous?: ComponentRef): Finding[] {
  const comp = change.component;
  if (change.changeType === "deleted") {
    // A source file deletion only counts when the whole component is gone; a destructive manifest
    // deletes it from the org even when its source stays.
    if (!needsReferenceCheck(comp) || (!change.manifest && stillPresent(model, comp))) return [];
    const files = filesNaming(model, comp);
    if (!files.length) return [];
    return [
      {
        rule: "deleted-still-named",
        severity: "medium",
        title: `Deleted ${label(comp)} ${display(comp)} is still named in ${files.length} file(s)`,
        detail: `${listFiles(files)} name it. This is a name match, not a parse: check each one. Where it is a real reference, a deployment that includes the file fails, or the reference breaks once the ${label(comp)} is gone from the org.`,
        object: comp.object,
        files: uniq([comp.file, ...files]),
      },
    ];
  }
  if (change.changeType === "renamed" && previous && previous.type !== "Other") {
    if (key(previous.name) === key(comp.name) || stillPresent(model, previous)) return [];
    const files = filesNaming(model, previous, [comp]);
    if (!files.length) return [];
    return [
      {
        rule: "renamed-still-named",
        severity: "medium",
        title: `${label(comp)} ${display(previous)} was renamed to ${display(comp)}, but ${files.length} file(s) still use the old name`,
        detail: `${listFiles(files)} name ${previous.name}. Renaming the file creates a new component and leaves the old one in the org until it is deleted, so this can work in an existing org and fail in a new one. Update the references in the same change.`,
        object: comp.object,
        files: uniq([comp.file, ...files]),
      },
    ];
  }
  return [];
}
