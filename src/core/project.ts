// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseApexUnit } from "./apexUnit.js";
import { applyCallGraph } from "./callGraph.js";
import { METADATA_BY_DIR, METADATA_BY_SUFFIX, METADATA_DIR_BY_SUFFIX, METADATA_FOLDERED } from "./metadataTypes.js";
import { ParseCache, type SourceOf, statSignature } from "./parseCache.js";
import {
  agentFileKind,
  emptyAgentMetadata,
  linkAgents,
  parseAgentScript,
  parseAgentTest,
  parseBot,
  parseBotVersion,
  parseGenAiFunction,
  parseGenAiPlugin,
  parsePlanner,
} from "./parsers/agents.js";
import { stripApex } from "./parsers/apex.js";
import { parseField } from "./parsers/fields.js";
import { parseFlow } from "./parsers/flows.js";
import { isBundleSource, parseLightningBundle } from "./parsers/lightning.js";
import { parseFlexiPage, parseLayout } from "./parsers/pages.js";
import { parsePermissionContainer } from "./parsers/permissions.js";
import { parseRecordType } from "./parsers/recordTypes.js";
import { parseValidationRule } from "./parsers/validationRules.js";
import { looksLikeSObject } from "./standardObjects.js";
import type { ApexClassDef, ApexTriggerDef, ComponentRef, ObjectDef, OrgModel } from "./types.js";
import { key, redactEmails, toPosix } from "./util.js";

const SKIP_DIRS = new Set(["node_modules", ".git", ".sfdx", ".sf", ".vscode", ".idea", "dist"]);

function strip(name: string, suffix: string): string {
  return name.slice(0, name.length - suffix.length);
}

/**
 * Classify a metadata file by its SFDX source-format path. Works on any nesting under a
 * package directory because it only looks at the trailing path segments.
 */
export function classifyPath(relPath: string): ComponentRef {
  const file = toPosix(relPath);
  const parts = file.split("/");
  const base = parts[parts.length - 1] ?? file;
  const parent = parts[parts.length - 2];
  const grand = parts[parts.length - 3];
  const great = parts[parts.length - 4];

  if (great === "objects" && grand && parent === "fields" && base.endsWith(".field-meta.xml")) {
    const field = strip(base, ".field-meta.xml");
    return { type: "CustomField", name: `${grand}.${field}`, object: grand, file };
  }
  if (great === "objects" && grand && parent === "validationRules" && base.endsWith(".validationRule-meta.xml")) {
    const rule = strip(base, ".validationRule-meta.xml");
    return { type: "ValidationRule", name: `${grand}.${rule}`, object: grand, file };
  }
  if (grand === "objects" && parent && base === `${parent}.object-meta.xml`) {
    return { type: "CustomObject", name: parent, object: parent, file };
  }
  if (great === "objects" && grand && parent) {
    const name = base.replace(/\.[A-Za-z]+-meta\.xml$/, "");
    return { type: "ObjectChild", name: `${grand}.${parent}.${name}`, object: grand, file };
  }
  if (base.endsWith(".flow-meta.xml")) return { type: "Flow", name: strip(base, ".flow-meta.xml"), file };
  if (base.endsWith(".trigger")) return { type: "ApexTrigger", name: strip(base, ".trigger"), file };
  if (base.endsWith(".trigger-meta.xml")) return { type: "ApexTrigger", name: strip(base, ".trigger-meta.xml"), file };
  if (base.endsWith(".cls")) return { type: "ApexClass", name: strip(base, ".cls"), file };
  if (base.endsWith(".cls-meta.xml")) return { type: "ApexClass", name: strip(base, ".cls-meta.xml"), file };
  if (base.endsWith(".permissionset-meta.xml")) {
    return { type: "PermissionSet", name: strip(base, ".permissionset-meta.xml"), file };
  }
  if (base.endsWith(".profile-meta.xml")) return { type: "Profile", name: strip(base, ".profile-meta.xml"), file };
  if (base.endsWith(".workflow-meta.xml"))
    return { type: "WorkflowRule", name: strip(base, ".workflow-meta.xml"), file };
  const agent = agentFileKind(parts);
  if (agent) return { type: "AgentMetadata", agentKind: agent.kind, name: agent.name, file };
  return classifyOther(parts, file);
}

const SUFFIX_LOWER = new Map(Object.entries(METADATA_BY_SUFFIX).map(([s, t]) => [s.toLowerCase(), t]));
const SUFFIX_DIR = new Map(Object.entries(METADATA_DIR_BY_SUFFIX).map(([s, d]) => [s.toLowerCase(), d.toLowerCase()]));
const DIR_LOWER = new Map(Object.entries(METADATA_BY_DIR).map(([d, t]) => [d.toLowerCase(), t]));

/**
 * Recognize any other Salesforce metadata type from its file suffix (\`Foo.layout-meta.xml\`) or, for
 * bundles and content (\`lwc/foo/foo.js\`), from its folder. Anything not recognized stays "Other".
 */
function classifyOther(parts: string[], file: string): ComponentRef {
  const base = parts[parts.length - 1] ?? file;
  const metadata = (metadataType: string, name: string): ComponentRef => ({
    type: "Metadata",
    metadataType,
    name,
    file,
  });

  // Bundles and content (lwc/foo/foo.js, aura/foo/foo.cmp, staticresources/foo/app.js): the folder
  // names the type and the folder below it the component. A file directly in the folder falls
  // through to the suffix rule. Foldered types (documents/) are named by the suffix rule instead.
  for (let i = 0; i < parts.length - 2; i++) {
    const dir = parts[i] ?? "";
    const type = DIR_LOWER.get(dir.toLowerCase());
    if (type && type !== "CustomObject" && !METADATA_FOLDERED.has(dir)) return metadata(type, parts[i + 1] ?? base);
  }

  // By suffix: Foo.layout-meta.xml, or Foo.page for classic content sitting in its folder (pages/).
  const withMeta = /^(.+)\.([A-Za-z0-9_]+)-meta\.xml$/.exec(base);
  const plain = withMeta ? null : /^(.+)\.([A-Za-z0-9_]+)$/.exec(base);
  const m = withMeta ?? plain;
  if (m) {
    const suffix = (m[2] ?? "").toLowerCase();
    const type = SUFFIX_LOWER.get(suffix);
    const parentDir = (parts[parts.length - 2] ?? "").toLowerCase();
    if (type && (withMeta || SUFFIX_DIR.get(suffix) === parentDir)) {
      // Reports, dashboards, documents and email templates can sit in folders: keep the folder path.
      const folderAt = parts.findIndex((p) => METADATA_FOLDERED.has(p));
      const folders = folderAt >= 0 && folderAt < parts.length - 1 ? parts.slice(folderAt + 1, -1) : [];
      return metadata(type, [...folders, m[1]].join("/"));
    }
  }
  return { type: "Other", name: base, file };
}

/** Read `sfdx-project.json` package directories; fall back to `force-app` or the project root. */
export function sourceRoots(projectDir: string): string[] {
  const projectJson = path.join(projectDir, "sfdx-project.json");
  if (existsSync(projectJson)) {
    try {
      const json = JSON.parse(readFileSync(projectJson, "utf8")) as { packageDirectories?: { path: string }[] };
      const dirs = (json.packageDirectories ?? [])
        .map((d) => d.path)
        .filter((p) => existsSync(path.join(projectDir, p)));
      if (dirs.length) return dirs.map(toPosix);
    } catch {
      // fall through
    }
  }
  if (existsSync(path.join(projectDir, "force-app"))) return ["force-app"];
  return ["."];
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(path.join(dir, entry.name));
    }
  }
}

function ensureObject(model: OrgModel, name: string): ObjectDef {
  let obj = model.objects.get(key(name));
  if (!obj) {
    obj = { name, fields: new Map() };
    model.objects.set(key(name), obj);
  }
  return obj;
}

const MAX_BUNDLE_FILE_BYTES = 1024 * 1024;

/** Read every Lightning Web Component and Aura bundle in the project. */
function loadLightning(model: OrgModel, projectObjects: Set<string>, read: (rel: string) => string): void {
  const bundles = new Map<string, { kind: "lwc" | "aura"; name: string; files: string[] }>();
  for (const ref of model.components.values()) {
    if (ref.type !== "Metadata") continue;
    const kind =
      ref.metadataType === "LightningComponentBundle"
        ? "lwc"
        : ref.metadataType === "AuraDefinitionBundle"
          ? "aura"
          : undefined;
    if (!kind) continue;
    const id = `${kind}:${key(ref.name)}`;
    const b = bundles.get(id) ?? { kind, name: ref.name, files: [] };
    b.files.push(ref.file);
    bundles.set(id, b);
  }
  const isObject = (n: string) => looksLikeSObject(n, projectObjects);
  for (const [id, b] of bundles) {
    const sources = b.files.filter(isBundleSource).flatMap((path) => {
      try {
        const text = read(path);
        return text.length > MAX_BUNDLE_FILE_BYTES ? [] : [{ path, text }];
      } catch {
        return [];
      }
    });
    const main =
      b.files.find((f) => (b.kind === "lwc" ? /\.js-meta\.xml$/ : /\.(cmp|app)$/).test(f)) ?? b.files[0] ?? "";
    model.lightning.set(id, parseLightningBundle(b.kind, b.name, main, sources, isObject));
  }
}

/** Read page layouts and Lightning pages. */
function loadPages(model: OrgModel, read: (rel: string) => string): void {
  for (const ref of model.components.values()) {
    if (ref.type !== "Metadata" || (ref.metadataType !== "Layout" && ref.metadataType !== "FlexiPage")) continue;
    try {
      const xml = read(ref.file);
      if (ref.metadataType === "Layout") model.layouts.set(key(ref.name), parseLayout(xml, ref.name, ref.file));
      else model.flexipages.set(key(ref.name), parseFlexiPage(xml, ref.name, ref.file));
    } catch {
      // unreadable: the page just isn't part of the picture
    }
  }
}

/** Load and parse every supported metadata file in an SFDX project. */
/**
 * Give an Apex definition its `stripped` source (comments and strings blanked), computed the first
 * time something reads it. Only a few checks need it, and computing it for every class on every load
 * cost more than the rest of loading a project whose parse cache is warm.
 */
function lazyStripped<T extends { stripped: string }>(def: Omit<T, "stripped">, src: SourceOf): T {
  let memo: string | undefined;
  Object.defineProperty(def, "stripped", {
    enumerable: true,
    configurable: true,
    get() {
      if (memo === undefined) {
        try {
          memo = stripApex(src.read());
        } catch {
          memo = ""; // removed or unreadable since loading
        }
      }
      return memo;
    },
    set(v: string) {
      memo = v;
    },
  });
  return def as T;
}

export function loadProject(
  projectDirInput: string,
  /** `cacheKey`: use another directory's parse cache (a copy of the same project, e.g. at the base ref). */
  opts: { cache?: boolean; cacheKey?: string; overlay?: Map<string, string> } = {},
): OrgModel {
  const projectDir = path.resolve(projectDirInput);
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw new Error(`Project directory not found: ${projectDir}`);
  }
  const roots = sourceRoots(projectDir);
  const model: OrgModel = {
    projectDir,
    overlay: opts.overlay?.size ? opts.overlay : undefined,
    sourceRoots: roots,
    objects: new Map(),
    validationRules: [],
    flows: new Map(),
    triggers: new Map(),
    classes: new Map(),
    permissionContainers: new Map(),
    agents: new Map(),
    agentTests: [],
    lightning: new Map(),
    layouts: new Map(),
    flexipages: new Map(),
    recordTypes: new Map(),
    components: new Map(),
    warnings: [],
  };

  const files: string[] = [];
  for (const root of roots) walk(path.join(projectDir, root), files);

  const refs = files.map((abs) => classifyPath(toPosix(path.relative(projectDir, abs))));
  for (const ref of refs) model.components.set(ref.file, ref);

  // Objects first, so Apex analysis knows which custom objects exist.
  for (const ref of refs) {
    if (ref.object) ensureObject(model, ref.object);
    if (ref.type === "CustomObject") ensureObject(model, ref.name).file = ref.file;
  }
  const projectObjects = new Set(model.objects.keys());
  const cache = new ParseCache(
    opts.cacheKey ?? projectDir,
    projectObjects,
    opts.cache,
    !opts.cacheKey || path.resolve(opts.cacheKey) === projectDir,
  );

  const read = (rel: string) => opts.overlay?.get(rel) ?? readFileSync(path.join(projectDir, rel), "utf8");
  // Apex sources: read at most once, and only when the cache can't vouch for the file.
  const sources = new Map<string, SourceOf>();
  const sourceOf = (rel: string): SourceOf => {
    let src = sources.get(rel);
    if (!src) {
      let text: string | undefined;
      src = {
        sig: opts.overlay?.has(rel) ? undefined : statSignature(path.join(projectDir, rel)),
        read: () => {
          text ??= read(rel);
          return text;
        },
      };
      sources.set(rel, src);
    }
    return src;
  };
  cache.prefill(
    refs.flatMap((ref): { file: string; kind: "class" | "trigger"; name: string; src: SourceOf }[] =>
      ref.type === "ApexClass" && ref.file.endsWith(".cls")
        ? [{ file: ref.file, kind: "class" as const, name: ref.name, src: sourceOf(ref.file) }]
        : ref.type === "ApexTrigger" && ref.file.endsWith(".trigger")
          ? [{ file: ref.file, kind: "trigger" as const, name: ref.name, src: sourceOf(ref.file) }]
          : [],
    ),
    projectObjects,
  );
  const safely = (ref: ComponentRef, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      // Parser messages can quote the file (a "Context:" excerpt). Agent files can name the agent's
      // runtime user, so they get no details; other messages lose the excerpt and any emails.
      const message = (err as Error).message;
      const context = message.indexOf("Context:");
      const detail = redactEmails((context >= 0 ? message.slice(0, context) : message).trim());
      model.warnings.push(
        ref.type === "AgentMetadata" || !detail
          ? `Could not parse ${ref.file}.`
          : `Could not parse ${ref.file}: ${detail}`,
      );
    }
  };

  const agentMeta = emptyAgentMetadata();
  let processBuilders = 0;
  for (const ref of refs) {
    switch (ref.type) {
      case "CustomField":
        safely(ref, () => {
          const [object, fieldName] = [ref.object!, ref.name.split(".")[1]!];
          const field = parseField(read(ref.file), object, fieldName, ref.file);
          ensureObject(model, object).fields.set(key(field.name), field);
        });
        break;
      case "ValidationRule":
        safely(ref, () => {
          model.validationRules.push(
            parseValidationRule(read(ref.file), ref.object!, ref.name.split(".")[1]!, ref.file),
          );
        });
        break;
      case "Flow":
        safely(ref, () => {
          const flow = parseFlow(read(ref.file), ref.name, ref.file);
          if (flow.processType === "Workflow") processBuilders++;
          model.flows.set(key(flow.name), flow);
        });
        break;
      case "ApexTrigger":
        if (!ref.file.endsWith(".trigger")) break;
        safely(ref, () => {
          const src = sourceOf(ref.file);
          const { def } = cache.get(ref.file, src, (source) =>
            parseApexUnit("trigger", source, ref.name, ref.file, projectObjects),
          ) as { def?: object };
          const trig =
            def &&
            lazyStripped<ApexTriggerDef>(
              { ...(def as Omit<ApexTriggerDef, "stripped" | "file">), file: ref.file },
              src,
            );
          if (trig) model.triggers.set(key(trig.name), trig);
          else model.warnings.push(`No trigger header found in ${ref.file}`);
        });
        break;
      case "ApexClass":
        if (!ref.file.endsWith(".cls")) break;
        safely(ref, () => {
          const src = sourceOf(ref.file);
          const rest = cache.get(ref.file, src, (source) =>
            parseApexUnit("class", source, ref.name, ref.file, projectObjects),
          ) as Omit<ApexClassDef, "stripped" | "name" | "file">;
          const cls = lazyStripped<ApexClassDef>({ ...rest, name: ref.name, file: ref.file }, src);
          model.classes.set(key(cls.name), cls);
        });
        break;
      case "ObjectChild":
        if (!ref.file.endsWith(".recordType-meta.xml") || !ref.object) break;
        safely(ref, () => {
          const short = ref.name.split(".").pop() ?? ref.name;
          const rt = parseRecordType(read(ref.file), ref.object!, short, ref.file);
          model.recordTypes.set(key(`${rt.object}.${rt.name}`), rt);
        });
        break;
      case "PermissionSet":
      case "Profile":
        safely(ref, () => {
          const pc = parsePermissionContainer(
            read(ref.file),
            ref.name,
            ref.type as "PermissionSet" | "Profile",
            ref.file,
          );
          model.permissionContainers.set(key(`${ref.type}:${pc.name}`), pc);
        });
        break;
      case "WorkflowRule":
        break;
      case "AgentMetadata": {
        const file = ref.file;
        const base = file.slice(file.lastIndexOf("/") + 1);
        safely(ref, () => {
          switch (ref.agentKind) {
            case "bot":
              if (base.endsWith(".bot-meta.xml")) agentMeta.bots.push(parseBot(read(file), ref.name, file));
              break;
            case "botVersion":
              agentMeta.botVersions.push({ bot: ref.name, planners: parseBotVersion(read(file)), file });
              break;
            case "planner":
              if (base.endsWith(".genAiPlannerBundle") || base.endsWith(".genAiPlanner-meta.xml"))
                agentMeta.planners.push(parsePlanner(read(file), ref.name, file));
              break;
            case "topic":
              agentMeta.topics.push(parseGenAiPlugin(read(file), ref.name, file));
              break;
            case "action":
              if (base.endsWith(".genAiFunction-meta.xml"))
                agentMeta.actions.push(parseGenAiFunction(read(file), ref.name, file));
              break;
            case "script":
              if (base.endsWith(".agent")) agentMeta.scripts.push(parseAgentScript(read(file), ref.name, file));
              break;
            case "test":
              model.agentTests.push(parseAgentTest(read(file), ref.name, file));
              break;
            default:
              break;
          }
        });
        break;
      }
      default:
        break;
    }
  }

  cache.save();
  loadLightning(model, projectObjects, read);
  loadPages(model, read);
  model.agents = linkAgents(agentMeta, model.warnings);
  applyCallGraph(model);
  for (const def of [...model.classes.values(), ...model.triggers.values()]) {
    const first = def.parseErrors?.[0];
    if (first) {
      model.warnings.push(
        `Apex syntax error in ${def.file} (line ${first.line}: ${first.message}); used heuristic analysis for this file.`,
      );
    }
  }

  if (processBuilders) {
    model.warnings.push(`${processBuilders} Process Builder flow(s) found; Process Builder is not analyzed yet.`);
  }
  return model;
}
