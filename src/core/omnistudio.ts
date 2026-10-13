// SPDX-License-Identifier: Apache-2.0
import { readProjectFile } from "./files.js";
import type { Writer } from "./graph.js";
import type { AutomationRef, ComponentRef, OrgModel, Reference, Write } from "./types.js";
import { bool, key, nodes, parseMetadataXml, text, uniqBy, type XmlNode } from "./util.js";

/**
 * OmniStudio on the standard runtime: OmniScripts, Integration Procedures, Data Mappers
 * (DataRaptors) and FlexCards, as `sf project retrieve` writes them.
 *
 * Their references to each other and to Apex live in JSON strings inside the XML (each element's
 * `propertySetConfig`, a FlexCard's `dataSourceConfig`), not in metadata the platform checks. A broken
 * reference deploys fine and fails when a user runs the script, so these are read here:
 *  - OmniScript and Integration Procedure elements: Remote Actions (`remoteClass`), Data Mapper actions
 *    (`bundle`, and `preTransformBundle` / `postTransformBundle` around an action), Integration Procedure actions (`integrationProcedureKey`), embedded OmniScripts,
 *    custom Lightning Web Components (`lwcName`) and HTTP actions (`namedCredential`).
 *  - FlexCards: their data sources and child cards.
 *  - Data Mappers: the objects and fields an Extract reads and a Load writes.
 *
 * The older managed-package format (Vlocity DataPacks) is not read.
 */

export type OmniKind = "OmniScript" | "IntegrationProcedure" | "DataMapper" | "FlexCard";
export type OmniTargetKind = OmniKind | "ApexClass" | "LightningComponent" | "NamedCredential";

export interface OmniCall {
  kind: OmniTargetKind;
  /** Apex class name, Data Mapper name, `Type_SubType` of a procedure or script, card name, ... */
  target: string;
  method?: string;
  /** The element that makes the call. */
  element?: string;
}

export interface OmniFieldUse {
  object: string;
  field?: string;
}

export interface OmniComponent {
  kind: OmniKind;
  /** What other components use to name it: `Type_SubType`, or the Data Mapper's or card's name. */
  name: string;
  file: string;
  language?: string;
  active: boolean;
  calls: OmniCall[];
  /** Data Mappers: `Extract`, `Turbo Extract`, `Load` or `Transform`. */
  mapperType?: string;
  reads: OmniFieldUse[];
  writes: OmniFieldUse[];
}

const METADATA_KIND: Record<string, OmniKind> = {
  OmniScript: "OmniScript",
  OmniIntegrationProcedure: "IntegrationProcedure",
  OmniDataTransform: "DataMapper",
  OmniUiCard: "FlexCard",
};

export const OMNI_METADATA_TYPES: ReadonlySet<string> = new Set(Object.keys(METADATA_KIND));

export const omniKindOf = (c: ComponentRef): OmniKind | undefined =>
  c.metadataType ? METADATA_KIND[c.metadataType] : undefined;

const KIND_LABEL: Record<OmniTargetKind, string> = {
  OmniScript: "OmniScript",
  IntegrationProcedure: "Integration Procedure",
  DataMapper: "Data Mapper",
  FlexCard: "FlexCard",
  ApexClass: "Apex class",
  LightningComponent: "Lightning component",
  NamedCredential: "named credential",
};
export const omniLabel = (kind: OmniTargetKind) => KIND_LABEL[kind];

/** "Data Mapper OrderLoad" for OmniStudio kinds, "Kind Name" for the rest. */
export const refLabel = (r: { kind: string; name: string }) =>
  r.kind in KIND_LABEL ? `${KIND_LABEL[r.kind as OmniTargetKind]} ${r.name}` : `${r.kind} ${r.name}`;

const IDENT = /^[A-Za-z][\w]*$/;

function parseJson(raw: unknown): unknown {
  const s = text(raw);
  if (!s || !/^\s*[[{]/.test(s)) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const nonEmpty = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : undefined;
  return s ? s : undefined;
};

/**
 * The references in one element's (or card's) settings. Keys are specific to OmniStudio, so they are
 * looked for at any depth (a Step's `remoteOptions`, a card's `dataSource.value`, ...).
 */
export function callsInSettings(settings: unknown, element?: string, elementType?: string): OmniCall[] {
  const out: OmniCall[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 12 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    const remote = nonEmpty(o.remoteClass);
    if (remote) out.push({ kind: "ApexClass", target: remote, method: nonEmpty(o.remoteMethod), element });
    // A FlexCard's Apex data source.
    const cls = nonEmpty(o.className) ?? nonEmpty(o.apexClass);
    if (cls && IDENT.test(cls.replace(/^\w+\./, "")))
      out.push({ kind: "ApexClass", target: cls, method: nonEmpty(o.methodName), element });
    const bundle = nonEmpty(o.bundle) ?? nonEmpty(o.bundleName);
    if (bundle) out.push({ kind: "DataMapper", target: bundle, element });
    // Data Mappers that reshape an action's input and output.
    for (const k of ["preTransformBundle", "postTransformBundle"]) {
      const t = nonEmpty(o[k]);
      if (t) out.push({ kind: "DataMapper", target: t, element });
    }
    const ip = nonEmpty(o.integrationProcedureKey) ?? nonEmpty(o.ipMethod);
    if (ip) out.push({ kind: "IntegrationProcedure", target: ip, element });
    const lwc = nonEmpty(o.lwcName);
    if (lwc) out.push({ kind: "LightningComponent", target: lwc.replace(/^c[-:]/, ""), element });
    const nc = nonEmpty(o.namedCredential);
    if (nc) out.push({ kind: "NamedCredential", target: nc, element });
    const card = nonEmpty(o.cardName);
    if (card) out.push({ kind: "FlexCard", target: card, element });
    for (const v of Object.values(o)) visit(v, depth + 1);
  };
  visit(settings, 0);
  // An embedded OmniScript names its script by Type and Sub Type.
  if (elementType && /^omniscript$/i.test(elementType.trim()) && settings && typeof settings === "object") {
    const s = settings as Record<string, unknown>;
    const type = nonEmpty(s.Type) ?? nonEmpty(s.type);
    const sub = nonEmpty(s["Sub Type"]) ?? nonEmpty(s.subType);
    if (type && sub) out.push({ kind: "OmniScript", target: `${type}_${sub}`, element });
  }
  return uniqBy(out, (c) => `${c.kind}|${key(c.target)}|${key(c.method ?? "")}|${c.element ?? ""}`);
}

/** Every element below a node, however deeply nested (blocks hold child elements). */
function elementsOf(node: unknown, out: XmlNode[] = [], depth = 0): XmlNode[] {
  if (depth > 40) return out;
  for (const n of nodes(node)) {
    if ("propertySetConfig" in n || "type" in n) out.push(n);
    for (const [k, v] of Object.entries(n))
      if (k !== "propertySetConfig" && typeof v === "object") elementsOf(v, out, depth + 1);
  }
  return out;
}

/** `Alias:Field`, `Field`, `Parent.Field` → the field on the object, when it is a plain name. */
function fieldOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const last = raw.split(":").pop()!.trim();
  return IDENT.test(last) ? last : undefined;
}

export function parseOmni(kind: OmniKind, xml: string, fallbackName: string, file: string): OmniComponent {
  const body = parseMetadataXml(xml).body;
  const base: OmniComponent = {
    kind,
    name: fallbackName,
    file,
    // Data Mappers write `<active>`; the others `<isActive>`.
    active: (body.isActive ?? body.active) === undefined ? true : bool(body.isActive ?? body.active),
    calls: [],
    reads: [],
    writes: [],
  };
  switch (kind) {
    case "OmniScript":
    case "IntegrationProcedure": {
      const type = text(body.type);
      const sub = text(body.subType);
      base.name = type && sub ? `${type}_${sub}` : (text(body.omniProcessKey) ?? fallbackName);
      base.language = text(body.language);
      for (const el of elementsOf(body.omniProcessElements)) {
        if (el.isActive !== undefined && !bool(el.isActive)) continue;
        base.calls.push(...callsInSettings(parseJson(el.propertySetConfig), text(el.name), text(el.type)));
      }
      break;
    }
    case "FlexCard": {
      base.name = text(body.name) ?? fallbackName;
      for (const field of ["dataSourceConfig", "propertySetConfig"])
        base.calls.push(...callsInSettings(parseJson(body[field])));
      base.calls = base.calls.filter((c) => !(c.kind === "FlexCard" && key(c.target) === key(base.name)));
      break;
    }
    case "DataMapper": {
      base.name = text(body.name) ?? fallbackName;
      base.mapperType = text(body.type);
      const items = nodes(body.omniDataTransformItem);
      const load = /load/i.test(base.mapperType ?? "");
      const extract = /extract/i.test(base.mapperType ?? "");
      // An Extract's field mappings name the object by its extract step's alias (`Acct:Name`).
      const inputs = new Map<string, string>();
      for (const it of items) {
        const obj = text(it.inputObjectName);
        if (obj && IDENT.test(obj)) {
          inputs.set(key(obj), obj);
          const alias = text(it.outputFieldName) ?? text(it.globalKey);
          if (alias && IDENT.test(alias)) inputs.set(key(alias), obj);
        }
      }
      for (const it of items) {
        if (extract) {
          const obj = text(it.inputObjectName);
          const raw = text(it.inputFieldName);
          if (obj && IDENT.test(obj)) {
            base.reads.push({ object: obj, field: fieldOf(raw) });
          } else if (raw?.includes(":")) {
            const alias = raw.split(":")[0]!.trim();
            const object = inputs.get(key(alias)) ?? (inputs.size === 1 ? [...inputs.values()][0] : undefined);
            const field = fieldOf(raw);
            if (object && field) base.reads.push({ object, field });
          }
          const lookup = text(it.lookupObjectName);
          if (lookup && IDENT.test(lookup))
            base.reads.push({ object: lookup, field: fieldOf(text(it.lookupKeyField)) });
        }
        if (load) {
          const obj = text(it.outputObjectName);
          if (obj && IDENT.test(obj)) base.writes.push({ object: obj, field: fieldOf(text(it.outputFieldName)) });
          const lookup = text(it.lookupObjectName);
          if (lookup && IDENT.test(lookup))
            base.reads.push({ object: lookup, field: fieldOf(text(it.lookupKeyField)) });
        }
      }
      base.reads = uniqBy(base.reads, (u) => key(`${u.object}.${u.field ?? ""}`));
      base.writes = uniqBy(base.writes, (u) => key(`${u.object}.${u.field ?? ""}`));
      break;
    }
  }
  return base;
}

const cache = new WeakMap<OrgModel, OmniComponent[]>();

/** Every OmniStudio component in the project (parsed on first use). */
export function omniOf(model: OrgModel): OmniComponent[] {
  let all = cache.get(model);
  if (all) return all;
  all = [];
  for (const c of model.components.values()) {
    const kind = omniKindOf(c);
    if (!kind || !c.file.endsWith(".xml")) continue;
    try {
      all.push(parseOmni(kind, readProjectFile(model, c.file), c.name, c.file));
    } catch {
      model.warnings.push(`Could not parse ${c.file}.`);
    }
  }
  cache.set(model, all);
  return all;
}

/** The project's component(s) of a kind with a name (an OmniScript or procedure can have several versions). */
export function omniNamed(model: OrgModel, kind: OmniKind, name: string): OmniComponent[] {
  const k = key(name);
  return omniOf(model).filter((o) => o.kind === kind && key(o.name) === k);
}

export const omniRef = (o: OmniComponent): AutomationRef => ({ kind: o.kind, name: o.name, file: o.file });

/** OmniStudio components that call a target (one entry per component name, preferring the active version). */
export function omniCallersOf(model: OrgModel, kind: OmniTargetKind, target: string): OmniComponent[] {
  const k = key(target);
  const callers = omniOf(model).filter((o) => o.calls.some((c) => c.kind === kind && key(c.target) === k));
  return uniqBy(
    [...callers].sort((a, b) => Number(b.active) - Number(a.active)),
    (o) => `${o.kind}|${key(o.name)}`,
  );
}

/** Data Mappers that read or write `Object.Field`. */
export function omniFieldReferences(model: OrgModel, object: string, field: string): Reference[] {
  const [ok, fk] = [key(object), key(field)];
  const out: Reference[] = [];
  for (const o of omniOf(model)) {
    if (o.kind !== "DataMapper") continue;
    if ([...o.reads, ...o.writes].some((u) => key(u.object) === ok && u.field && key(u.field) === fk))
      out.push({ from: omniRef(o), to: `${object}.${field}` });
  }
  return uniqBy(out, (r) => `${key(r.from.name)}`);
}

/** Data Mapper Loads that write `object`: they run the object's save automation like any other write. */
export function omniWriters(model: OrgModel, object: string): Writer[] {
  const k = key(object);
  const out: Writer[] = [];
  for (const o of omniOf(model)) {
    if (o.kind !== "DataMapper") continue;
    const fields = o.writes.filter((w) => key(w.object) === k);
    if (!fields.length) continue;
    const write: Write = {
      object: fields[0]!.object,
      op: "upsert",
      fields: fields.flatMap((f) => (f.field ? [f.field] : [])),
      via: `Data Mapper ${o.name}`,
      confidence: "high",
    };
    out.push({ automation: omniRef(o), writes: [write] });
  }
  return out;
}

const CALLABLE = /\bimplements\b[^{]*?\b(?:(?:System\s*\.\s*)?Callable|(?:\w+\s*\.\s*)?VlocityOpenInterface2?)\b/i;
const EXTENDS = /\bclass\s+\w+\s+extends\s+([\w.]+)/i;

/**
 * Whether an Apex class can be a Remote Action's class: it implements `Callable` or the managed
 * package's `VlocityOpenInterface(2)`, itself or through a parent class in the project. Undefined when
 * that can't be told (the class or a parent isn't in the project).
 */
export function remoteCallable(model: OrgModel, className: string, seen = new Set<string>()): boolean | undefined {
  const k = key(className);
  if (seen.has(k)) return undefined;
  seen.add(k);
  const cls = model.classes.get(k);
  if (!cls) return undefined;
  const header = cls.stripped.slice(0, Math.max(0, cls.stripped.indexOf("{")) || cls.stripped.length);
  if (CALLABLE.test(header)) return true;
  const parent = EXTENDS.exec(header)?.[1];
  if (parent) return remoteCallable(model, parent, seen);
  return false;
}

/** Is a call's target in the project? Undefined when it can't be (another namespace's class). */
export function resolves(model: OrgModel, call: OmniCall): boolean | undefined {
  switch (call.kind) {
    case "ApexClass":
      return call.target.includes(".") ? undefined : model.classes.has(key(call.target));
    case "LightningComponent":
      return model.lightning.has(`lwc:${key(call.target)}`);
    case "NamedCredential": {
      const k = key(call.target);
      return [...model.components.values()].some((c) => c.metadataType === "NamedCredential" && key(c.name) === k);
    }
    default:
      return omniNamed(model, call.kind, call.target).length > 0;
  }
}

/** Call cycles among procedures and scripts that include `start` (each as a list of names). */
export function omniCycles(model: OrgModel, start: OmniComponent): string[][] {
  const node = (kind: string, name: string) => `${kind}:${key(name)}`;
  const label = new Map<string, string>();
  const edges = new Map<string, string[]>();
  for (const o of omniOf(model)) {
    if (o.kind !== "IntegrationProcedure" && o.kind !== "OmniScript") continue;
    if (!o.active && omniNamed(model, o.kind, o.name).some((v) => v.active)) continue;
    const n = node(o.kind, o.name);
    label.set(n, `${omniLabel(o.kind)} ${o.name}`);
    const next = o.calls
      .filter((c) => c.kind === "IntegrationProcedure" || c.kind === "OmniScript")
      .map((c) => node(c.kind, c.target));
    edges.set(n, [...(edges.get(n) ?? []), ...next]);
  }
  const from = node(start.kind, start.name);
  const cycles: string[][] = [];
  const path: string[] = [];
  const onPath = new Set<string>();
  const visited = new Set<string>();
  const dfs = (n: string) => {
    if (cycles.length >= 3) return;
    if (onPath.has(n)) {
      if (n === from) cycles.push([...path, n].map((x) => label.get(x) ?? x));
      return;
    }
    if (visited.has(n)) return;
    visited.add(n);
    onPath.add(n);
    path.push(n);
    for (const m of edges.get(n) ?? []) dfs(m);
    path.pop();
    onPath.delete(n);
  };
  dfs(from);
  return cycles;
}

/**
 * What a procedure or script ends up saving: Data Mapper Loads and Remote Action classes, through
 * nested procedures. Returns the components that write, and the objects.
 */
export function omniSaves(
  model: OrgModel,
  start: OmniComponent,
  classWrites: (className: string) => Write[],
  maxDepth = 4,
): { via: OmniComponent | string; write: Write }[] {
  const out: { via: OmniComponent | string; write: Write }[] = [];
  const seen = new Set<string>();
  const walk = (o: OmniComponent, depth: number) => {
    const k = `${o.kind}|${key(o.name)}`;
    if (seen.has(k) || depth > maxDepth) return;
    seen.add(k);
    for (const c of o.calls) {
      if (c.kind === "DataMapper")
        for (const dm of omniNamed(model, "DataMapper", c.target))
          for (const w of dm.writes)
            out.push({
              via: dm,
              write: { object: w.object, op: "upsert", via: `Data Mapper ${dm.name}`, confidence: "high" },
            });
      else if (c.kind === "ApexClass") for (const w of classWrites(c.target)) out.push({ via: c.target, write: w });
      else if (c.kind === "IntegrationProcedure" || c.kind === "OmniScript")
        for (const next of omniNamed(model, c.kind, c.target)) walk(next, depth + 1);
    }
  };
  walk(start, 0);
  return uniqBy(out, (x) => `${key(x.write.object)}|${x.write.op}`);
}
