// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import path from "node:path";
import { readProjectFile } from "./files.js";
import type { ComponentRef, Finding, OrgModel } from "./types.js";
import { key, uniq } from "./util.js";

/** Files that can name a label, a custom metadata record or an Apex class. */
const TEXT_FILE = /\.(cls|trigger|js|ts|html|cmp|app|evt|page|component|xml)$/i;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LISTED = 6;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const list = (xs: string[]) =>
  `${xs.slice(0, MAX_LISTED).join(", ")}${xs.length > MAX_LISTED ? ` and ${xs.length - MAX_LISTED} more` : ""}`;

/** Reads project files once each, on demand. */
class Texts {
  private cache = new Map<string, string | undefined>();
  constructor(private readonly model: OrgModel) {}
  get(file: string): string | undefined {
    if (!this.cache.has(file)) {
      let text: string | undefined;
      try {
        const t = readProjectFile(this.model, file);
        text = t.length > MAX_FILE_BYTES ? undefined : t;
      } catch {
        text = undefined;
      }
      this.cache.set(file, text);
    }
    return this.cache.get(file);
  }
  /** Files (other than `except`) whose text matches. */
  find(re: RegExp, except: string): string[] {
    const out: string[] = [];
    for (const file of this.model.components.keys()) {
      if (file === except || !TEXT_FILE.test(file)) continue;
      const text = this.get(file);
      if (text && re.test(text)) out.push(file);
    }
    return out;
  }
}

const texts = new WeakMap<OrgModel, Texts>();
const textsOf = (model: OrgModel) => {
  let t = texts.get(model);
  if (!t) {
    t = new Texts(model);
    texts.set(model, t);
  }
  return t;
};

// ---- Custom labels -------------------------------------------------------------------

const labelNames = (xml: string | undefined): string[] =>
  xml ? [...xml.matchAll(/<fullName>\s*([^<\s]+)\s*<\/fullName>/g)].map((m) => m[1] as string) : [];

/** `Label.X`, `System.Label.X`, `$Label.X`, `$Label.c.X` and `@salesforce/label/c.X`. */
const labelUse = (name: string) =>
  new RegExp(`(?:\\$?Label\\.(?:c\\.)?|@salesforce/label/c\\.)${escapeRe(name)}(?![\\w])`, "i");

/** A changed custom labels file: labels that are gone from it but still used. */
export function labelFindings(
  model: OrgModel,
  comp: ComponentRef,
  deleted: boolean,
  baseXml: string | undefined,
): Finding[] {
  const before = labelNames(baseXml);
  if (!before.length) return [];
  const now = new Set(deleted ? [] : labelNames(textsOf(model).get(comp.file)).map(key));
  const t = textsOf(model);
  const findings: Finding[] = [];
  for (const name of before) {
    if (now.has(key(name))) continue;
    const users = t.find(labelUse(name), comp.file);
    if (!users.length) continue;
    findings.push({
      rule: "label-removed-still-used",
      severity: "high",
      title: `Custom label ${name} was removed but is still used`,
      detail: `Used by ${list(users)}. Those files fail to compile or show a blank string once the label is gone.`,
      files: uniq([comp.file, ...users]),
    });
  }
  return findings;
}

// ---- Custom metadata records ----------------------------------------------------------

/** A changed or deleted custom metadata record (`Type.Record`). */
export function customMetadataFindings(model: OrgModel, comp: ComponentRef, deleted: boolean): Finding[] {
  const [type, ...rest] = comp.name.split(".");
  const record = rest.join(".");
  if (!type || !record) return [];
  const t = textsOf(model);
  const readers = t.find(new RegExp(`\\b${escapeRe(type)}__mdt\\b`, "i"), comp.file);
  if (!readers.length) return [];
  const quoted = new RegExp(`(?:["']|&quot;|<stringValue>)${escapeRe(record)}(?:["']|&quot;|</stringValue>)`, "i");
  const named = readers.filter((f) => quoted.test(t.get(f) ?? ""));
  if (deleted) {
    return named.length
      ? [
          {
            rule: "cmdt-record-still-referenced",
            severity: "medium",
            title: `Deleted ${type}__mdt record ${record} is still named in code`,
            detail: `${list(named)} read ${type}__mdt and name this record. Lookups by name return nothing once it is deleted.`,
            files: uniq([comp.file, ...named]),
          },
        ]
      : [];
  }
  return [
    {
      rule: "cmdt-record-changed",
      severity: "info",
      title: `${type}__mdt record ${record} changed; ${readers.length} file(s) read this type`,
      detail: `${list(readers)} read ${type}__mdt. A changed value changes their behaviour without a code change${named.length ? `; ${list(named)} name this record directly` : ""}.`,
      files: uniq([comp.file, ...readers]),
    },
  ];
}

// ---- Visualforce ----------------------------------------------------------------------

export interface VisualforceDef {
  name: string;
  file: string;
  kind: "page" | "component";
  /** Apex classes named as controller or extensions. */
  classes: string[];
}

/** Classes named by `controller=` and `extensions=` on the page or component tag. */
export function parseVisualforce(source: string): string[] {
  const out: string[] = [];
  for (const attr of ["controller", "extensions"]) {
    for (const m of source.matchAll(new RegExp(`\\b${attr}\\s*=\\s*"([^"]+)"`, "gi"))) {
      for (const name of (m[1] as string).split(",")) {
        const n = name.trim();
        if (n && n.toLowerCase() !== "standardcontroller") out.push(n);
      }
    }
  }
  return uniq(out);
}

const pagesCache = new WeakMap<OrgModel, VisualforceDef[]>();
/** Every Visualforce page and component in the project. */
export function visualforceDefs(model: OrgModel): VisualforceDef[] {
  let defs = pagesCache.get(model);
  if (!defs) {
    defs = [];
    const t = textsOf(model);
    for (const c of model.components.values()) {
      if (c.metadataType !== "ApexPage" && c.metadataType !== "ApexComponent") continue;
      if (/-meta\.xml$/.test(c.file)) continue;
      const text = t.get(c.file);
      if (text !== undefined)
        defs.push({
          name: c.name,
          file: c.file,
          kind: c.metadataType === "ApexPage" ? "page" : "component",
          classes: parseVisualforce(text),
        });
    }
    pagesCache.set(model, defs);
  }
  return defs;
}

/** Pages and components that use an Apex class as a controller or extension. */
export function pagesUsingClass(model: OrgModel, className: string): VisualforceDef[] {
  const k = key(className);
  return visualforceDefs(model).filter((p) => p.classes.some((c) => key(c) === k));
}

/** A changed Visualforce page or component: classes it names that the project lacks. */
export function visualforceFindings(model: OrgModel, comp: ComponentRef): Finding[] {
  const page = visualforceDefs(model).find((p) => p.file === comp.file);
  if (!page) return [];
  // A name with a dot is namespaced (managed package): out of the project's sight.
  const missing = page.classes.filter((c) => !c.includes(".") && !model.classes.has(key(c)));
  if (!missing.length) return [];
  return [
    {
      rule: "visualforce-missing-reference",
      severity: "medium",
      title: `${comp.name} names Apex class(es) the project does not have: ${missing.join(", ")}`,
      detail: `The ${page.kind} cannot be saved without them. Deploy the classes together, or fix the name.`,
      files: [comp.file],
    },
  ];
}
