// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  accessRemovedFindings,
  groupsIncluding,
  guestFindings,
  mutingFindings,
  parseMuting,
  parsePermissionSetGroup,
  parseSharingModel,
  parseSharingRules,
  permissionSetGroupFindings,
  sharingModelFindings,
  sharingRuleFindings,
} from "./access.js";
import {
  actionsForAgentChange,
  actionTarget,
  actionWrites,
  analyzeAgents,
  stillReferenced,
  targetRef,
} from "./agentImpact.js";
import { buildCoverage } from "./coverage.js";
import { fieldUsers, isNamespaced, missingFieldFindings, parseFieldUser } from "./fieldUsers.js";
import { readProjectFile } from "./files.js";
import {
  callersOfClass,
  callersOfFlow,
  classWrites,
  flexipagesPlacing,
  flowWrites,
  knownClassRefs,
  lightningCallingClass,
  lightningEmbedding,
  writersOf,
} from "./graph.js";
import {
  INTEGRATION_TYPES,
  integrationFindings,
  outboundMessageFindings,
  outboundMessagesOf,
  parseIntegration,
  parseOutboundMessages,
} from "./integrations.js";
import {
  type OmniComponent,
  omniCallersOf,
  omniCycles,
  omniFieldReferences,
  omniKindOf,
  omniLabel,
  omniNamed,
  omniOf,
  omniRef,
  omniSaves,
  parseOmni,
  refLabel,
  remoteCallable,
  resolves,
} from "./omnistudio.js";
import { saveProcedure } from "./orderOfExecution.js";
import { customComponent, parseFlexiPage, parseLayout } from "./parsers/pages.js";
import { parsePermissionContainer } from "./parsers/permissions.js";
import { picklistFindings, recordTypeFindings } from "./picklists.js";
import { classifyPath } from "./project.js";
import { referenceFindings } from "./references.js";
import {
  isPlatformEvent,
  parseSaveRuleFile,
  platformEventFindings,
  rulesReadingField,
  SAVE_RULE_TYPES,
  saveRuleChangeFindings,
  automationRef as saveRuleRef,
  saveRulesOf,
} from "./saveRules.js";
import type {
  AnalysisResult,
  ApexAnalysis,
  AutomationRef,
  CascadeNode,
  Change,
  ComponentRef,
  DmlOp,
  Finding,
  FlexiPageDef,
  LoopIssue,
  OrgModel,
  PermissionContainerDef,
  Provenance,
  Reference,
  SaveEvent,
  SaveProcedure,
  Severity,
  SuggestedTest,
} from "./types.js";
import { customMetadataFindings, labelFindings, pagesUsingClass, visualforceFindings } from "./usage.js";
import { key, uniq, uniqBy } from "./util.js";

export interface AnalyzeOptions {
  model: OrgModel;
  changes: Change[];
  ignoredFiles?: string[];
  base?: string;
  head?: string;
  /** Max cascade depth (default 4). */
  maxDepth?: number;
  /** Commit authorship for the analyzed range (see provenance.ts). */
  provenance?: Provenance;
  /** Read a project-relative file at the base ref, to diff permission sets. */
  readBase?: (file: string) => string | undefined;
}

interface Root {
  object: string;
  event: SaveEvent;
  via: AutomationRef;
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
const AUTOMATION_KINDS = new Set(["Flow", "ApexTrigger", "ApexClass", "RollUpSummary"]);
const SENSITIVE_USER_PERMS = new Set(
  [
    "ModifyAllData",
    "ViewAllData",
    "ManageUsers",
    "AuthorApex",
    "CustomizeApplication",
    "ModifyMetadata",
    "ManageProfilesPermissionsets",
  ].map((p) => p.toLowerCase()),
);
const MAX_NODES = 400;

export function opToEvent(op: DmlOp): SaveEvent {
  if (op === "upsert") return "update";
  return op;
}

const describe = (a: AutomationRef) => {
  switch (a.kind) {
    case "Flow":
      return `flow ${a.name}`;
    case "ApexTrigger":
      return `trigger ${a.name}`;
    case "ApexClass":
      return `class ${a.name}`;
    case "ValidationRule":
      return `validation rule ${a.name}`;
    case "RollUpSummary":
      return `roll-up ${a.name}`;
    case "DuplicateRule":
      return `duplicate rule ${a.name}`;
    case "AssignmentRule":
      return `assignment rule ${a.name}`;
    case "AutoResponseRule":
      return `auto-response rule ${a.name}`;
    case "EscalationRule":
      return `escalation rule ${a.name}`;
    case "ApprovalProcess":
      return `approval process ${a.name}`;
    case "OmniScript":
    case "IntegrationProcedure":
    case "DataMapper":
    case "FlexCard":
      return `${omniLabel(a.kind)} ${a.name}`;
    default:
      return a.name;
  }
};

const isLightningBundle = (c: ComponentRef): boolean =>
  c.metadataType === "LightningComponentBundle" || c.metadataType === "AuraDefinitionBundle";

export function analyze(opts: AnalyzeOptions): AnalysisResult {
  const { model, changes } = opts;
  const maxDepth = opts.maxDepth ?? 4;
  const roots: Root[] = [];
  const references: Reference[] = [];
  const findings: Finding[] = [];
  const tests: SuggestedTest[] = [];
  const changedFiles = new Set(changes.map((c) => c.component.file));
  const changedAutomation = new Set<string>(); // "Kind:name" lower
  const coverage = buildCoverage(model, changes);

  const addFinding = (f: Finding) => findings.push(f);
  const readCurrent = (file: string): string | undefined => {
    try {
      return readProjectFile(model, file);
    } catch {
      return undefined;
    }
  };
  const changeRef = (c: Change): AutomationRef => ({ kind: "Change", name: c.component.name, file: c.component.file });

  /** A changed Lightning Web Component or Aura bundle. */
  const analyzeLightning = (change: Change) => {
    const comp = change.component;
    const lc = model.lightning.get(
      `${comp.metadataType === "AuraDefinitionBundle" ? "aura" : "lwc"}:${key(comp.name)}`,
    );
    if (change.changeType === "deleted" || !lc) {
      const embedders = lightningEmbedding(model, comp.name);
      const pages = flexipagesPlacing(model, comp.name);
      if (embedders.length || pages.length) {
        const users = [...embedders.map((e) => e.name), ...pages.map((p) => `page ${p.name}`)];
        addFinding({
          rule: "deleted-still-referenced",
          severity: "high",
          title: `Deleted component ${comp.name} is still used`,
          detail: `Used by ${users.join(", ")}. The deployment will fail or the pages will break.`,
          files: uniq([comp.file, ...embedders.map((e) => e.file), ...pages.map((p) => p.file)]),
        });
      }
      return;
    }
    const placedOn = flexipagesPlacing(model, comp.name);
    if (placedOn.length) {
      addFinding({
        rule: "lightning-on-page",
        severity: "info",
        title: `${comp.name} is placed on ${placedOn.length} Lightning page(s)`,
        detail: `${placedOn.map((p) => p.name).join(", ")}. Open them to check the component renders and behaves as intended.`,
        files: uniq([lc.file, ...placedOn.map((p) => p.file)]),
      });
    }
    // What the component saves through the Apex it calls.
    for (const cls of uniqBy(lc.apex, (a) => key(a.cls)).flatMap((a) => model.classes.get(key(a.cls)) ?? [])) {
      for (const w of classWrites(model, cls))
        roots.push({ object: w.object, event: opToEvent(w.op), via: changeRef(change) });
    }
    // Things it names that the project does not have.
    const missing: string[] = [];
    for (const f of lc.fields) {
      const [object, field] = f.split(".") as [string, string];
      const def = model.objects.get(key(object));
      if (def && key(field).endsWith("__c") && !isNamespaced(field) && !def.fields.has(key(field)))
        missing.push(`field ${f}`);
    }
    for (const a of lc.apex) if (!model.classes.has(key(a.cls))) missing.push(`Apex class ${a.cls}`);
    if (missing.length) {
      addFinding({
        rule: "lightning-missing-reference",
        severity: "medium",
        title: `${comp.name} uses ${missing.length} thing(s) that are not in the project`,
        detail: `${uniq(missing).join(", ")}. The deployment fails unless they exist in the target org already.`,
        files: [lc.file],
      });
    }
  };

  /** A changed page layout or Lightning page: what it no longer shows, and what it names that the project lacks. */
  const analyzePage = (change: Change) => {
    const comp = change.component;
    if (change.changeType === "deleted") return;
    const layout = comp.metadataType === "Layout";
    const cur = layout ? model.layouts.get(key(comp.name)) : model.flexipages.get(key(comp.name));
    if (!cur) return;
    const baseXml = opts.readBase?.(comp.file);
    const prev = baseXml
      ? layout
        ? parseLayout(baseXml, comp.name, comp.file)
        : parseFlexiPage(baseXml, comp.name, comp.file)
      : undefined;
    const object = "object" in cur ? cur.object : undefined;
    const fieldNames = (page: typeof cur): string[] =>
      "object" in page && layout ? page.fields.map((f) => `${page.object}.${f}`) : page.fields;

    const missing: string[] = [];
    for (const f of fieldNames(cur)) {
      const [obj, field] = f.split(".") as [string, string];
      const def = model.objects.get(key(obj));
      if (def && key(field).endsWith("__c") && !isNamespaced(field) && !def.fields.has(key(field)))
        missing.push(`field ${f}`);
    }
    if (!layout) {
      for (const c of (cur as FlexiPageDef).components) {
        const custom = customComponent(c);
        if (custom && !model.lightning.has(`lwc:${key(custom)}`) && !model.lightning.has(`aura:${key(custom)}`))
          missing.push(`component ${c}`);
      }
    }
    if (missing.length) {
      addFinding({
        rule: "page-missing-reference",
        severity: "medium",
        title: `${comp.name} uses ${missing.length} thing(s) that are not in the project`,
        detail: `${uniq(missing).join(", ")}. The deployment fails unless they exist in the target org already.`,
        object,
        files: [comp.file],
      });
    }

    if (prev) {
      const now = new Set([...fieldNames(cur), ...(layout ? [] : (cur as FlexiPageDef).components)].map(key));
      const before = [...fieldNames(prev), ...(layout ? [] : (prev as FlexiPageDef).components)];
      const removed = uniq(before.filter((x) => !now.has(key(x))));
      if (removed.length) {
        addFinding({
          rule: "page-element-removed",
          severity: "low",
          title: `${comp.name} no longer shows ${removed.length} item(s)`,
          detail: `${removed.slice(0, 8).join(", ")}${removed.length > 8 ? ` and ${removed.length - 8} more` : ""}. Users of ${layout ? "this layout" : "this page"} lose them; confirm that is intended.`,
          object,
          files: [comp.file],
        });
      }
    }
  };

  /** Remote Actions whose class can't be called by OmniStudio (no `Callable` or open interface). */
  const notCallableFindings = (callers: OmniComponent[], className: string): Finding[] => {
    if (!callers.length || remoteCallable(model, className) !== false) return [];
    const cls = model.classes.get(key(className));
    return [
      {
        rule: "omnistudio-remote-not-callable",
        severity: "high",
        title: `${cls?.name ?? className} is a Remote Action's class but does not implement Callable`,
        detail: `${callers.map((c) => `${omniLabel(c.kind)} ${c.name}`).join(", ")} ${callers.length === 1 ? "calls" : "call"} it as a Remote Action. OmniStudio calls remote classes through \`System.Callable\` (or the managed package's \`VlocityOpenInterface2\`); without it the action fails when the script runs. Implement the interface and dispatch on the method name.`,
        files: uniq([...(cls ? [cls.file] : []), ...callers.map((c) => c.file)]),
      },
    ];
  };

  /** A changed OmniScript, Integration Procedure, Data Mapper or FlexCard. */
  const analyzeOmni = (change: Change) => {
    const comp = change.component;
    const kind = omniKindOf(comp)!;
    const current = omniOf(model).find((o) => o.file === comp.file);
    if (change.changeType === "deleted" || !current) {
      // Its name is in its content: read it as it was.
      let name = comp.name;
      const baseXml = opts.readBase?.(comp.file);
      if (baseXml) {
        try {
          name = parseOmni(kind, baseXml, comp.name, comp.file).name;
        } catch {
          // keep the file's name
        }
      }
      if (omniNamed(model, kind, name).length) return; // another version is still there
      const callers = omniCallersOf(model, kind, name);
      if (callers.length) {
        addFinding({
          rule: "deleted-still-referenced",
          severity: "high",
          title: `Deleted ${omniLabel(kind)} ${name} is still used`,
          detail: `Used by ${callers.map((c) => `${omniLabel(c.kind)} ${c.name}`).join(", ")}. The deployment succeeds, but those fail when they run.`,
          files: uniq([comp.file, ...callers.map((c) => c.file)]),
        });
      }
      return;
    }
    const versions = omniNamed(model, kind, current.name);
    const callers = omniCallersOf(model, kind, current.name).filter((c) => c.file !== current.file);
    if (callers.length) {
      addFinding({
        rule: "omnistudio-used-by",
        severity: "info",
        title: `${omniLabel(kind)} ${current.name} is used by ${callers.length} OmniStudio component(s)`,
        detail: `${callers.map((c) => `${omniLabel(c.kind)} ${c.name}`).join(", ")}. A changed input, output or response shape reaches them; run them after deploying.`,
        files: uniq([current.file, ...callers.map((c) => c.file)]),
      });
      if (!current.active && !versions.some((v) => v.active)) {
        addFinding({
          rule: "omnistudio-inactive-in-use",
          severity: "medium",
          title: `${omniLabel(kind)} ${current.name} is inactive but still used`,
          detail: `${callers.map((c) => `${omniLabel(c.kind)} ${c.name}`).join(", ")} ${callers.length === 1 ? "calls" : "call"} it, and no active version is in the project. They fail when they run unless the target org has an active version.`,
          files: uniq([current.file, ...callers.map((c) => c.file)]),
        });
      }
    }
    // What it calls that the project doesn't have.
    const missing: string[] = [];
    for (const c of current.calls) {
      if (resolves(model, c) === false)
        missing.push(`${omniLabel(c.kind)} ${c.target}${c.element ? ` (element ${c.element})` : ""}`);
    }
    for (const u of [...current.reads, ...current.writes]) {
      if (!u.field) continue;
      const def = model.objects.get(key(u.object));
      if (
        def &&
        key(u.field).endsWith("__c") &&
        !isNamespaced(u.field) &&
        def.fields.size > 0 &&
        !def.fields.has(key(u.field))
      )
        missing.push(`field ${u.object}.${u.field}`);
    }
    if (missing.length) {
      addFinding({
        rule: "omnistudio-missing-reference",
        severity: "medium",
        title: `${omniLabel(kind)} ${current.name} uses ${uniq(missing).length} thing(s) that are not in the project`,
        detail: `${uniq(missing).join(", ")}. OmniStudio names them in its settings, so the deployment does not check them: it fails when it runs unless they exist in the target org already.`,
        files: [current.file],
      });
    }
    // Remote Actions whose class can't be called.
    for (const cls of uniq(current.calls.filter((c) => c.kind === "ApexClass").map((c) => key(c.target))))
      findings.push(...notCallableFindings([current], cls));
    // Procedures and scripts that end up calling themselves.
    if (kind === "IntegrationProcedure" || kind === "OmniScript") {
      const cycles = omniCycles(model, current);
      if (cycles.length) {
        addFinding({
          rule: "omnistudio-cycle",
          severity: "medium",
          title: `${omniLabel(kind)} ${current.name} calls itself through other components`,
          detail: `${cycles.map((c) => c.join(" → ")).join("; ")}. Unless a condition stops it, it runs until it hits a limit.`,
          files: [current.file],
        });
      }
    }
    // What it saves, so the objects' save automation is analyzed too.
    const writes: { object: string; op: DmlOp }[] =
      kind === "DataMapper"
        ? current.writes.map((w) => ({ object: w.object, op: "upsert" }))
        : omniSaves(model, current, (name) => {
            const cls = model.classes.get(key(name));
            return cls ? classWrites(model, cls) : [];
          }).map((x) => x.write);
    for (const w of uniqBy(writes, (x) => key(x.object)))
      for (const event of w.op === "upsert" ? (["insert", "update"] as const) : [opToEvent(w.op)])
        roots.push({ object: w.object, event, via: omniRef(current) });
  };

  // ------------------------------------------------------------------------------------
  // 1. Seed roots, references and change-specific findings
  // ------------------------------------------------------------------------------------
  for (const change of changes) {
    const comp = change.component;
    const deleted = change.changeType === "deleted";
    // Every type: a deleted or renamed component that other files still name.
    const named = referenceFindings(model, change, change.previousFile ? classifyPath(change.previousFile) : undefined);
    findings.push(...named);
    switch (comp.type) {
      case "CustomField": {
        const [object, field] = [comp.object!, comp.name.split(".")[1]!];
        if (isPlatformEvent(object)) findings.push(...platformEventFindings(model, comp, object, deleted));
        roots.push(
          { object, event: "update", via: changeRef(change) },
          { object, event: "insert", via: changeRef(change) },
        );
        const refs = fieldReferences(model, object, field);
        references.push(...refs);
        const nonPermRefs = refs.filter((r) => r.from.kind !== "PermissionSet" && r.from.kind !== "Profile");
        if (deleted && nonPermRefs.length) {
          addFinding({
            rule: "deleted-still-referenced",
            severity: "high",
            title: `Deleted field ${comp.name} is still referenced`,
            detail: `Referenced by ${nonPermRefs.map((r) => refLabel(r.from)).join(", ")}. The deployment will fail or the references will break.`,
            object,
            files: uniq([comp.file, ...nonPermRefs.map((r) => r.from.file).filter((f): f is string => !!f)]),
          });
        }
        const lightningRefs = refs.filter((r) => r.from.kind === "LightningComponent");
        if (!deleted && lightningRefs.length) {
          addFinding({
            rule: "field-used-by-lightning",
            severity: "low",
            title: `${comp.name} is used by ${lightningRefs.length} Lightning component(s)`,
            detail: `${lightningRefs.map((r) => r.from.name).join(", ")} read or show this field. Check the component after changing its type, values or access.`,
            object,
            files: uniq([comp.file, ...lightningRefs.map((r) => r.from.file).filter((f): f is string => !!f)]),
          });
        }
        const pageRefs = refs.filter((r) => r.from.kind === "Layout" || r.from.kind === "FlexiPage");
        if (!deleted && pageRefs.length) {
          addFinding({
            rule: "field-on-page",
            severity: "info",
            title: `${comp.name} is on ${pageRefs.length} page layout(s) or Lightning page(s)`,
            detail: `${pageRefs.map((r) => `${r.from.kind === "Layout" ? "layout" : "page"} ${r.from.name}`).join(", ")}. A changed label, type or access shows up there.`,
            object,
            files: uniq([comp.file, ...pageRefs.map((r) => r.from.file).filter((f): f is string => !!f)]),
          });
        }
        if (!deleted) findings.push(...picklistFindings(model, comp, object, field, opts.readBase?.(comp.file)));
        const vrRefs = refs.filter((r) => r.from.kind === "ValidationRule");
        for (const r of vrRefs) {
          const vr = model.validationRules.find((v) => v.name === r.from.name && key(v.object) === key(object));
          if (!vr?.active) continue;
          addFinding({
            rule: "field-used-by-validation-rule",
            severity: "medium",
            title: `${comp.name} is checked by validation rule ${vr.name}`,
            detail: `Every automation that saves ${object} must satisfy: ${vr.formula.replace(/\s+/g, " ").trim()}`,
            object,
            files: [comp.file, vr.file],
          });
          tests.push({
            kind: "boundary",
            object,
            description: `Save ${object} with ${field} blank and at boundary values; assert ${vr.name} fires only when intended.`,
            covers: [comp.name, vr.fullName],
          });
        }
        break;
      }

      case "ValidationRule": {
        const object = comp.object!;
        roots.push(
          { object, event: "update", via: changeRef(change) },
          { object, event: "insert", via: changeRef(change) },
        );
        const vr = model.validationRules.find((v) => key(v.fullName) === key(comp.name));
        if (deleted || !vr) {
          addFinding({
            rule: "validation-rule-removed",
            severity: "info",
            title: `Validation rule ${comp.name} removed`,
            detail: "Data that was previously blocked can now be saved.",
            object,
            files: [comp.file],
          });
          break;
        }
        if (!vr.active) {
          addFinding({
            rule: "validation-rule-inactive",
            severity: "info",
            title: `Validation rule ${comp.name} is inactive`,
            detail: "Inactive rules do not run.",
            object,
            files: [vr.file],
          });
          break;
        }
        const writers = writersOf(model, object);
        if (writers.length) {
          addFinding({
            rule: "validation-rule-vs-existing-automation",
            severity: change.changeType === "added" ? "high" : "medium",
            title: `${change.changeType === "added" ? "New" : "Changed"} validation rule ${comp.name} applies to ${writers.length} automation(s) that write ${object}`,
            detail: `${writers.map((w) => describe(w.automation)).join(", ")} must now satisfy: ${vr.formula.replace(/\s+/g, " ").trim()}. If they don't set the fields it checks, their saves will fail.`,
            object,
            files: uniq([vr.file, ...writers.map((w) => w.automation.file!).filter(Boolean)]),
          });
          tests.push({
            kind: "validation-collision",
            object,
            description: `Run ${writers.map((w) => describe(w.automation)).join(", ")} against ${object} records that violate ${vr.name}; assert each either sets the required values or surfaces the error to the user (not swallowed).`,
            covers: [vr.fullName, ...writers.map((w) => w.automation.name)],
          });
        }
        break;
      }

      case "Flow": {
        const flow = model.flows.get(key(comp.name));
        changedAutomation.add(`flow:${key(comp.name)}`);
        if (deleted || !flow) {
          const parents = callersOfFlow(model, comp.name);
          if (parents.length) {
            addFinding({
              rule: "deleted-still-referenced",
              severity: "high",
              title: `Deleted flow ${comp.name} is still called as a subflow`,
              detail: `Called by ${parents.map((p) => p.name).join(", ")}.`,
              files: [comp.file, ...parents.map((p) => p.file)],
            });
          }
          break;
        }
        if (!flow.active) {
          addFinding({
            rule: "flow-inactive",
            severity: "info",
            title: `Flow ${flow.name} is not active (${flow.status})`,
            detail: "It will not run until activated; analysis treats it as inactive.",
            files: [flow.file],
          });
        }
        const via: AutomationRef = { kind: "Flow", name: flow.name, file: flow.file };
        if (flow.trigger) {
          for (const event of flow.trigger.events) roots.push({ object: flow.trigger.object, event, via });
        } else {
          for (const w of flowWrites(model, flow)) roots.push({ object: w.object, event: opToEvent(w.op), via });
          for (const parent of callersOfFlow(model, flow.name)) {
            if (parent.trigger)
              for (const event of parent.trigger.events)
                roots.push({
                  object: parent.trigger.object,
                  event,
                  via: { kind: "Flow", name: parent.name, file: parent.file },
                });
          }
        }
        break;
      }

      case "ApexTrigger": {
        changedAutomation.add(`trigger:${key(comp.name)}`);
        const trig = model.triggers.get(key(comp.name));
        if (deleted || !trig) break;
        const via: AutomationRef = { kind: "ApexTrigger", name: trig.name, file: trig.file };
        for (const event of uniq(trig.events.map((e) => e.event))) roots.push({ object: trig.object, event, via });
        for (const cls of knownClassRefs(model, trig.classRefs)) changedAutomation.add(`class:${key(cls.name)}`);
        break;
      }

      case "ApexClass": {
        changedAutomation.add(`class:${key(comp.name)}`);
        const cls = model.classes.get(key(comp.name));
        if (deleted || !cls) {
          const callers = callersOfClass(model, comp.name);
          const vfUsers = pagesUsingClass(model, comp.name);
          if (vfUsers.length) {
            addFinding({
              rule: "apex-used-by-page",
              severity: "high",
              title: `Deleted class ${comp.name} is still the controller of ${vfUsers.length} Visualforce page(s)`,
              detail: `${vfUsers.map((p) => p.name).join(", ")} name it as controller or extension and will not save.`,
              files: uniq([comp.file, ...vfUsers.map((p) => p.file)]),
            });
          }
          if (callers.length) {
            addFinding({
              rule: "deleted-still-referenced",
              severity: "high",
              title: `Deleted class ${comp.name} is still referenced`,
              detail: `Referenced by ${callers.map(describe).join(", ")}.`,
              files: uniq([comp.file, ...callers.map((c) => c.file!).filter(Boolean)]),
            });
          }
          break;
        }
        if (cls.isTest) break;
        const vfPages = pagesUsingClass(model, cls.name);
        if (vfPages.length) {
          addFinding({
            rule: "apex-used-by-page",
            severity: "info",
            title: `${cls.name} is the controller or extension of ${vfPages.length} Visualforce page(s)`,
            detail: `${vfPages.map((p) => p.name).join(", ")} render through it, so changed properties or actions reach users directly.`,
            files: uniq([comp.file, ...vfPages.map((p) => p.file)]),
          });
        }
        const lightningCallers = lightningCallingClass(model, cls.name);
        if (lightningCallers.length) {
          addFinding({
            rule: "apex-called-from-lightning",
            severity: "low",
            title: `${cls.name} is called from ${lightningCallers.length} Lightning component(s)`,
            detail: `${lightningCallers.map((l) => l.name).join(", ")} call it from the browser, so a changed signature, result shape or error behaviour reaches users directly.`,
            files: uniq([comp.file, ...lightningCallers.map((l) => l.file)]),
          });
        }
        const omniCallers = omniCallersOf(model, "ApexClass", cls.name);
        if (omniCallers.length) {
          addFinding({
            rule: "apex-called-from-omnistudio",
            severity: "low",
            title: `${cls.name} is called by ${omniCallers.length} OmniStudio component(s)`,
            detail: `${omniCallers.map((c) => `${omniLabel(c.kind)} ${c.name}`).join(", ")} ${omniCallers.length === 1 ? "calls" : "call"} it as a Remote Action or data source, so a changed method name, input or output keys reach their users directly.`,
            files: uniq([comp.file, ...omniCallers.map((c) => c.file)]),
          });
          findings.push(...notCallableFindings(omniCallers, cls.name));
        }
        const via: AutomationRef = { kind: "ApexClass", name: cls.name, file: cls.file };
        const entryPoints = transitiveEntryPoints(model, cls.name);
        for (const ep of entryPoints) {
          if (ep.kind === "ApexTrigger") {
            const trig = model.triggers.get(key(ep.name))!;
            for (const event of uniq(trig.events.map((e) => e.event)))
              roots.push({ object: trig.object, event, via: ep });
          } else if (ep.kind === "Flow") {
            const flow = model.flows.get(key(ep.name))!;
            if (flow.trigger)
              for (const event of flow.trigger.events) roots.push({ object: flow.trigger.object, event, via: ep });
          }
        }
        if (cls.invocable || !entryPoints.some((e) => e.kind === "ApexTrigger" || e.kind === "Flow")) {
          // Entry point in its own right (invocable action, agent action, LWC/Aura controller...).
          for (const w of classWrites(model, cls)) roots.push({ object: w.object, event: opToEvent(w.op), via });
        }
        break;
      }

      case "PermissionSet":
      case "Profile": {
        if (deleted) break;
        const current = model.permissionContainers.get(key(`${comp.type}:${comp.name}`));
        if (!current) break;
        const baseXml = opts.readBase?.(comp.file);
        let previous: PermissionContainerDef | undefined;
        if (baseXml) {
          try {
            previous = parsePermissionContainer(baseXml, comp.name, comp.type, comp.file);
          } catch {
            previous = undefined;
          }
        }
        const { findings: permFindings, tests: permTests } = permissionDelta(current, previous);
        // A permission set can also reach users through permission set groups.
        const groups = comp.type === "PermissionSet" ? groupsIncluding(model, comp.name) : [];
        for (const f of permFindings)
          if (groups.length && (f.rule === "permission-escalation" || f.rule === "permission-system"))
            f.detail += ` It also reaches everyone assigned permission set group(s) ${groups.join(", ")}.`;
        findings.push(...permFindings);
        findings.push(...accessRemovedFindings(model, current, previous));
        findings.push(...guestFindings(current, previous));
        tests.push(...permTests);
        break;
      }

      case "CustomObject":
      case "ObjectChild":
        if (comp.object && !deleted) roots.push({ object: comp.object, event: "update", via: changeRef(change) });
        if (comp.type === "CustomObject" && comp.object && isPlatformEvent(comp.object))
          findings.push(...platformEventFindings(model, comp, comp.object, deleted));
        if (comp.type === "CustomObject" && comp.object && !deleted) {
          const base = opts.readBase?.(comp.file);
          if (base)
            findings.push(
              ...sharingModelFindings(
                comp.object,
                comp.file,
                parseSharingModel(readCurrent(comp.file)),
                parseSharingModel(base),
              ),
            );
        }
        if (comp.type === "ObjectChild" && !deleted) findings.push(...missingFieldFindings(model, comp));
        if (comp.type === "ObjectChild" && comp.file.endsWith(".recordType-meta.xml")) {
          findings.push(...recordTypeFindings(model, comp, deleted, opts.readBase?.(comp.file)));
        }
        break;

      case "AgentMetadata": {
        if (comp.agentKind === "test") break;
        const refs = deleted ? [] : actionsForAgentChange(model, comp);
        for (const { action } of refs) {
          const via = targetRef(actionTarget(model, action));
          if (!via) continue;
          for (const w of actionWrites(model, action)) roots.push({ object: w.object, event: opToEvent(w.op), via });
        }
        if (!refs.length && !(deleted && stillReferenced(model, comp))) {
          addFinding({
            rule: "agent-metadata-changed",
            severity: "info",
            title: `Agentforce metadata ${deleted ? "deleted" : "changed"}: ${comp.name}`,
            detail: deleted
              ? "Agents that used it lose it; check them in Agent Builder."
              : "It isn't used by any agent action in the project, so preflight can't follow what it does.",
            files: [comp.file],
          });
        }
        break;
      }

      case "WorkflowRule": {
        const base = opts.readBase?.(comp.file);
        if (!deleted)
          findings.push(
            ...outboundMessageFindings(
              outboundMessagesOf(model).filter((m) => m.file === comp.file),
              base !== undefined ? parseOutboundMessages(base, comp.name, comp.file) : undefined,
            ),
          );
        addFinding({
          rule: "legacy-workflow",
          severity: "info",
          title: `Legacy workflow changed: ${comp.name}`,
          detail:
            "Workflow rules are not analyzed yet, apart from their outbound messages; consider migrating them to flows.",
          files: [comp.file],
        });
        break;
      }

      case "Metadata": {
        if (isLightningBundle(comp)) {
          analyzeLightning(change);
          break;
        }
        if (omniKindOf(comp)) {
          analyzeOmni(change);
          break;
        }
        if (comp.metadataType === "Layout" || comp.metadataType === "FlexiPage") {
          analyzePage(change);
          break;
        }
        // Reports, report types, quick actions, email templates: fields they name that don't exist.
        if (!deleted && parseFieldUser(comp, readCurrent)) findings.push(...missingFieldFindings(model, comp));
        if (comp.metadataType && INTEGRATION_TYPES.has(comp.metadataType)) {
          const base = opts.readBase?.(comp.file);
          findings.push(
            ...integrationFindings(
              model,
              comp,
              deleted ? undefined : parseIntegration(comp, readCurrent(comp.file)),
              // A destructive manifest deletes from the org while the source file can stay.
              parseIntegration(comp, base ?? (deleted ? readCurrent(comp.file) : undefined)),
            ),
          );
          break;
        }
        if (comp.metadataType && SAVE_RULE_TYPES.has(comp.metadataType)) {
          const base = opts.readBase?.(comp.file);
          const current = deleted ? [] : saveRulesOf(model).filter((r) => r.file === comp.file);
          findings.push(
            ...saveRuleChangeFindings(
              model,
              comp,
              current,
              base !== undefined ? parseSaveRuleFile(comp, base) : change.changeType === "added" ? [] : undefined,
            ),
          );
          break;
        }
        if (comp.metadataType === "SharingRules") {
          if (!deleted)
            findings.push(
              ...sharingRuleFindings(
                comp.name,
                comp.file,
                parseSharingRules(readCurrent(comp.file)),
                opts.readBase ? parseSharingRules(opts.readBase(comp.file)) : undefined,
              ),
            );
          break;
        }
        if (comp.metadataType === "PermissionSetGroup") {
          if (!deleted) {
            const base = opts.readBase?.(comp.file);
            findings.push(
              ...permissionSetGroupFindings(
                model,
                comp.name,
                comp.file,
                parsePermissionSetGroup(readCurrent(comp.file)),
                base === undefined && change.changeType !== "added" ? undefined : parsePermissionSetGroup(base),
                SENSITIVE_USER_PERMS,
              ),
            );
          }
          break;
        }
        if (comp.metadataType === "MutingPermissionSet") {
          const xml = deleted ? undefined : readCurrent(comp.file);
          if (xml) {
            const base = opts.readBase?.(comp.file);
            findings.push(
              ...mutingFindings(
                model,
                parseMuting(xml, comp.name, comp.file),
                base ? parseMuting(base, comp.name, comp.file) : undefined,
              ),
            );
          }
          break;
        }
        if (comp.metadataType === "CustomLabels") {
          findings.push(...labelFindings(model, comp, deleted, opts.readBase?.(comp.file)));
          break;
        }
        if (comp.metadataType === "CustomMetadata") {
          findings.push(...customMetadataFindings(model, comp, deleted));
          break;
        }
        if (comp.metadataType === "ApexPage" || comp.metadataType === "ApexComponent") {
          if (!deleted) findings.push(...visualforceFindings(model, comp));
          break;
        }
        // Recognized by name only: say so, and point at the files that mention it.
        if (named.length) break; // the reference check already lists them
        const type = comp.metadataType ?? "Metadata";
        const mentions = coverage?.mentions.find((m) => m.type === type && m.component === comp.name);
        const where = mentions
          ? ` Mentioned in ${mentions.files.slice(0, 5).join(", ")}${mentions.files.length + mentions.more > 5 ? ` and ${mentions.files.length + mentions.more - 5} more` : ""}.`
          : "";
        addFinding({
          rule: "metadata-not-analyzed",
          severity: "info",
          title: `${type} ${deleted ? "deleted" : "changed"}: ${comp.name}`,
          detail: `sf-preflight recognizes this metadata type but does not analyze it in depth yet, so what it affects is not in this report.${where}`,
          files: [comp.file],
        });
        break;
      }

      default:
        break;
    }
  }

  // ------------------------------------------------------------------------------------
  // 2. Cascade through the save procedure of every impacted object
  // ------------------------------------------------------------------------------------
  const procCache = new Map<string, SaveProcedure>();
  const proc = (object: string, event: SaveEvent) => {
    const k = `${key(object)}|${event}`;
    let p = procCache.get(k);
    if (!p) {
      p = saveProcedure(model, model.objects.get(key(object))?.name ?? object, event);
      procCache.set(k, p);
    }
    return p;
  };

  let nodeCount = 0;
  const cycleMap = new Map<string, { labels: string[]; files: string[] }>();
  const label = (n: { object: string; event: SaveEvent; via?: AutomationRef }) =>
    `${n.object} (${n.event})${n.via && n.via.kind !== "Change" ? ` ← ${describe(n.via)}` : ""}`;

  const expand = (node: CascadeNode, path: CascadeNode[]) => {
    if (node.depth >= maxDepth) {
      if (proc(node.object, node.event).steps.some((s) => s.writes.length)) node.truncated = true;
      return;
    }
    const seen = new Set<string>();
    for (const step of proc(node.object, node.event).steps) {
      for (const w of step.writes) {
        const event = opToEvent(w.op);
        const childKey = `${key(w.object)}|${event}|${step.automation.kind}|${step.automation.name}`;
        if (seen.has(childKey)) continue;
        seen.add(childKey);
        if (++nodeCount > MAX_NODES) {
          node.truncated = true;
          return;
        }
        const child: CascadeNode = {
          object: w.object,
          event,
          via: step.automation,
          depth: node.depth + 1,
          children: [],
        };
        node.children.push(child);
        // Publishing a platform event ends the transaction's cascade: subscribers run later.
        if (isPlatformEvent(w.object)) {
          child.async = true;
          continue;
        }
        const loopStart = path.findIndex((p) => key(p.object) === key(w.object));
        if (loopStart >= 0) {
          child.cycle = true;
          const loop = [...path.slice(loopStart), child];
          const signature = loop
            .slice(1)
            .map((n) => `${key(n.object)}|${n.via?.name ?? ""}`)
            .sort()
            .join(">");
          if (!cycleMap.has(signature)) {
            cycleMap.set(signature, {
              labels: loop.map(label),
              files: uniq(loop.map((n) => n.via?.file).filter((f): f is string => !!f)),
            });
          }
          continue;
        }
        expand(child, [...path, child]);
      }
    }
  };

  const uniqueRoots = uniqBy(roots, (r) => `${key(r.object)}|${r.event}|${r.via.kind}|${key(r.via.name)}`);
  const cascade: CascadeNode[] = uniqueRoots.map((r) => {
    const node: CascadeNode = {
      object: model.objects.get(key(r.object))?.name ?? r.object,
      event: r.event,
      via: r.via,
      depth: 0,
      children: [],
    };
    expand(node, [node]);
    return node;
  });

  // Collect visited (object, event) pairs and edges.
  const visited = new Map<string, { object: string; event: SaveEvent }>();
  const edges: CascadeNode[] = [];
  const walk = (n: CascadeNode) => {
    visited.set(`${key(n.object)}|${n.event}`, { object: n.object, event: n.event });
    edges.push(n);
    n.children.forEach(walk);
  };
  cascade.forEach(walk);

  const saveProcedures = [...visited.values()].map((v) => proc(v.object, v.event)).filter((p) => p.steps.length > 0);
  const impactedObjects = uniq([...visited.values()].map((v) => v.object)).sort();

  // ------------------------------------------------------------------------------------
  // 3. Findings from the cascade
  // ------------------------------------------------------------------------------------
  const cycles = [...cycleMap.values()].map((c) => c.labels);
  for (const { labels: loop, files } of cycleMap.values()) {
    addFinding({
      rule: "recursion-cycle",
      severity: "high",
      title: `Automation cycle: ${loop.map((l) => l.split(" ")[0]).join(" → ")}`,
      detail: `${loop.join(" → ")}. At human pace this may settle; at bulk or agent volume it can cause recursion, duplicate updates or governor-limit failures mid-batch.`,
      files,
    });
    tests.push({
      kind: "recursion",
      object: loop[0]?.split(" ")[0],
      description: `In one transaction, update 200 records along ${loop.map((l) => l.split(" ")[0]).join(" → ")}; assert no recursion/limit errors, no duplicate updates, and consistent final values.`,
      covers: loop,
    });
  }

  // Validation rules hit by automated writes.
  const automatedWrites = new Map<
    string,
    { object: string; writers: Map<string, AutomationRef>; events: Set<SaveEvent> }
  >();
  for (const e of edges) {
    if (!e.via || !AUTOMATION_KINDS.has(e.via.kind) || (e.event !== "insert" && e.event !== "update")) continue;
    const k = key(e.object);
    if (!automatedWrites.has(k)) automatedWrites.set(k, { object: e.object, writers: new Map(), events: new Set() });
    automatedWrites.get(k)!.writers.set(`${e.via.kind}:${e.via.name}`, e.via);
    automatedWrites.get(k)!.events.add(e.event);
  }
  // Duplicate rules that block automated writes.
  for (const { object, writers, events } of automatedWrites.values()) {
    const blocking = saveRulesOf(model).filter(
      (d) =>
        d.kind === "DuplicateRule" &&
        d.active &&
        key(d.object) === key(object) &&
        ((events.has("insert") && d.blocks?.insert) || (events.has("update") && d.blocks?.update)),
    );
    if (!blocking.length) continue;
    const ws = [...writers.values()];
    addFinding({
      rule: "automated-write-vs-duplicate-rule",
      severity: "medium",
      title: `Automated writes to ${object} can be blocked by ${blocking.length} duplicate rule(s)`,
      detail: `${ws.map(describe).join(", ")} save ${object} records that ${blocking.map((d) => d.name).join(", ")} check${blocking.some((d) => d.fields.length) ? ` (matching on ${uniq(blocking.flatMap((d) => d.fields)).join(", ")})` : ""}. A save that matches an existing record fails. Apex can set Database.DMLOptions.DuplicateRuleHeader.allowSave; otherwise make sure the error reaches the user.`,
      object,
      files: uniq([...blocking.map((d) => d.file), ...ws.map((w) => w.file!).filter(Boolean)]),
    });
  }
  for (const { object, writers } of automatedWrites.values()) {
    const vrs = model.validationRules.filter((v) => v.active && key(v.object) === key(object));
    if (!vrs.length) continue;
    const ws = [...writers.values()];
    addFinding({
      rule: "automated-write-vs-validation-rule",
      severity: "medium",
      title: `Automated writes to ${object} must pass ${vrs.length} validation rule(s)`,
      detail: `${ws.map(describe).join(", ")} write ${object} records that are checked by ${vrs.map((v) => v.name).join(", ")}. A correct action can still fail here; verify errors are surfaced, not swallowed.`,
      object,
      files: uniq([...vrs.map((v) => v.file), ...ws.map((w) => w.file!).filter(Boolean)]),
    });
    tests.push({
      kind: "validation-collision",
      object,
      description: `Exercise ${ws.map(describe).join(", ")} with ${object} data that violates ${vrs.map((v) => v.name).join(", ")}; assert the failure is reported to the caller and no partial updates remain.`,
      covers: [...vrs.map((v) => v.fullName), ...ws.map((w) => w.name)],
    });
  }

  // Automation density and self re-entry on visited save procedures.
  for (const p of saveProcedures) {
    const automations = p.steps.filter((s) => s.automation.kind === "Flow" || s.automation.kind === "ApexTrigger");
    const uniqueAutomations = uniq(automations.map((s) => s.automation.name));
    if (uniqueAutomations.length >= 3) {
      addFinding({
        rule: "automation-density",
        severity: "medium",
        title: `${uniqueAutomations.length} automations run on ${p.object} ${p.event}`,
        detail: `${uniqueAutomations.join(", ")}. Overlapping automation on one object is where ordering bugs and race conditions hide.`,
        object: p.object,
        files: uniq(automations.map((s) => s.automation.file!).filter(Boolean)),
      });
    }
    const triggers = uniq(p.steps.filter((s) => s.automation.kind === "ApexTrigger").map((s) => s.automation.name));
    if (triggers.length > 1) {
      addFinding({
        rule: "multiple-triggers",
        severity: "medium",
        title: `${triggers.length} Apex triggers on ${p.object}`,
        detail: `${triggers.join(", ")}. Salesforce does not guarantee the order between triggers on the same object; consolidate into one trigger per object.`,
        object: p.object,
        files: uniq(p.steps.filter((s) => s.automation.kind === "ApexTrigger").map((s) => s.automation.file!)),
      });
    }
    for (const s of p.steps) {
      if (s.phase === "after-flow" && s.writes.some((w) => w.selfUpdate)) {
        addFinding({
          rule: "after-save-self-update",
          severity: "medium",
          title: `After-save flow ${s.automation.name} updates its own triggering ${p.object}`,
          detail:
            "This re-runs the whole save procedure for the record. Use a before-save flow for same-record field updates.",
          object: p.object,
          files: [s.automation.file!],
        });
        tests.push({
          kind: "idempotency",
          object: p.object,
          description: `Save the same ${p.object} twice in a row; assert ${s.automation.name} does not double-apply its changes.`,
          covers: [s.automation.name],
        });
      }
    }
  }

  // DML/SOQL inside loops in changed or impacted Apex.
  const apexInScope = new Map<string, { name: string; file: string; issues: LoopIssue[]; changed: boolean }>();
  const addApex = (kind: "class" | "trigger", name: string) => {
    const def = kind === "class" ? model.classes.get(key(name)) : model.triggers.get(key(name));
    if (!def?.loopIssues.length) return;
    const k = `${kind}:${key(name)}`;
    const changed = changedAutomation.has(k) || changedFiles.has(def.file);
    const prev = apexInScope.get(k);
    apexInScope.set(k, { name: def.name, file: def.file, issues: def.loopIssues, changed: changed || !!prev?.changed });
  };
  for (const k of changedAutomation) {
    const [kind, name] = k.split(":") as ["class" | "trigger" | "flow", string];
    if (kind !== "flow") addApex(kind, name);
  }
  for (const p of saveProcedures) {
    for (const s of p.steps) {
      if (s.automation.kind !== "ApexTrigger") continue;
      addApex("trigger", s.automation.name);
      const trig = model.triggers.get(key(s.automation.name));
      if (trig) for (const cls of knownClassRefs(model, trig.classRefs)) addApex("class", cls.name);
    }
  }
  for (const a of apexInScope.values()) {
    addFinding({
      rule: "dml-or-soql-in-loop",
      severity: a.changed ? "high" : "medium",
      title: `${a.issues.length} DML/SOQL statement(s) inside loops in ${a.name}${a.changed ? " (changed)" : " (in blast radius)"}`,
      detail: a.issues
        .map((i) => `line ${i.line} ${i.kind}${i.via ? ` (inside ${i.via}())` : ""}: ${i.snippet}`)
        .join("; "),
      files: [a.file],
      line: a.issues[0]?.line,
    });
  }

  // Agent actions the change reaches.
  const agentAnalysis = analyzeAgents({ model, changes, maxDepth, proc });
  findings.push(...agentAnalysis.findings);
  tests.push(...agentAnalysis.tests);

  // Bulk tests for every root.
  for (const r of uniqBy(uniqueRoots, (r) => `${key(r.object)}|${r.event}`)) {
    const p = proc(r.object, r.event);
    tests.push({
      kind: "bulk",
      object: r.object,
      description: `Bulk ${r.event} 200 ${r.object} records (and at your expected production volume); assert no governor-limit errors and the expected final state.`,
      covers: uniq(p.steps.map((s) => s.automation.name)),
    });
  }

  // ------------------------------------------------------------------------------------
  // 4. Summary
  // ------------------------------------------------------------------------------------
  const { findings: finalFindings, findingsBySeverity, risk } = summarizeFindings(findings);
  const automationsInvolved = uniq(
    saveProcedures.flatMap((p) => p.steps.map((s) => `${s.automation.kind}:${s.automation.name}`)),
  ).length;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectDir: model.projectDir,
    base: opts.base,
    head: opts.head,
    changes,
    ignoredFiles: opts.ignoredFiles ?? [],
    references,
    impactedObjects,
    saveProcedures,
    cascade,
    cycles,
    findings: finalFindings,
    suggestedTests: uniqBy(tests, (t) => `${t.kind}|${t.description}`),
    agents: agentAnalysis.impacts,
    coverage,
    summary: {
      risk,
      changedComponents: changes.length,
      impactedObjects: impactedObjects.length,
      automationsInvolved,
      cycles: cycles.length,
      findingsBySeverity,
    },
    warnings: model.warnings,
    provenance: opts.provenance,
  };
}

// ----------------------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------------------

/** De-duplicate and sort findings by severity, count them, and derive the overall risk. */
export function summarizeFindings(findings: Finding[]): {
  findings: Finding[];
  findingsBySeverity: Record<Severity, number>;
  risk: "high" | "medium" | "low";
} {
  const sorted = uniqBy(findings, (f) => `${f.rule}|${f.title}`).sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const findingsBySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of sorted) findingsBySeverity[f.severity]++;
  const risk = findingsBySeverity.high ? "high" : findingsBySeverity.medium ? "medium" : "low";
  return { findings: sorted, findingsBySeverity, risk };
}

/** Everything in the project that references `Object.Field`. */
export function fieldReferences(model: OrgModel, object: string, field: string): Reference[] {
  const target = `${object}.${field}`;
  const fk = key(field);
  const tk = key(target);
  const refs: Reference[] = [];

  for (const vr of model.validationRules) {
    if (key(vr.object) === key(object) && vr.fieldRefs.some((r) => key(r) === fk)) {
      refs.push({ from: { kind: "ValidationRule", name: vr.name, file: vr.file }, to: target });
    }
  }
  for (const flow of model.flows.values()) {
    if (flow.fieldRefs.some((r) => key(r) === tk))
      refs.push({ from: { kind: "Flow", name: flow.name, file: flow.file }, to: target });
  }
  const re = new RegExp(`\\b${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const apexUses = (def: ApexAnalysis): boolean => {
    if (def.parser === "ast" && def.fieldRefs) {
      return def.fieldRefs.some((r) => apexRefMatches(model, r, object, field));
    }
    // Heuristic fallback: text match, custom fields only (standard names are too common).
    return fk.endsWith("__c") && re.test(def.stripped);
  };
  for (const trig of model.triggers.values()) {
    if (apexUses(trig)) refs.push({ from: { kind: "ApexTrigger", name: trig.name, file: trig.file }, to: target });
  }
  for (const cls of model.classes.values()) {
    if (apexUses(cls)) refs.push({ from: { kind: "ApexClass", name: cls.name, file: cls.file }, to: target });
  }
  for (const obj of model.objects.values()) {
    for (const f of obj.fields.values()) {
      if (key(obj.name) === key(object) && key(f.name) !== fk && f.formulaRefs.some((r) => key(r) === fk)) {
        refs.push({ from: { kind: "FormulaField", name: f.fullName, file: f.file }, to: target });
      }
      if (f.summary && key(f.summary.childObject) === key(object)) {
        const summarized = f.summary.summarizedField && key(f.summary.summarizedField) === tk;
        const filtered = f.summary.filterFields.some((ff) => key(ff) === fk || key(ff) === tk);
        if (summarized || filtered)
          refs.push({ from: { kind: "RollUpSummary", name: f.fullName, file: f.file }, to: target });
      }
    }
  }
  for (const r of rulesReadingField(model, object, field)) refs.push({ from: saveRuleRef(r), to: target });
  for (const u of fieldUsers(model, object, field))
    refs.push({ from: { kind: u.kind, name: u.name, file: u.file }, to: target });
  for (const m of outboundMessagesOf(model)) {
    if (key(m.object) === key(object) && m.fields.some((f) => key(f) === fk))
      refs.push({ from: { kind: "OutboundMessage", name: m.name, file: m.file }, to: target });
  }
  for (const pc of model.permissionContainers.values()) {
    if (pc.fields.some((g) => key(g.field) === tk))
      refs.push({ from: { kind: pc.kind, name: pc.name, file: pc.file }, to: target });
  }
  for (const lc of model.lightning.values()) {
    if (lc.fields.some((f) => key(f) === tk))
      refs.push({ from: { kind: "LightningComponent", name: lc.name, file: lc.file }, to: target });
  }
  for (const l of model.layouts.values()) {
    if (key(l.object) === key(object) && l.fields.some((f) => key(f) === fk))
      refs.push({ from: { kind: "Layout", name: l.name, file: l.file }, to: target });
  }
  for (const p of model.flexipages.values()) {
    if (p.fields.some((f) => key(f) === tk))
      refs.push({ from: { kind: "FlexiPage", name: p.name, file: p.file }, to: target });
  }
  refs.push(...omniFieldReferences(model, object, field));
  return refs;
}

const RELATIONSHIP_OBJECTS: Record<string, string> = {
  owner: "User",
  createdby: "User",
  lastmodifiedby: "User",
  parent: "",
};

/**
 * Does an AST field reference (`Object.Field`, `*.Field` or a SOQL path such as
 * `Contact.Account.Industry`) point at `object.field`?
 */
function apexRefMatches(model: OrgModel, ref: string, object: string, field: string): boolean {
  const parts = ref.split(".");
  const last = parts[parts.length - 1]!;
  if (key(last) !== key(field)) return false;
  if (parts[0] === "*") return key(field).endsWith("__c");
  if (parts.length === 2) return key(parts[0]!) === key(object);
  // Walk relationship segments: Contact.Account.Industry → Account.Industry
  let current = parts[0]!;
  for (const rel of parts.slice(1, -1)) {
    const relKey = key(rel);
    if (relKey.endsWith("__r")) {
      const lookup = model.objects.get(key(current))?.fields.get(relKey.replace(/__r$/, "__c"));
      current = lookup?.referenceTo[0] ?? "";
    } else {
      current = RELATIONSHIP_OBJECTS[relKey] ?? rel;
    }
    if (!current) return false;
  }
  return key(current) === key(object);
}

/** Triggers and record-triggered flows that (transitively) call a class. */
function transitiveEntryPoints(model: OrgModel, className: string): AutomationRef[] {
  const result: AutomationRef[] = [];
  const seen = new Set<string>();
  const queue = [className];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(key(name))) continue;
    seen.add(key(name));
    for (const caller of callersOfClass(model, name)) {
      if (caller.kind === "ApexClass") queue.push(caller.name);
      else result.push(caller);
    }
  }
  return uniqBy(result, (r) => `${r.kind}|${key(r.name)}`);
}

function permissionDelta(
  current: PermissionContainerDef,
  previous: PermissionContainerDef | undefined,
): { findings: Finding[]; tests: SuggestedTest[] } {
  const findings: Finding[] = [];
  const tests: SuggestedTest[] = [];
  const scope = previous ? "newly grants" : "grants";
  const prevObj = new Map((previous?.objects ?? []).map((o) => [key(o.object), o]));
  const label = `${current.kind === "Profile" ? "Profile" : "Permission set"} ${current.name}`;

  for (const o of current.objects) {
    const p = prevObj.get(key(o.object));
    const escalations: string[] = [];
    if (o.modifyAll && !p?.modifyAll) escalations.push("Modify All");
    if (o.viewAll && !p?.viewAll) escalations.push("View All");
    if (escalations.length) {
      findings.push({
        rule: "permission-escalation",
        severity: "high",
        title: `${label} ${scope} ${escalations.join(" + ")} on ${o.object}`,
        detail: `Anyone with this ${current.kind === "Profile" ? "profile" : "permission set"} — including an agent's runtime user — bypasses sharing on ${o.object}. Confirm this is intended and scoped.`,
        object: o.object,
        files: [current.file],
      });
      tests.push({
        kind: "permission-negative",
        object: o.object,
        description: `As a user holding only ${current.name}, attempt to read/edit ${o.object} records outside the intended scope; assert access is denied (System.runAs).`,
        covers: [current.name],
      });
    }
    if (o.delete && !p?.delete) {
      findings.push({
        rule: "permission-delete",
        severity: "medium",
        title: `${label} ${scope} delete on ${o.object}`,
        detail:
          "Delete access is rarely needed by integration or agent users; deletes cascade through master-detail children.",
        object: o.object,
        files: [current.file],
      });
    }
  }
  const prevUser = new Set((previous?.userPermissions ?? []).map(key));
  for (const up of current.userPermissions) {
    if (SENSITIVE_USER_PERMS.has(key(up)) && !prevUser.has(key(up))) {
      findings.push({
        rule: "permission-system",
        severity: "high",
        title: `${label} ${scope} system permission ${up}`,
        detail: "System-level permission with org-wide blast radius.",
        files: [current.file],
      });
    }
  }
  if (previous) {
    const prevFields = new Map(previous.fields.map((f) => [key(f.field), f]));
    const newEdits = current.fields.filter((f) => f.editable && !prevFields.get(key(f.field))?.editable);
    if (newEdits.length) {
      findings.push({
        rule: "permission-field-edit",
        severity: "low",
        title: `${label} newly grants edit on ${newEdits.length} field(s)`,
        detail: newEdits.map((f) => f.field).join(", "),
        files: [current.file],
      });
    }
  }
  return { findings, tests };
}
