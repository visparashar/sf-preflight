// SPDX-License-Identifier: Apache-2.0
import { fieldReferences } from "./analyze.js";
import {
  callersOfClass,
  callersOfFlow,
  flexipagesPlacing,
  lightningCallingClass,
  lightningEmbedding,
  writersOf,
} from "./graph.js";
import { omniCallersOf, omniKindOf, omniLabel, omniOf, refLabel } from "./omnistudio.js";
import { saveProcedure } from "./orderOfExecution.js";
import { classifyPath } from "./project.js";
import type { OrgModel } from "./types.js";
import { pagesUsingClass } from "./usage.js";
import { key } from "./util.js";

/**
 * What an editor shows above a metadata file before anything is changed: who uses this component
 * and what runs around it. Cheap, from the loaded project; no analysis of a change.
 */
export interface Insight {
  /** One line, e.g. "Used by 2 flows, 1 Apex class · on 3 layouts". Empty when there is nothing to say. */
  summary: string;
  /** Longer lines for a hover or a detail view. */
  details: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const KIND_LABEL: Record<string, [string, string]> = {
  Flow: ["flow", "flows"],
  ApexTrigger: ["trigger", "triggers"],
  ApexClass: ["Apex class", "Apex classes"],
  ValidationRule: ["validation rule", "validation rules"],
  FormulaField: ["formula", "formulas"],
  RollUpSummary: ["roll-up", "roll-ups"],
  LightningComponent: ["Lightning component", "Lightning components"],
  Layout: ["layout", "layouts"],
  FlexiPage: ["Lightning page", "Lightning pages"],
  PermissionSet: ["permission set", "permission sets"],
  Profile: ["profile", "profiles"],
  Report: ["report", "reports"],
  ListView: ["list view", "list views"],
  EmailTemplate: ["email template", "email templates"],
  OmniScript: ["OmniScript", "OmniScripts"],
  IntegrationProcedure: ["Integration Procedure", "Integration Procedures"],
  DataMapper: ["Data Mapper", "Data Mappers"],
  FlexCard: ["FlexCard", "FlexCards"],
  ApexClassTarget: ["Apex class", "Apex classes"],
  LightningComponentTarget: ["Lightning component", "Lightning components"],
  NamedCredential: ["named credential", "named credentials"],
};

function countBy(kinds: string[]): string {
  const counts = new Map<string, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => {
      const [one, many] = KIND_LABEL[k] ?? [k, `${k}s`];
      return plural(n, one, many);
    })
    .join(", ");
}

/** What runs when records of an object are saved, in one phrase. */
function saveSummary(model: OrgModel, object: string): string | undefined {
  const update = saveProcedure(model, model.objects.get(key(object))?.name ?? object, "update");
  if (!update.steps.length) return undefined;
  return `saving ${object} runs ${plural(update.steps.length, "automation")}`;
}

/** The insight for the component a project file belongs to. `rel` is project-relative. */
export function insightFor(model: OrgModel, rel: string): Insight {
  const comp = classifyPath(rel);
  const details: string[] = [];
  const parts: string[] = [];
  switch (comp.type) {
    case "CustomField": {
      const [object, field] = [comp.object!, comp.name.split(".")[1]!];
      const refs = fieldReferences(model, object, field);
      if (refs.length) {
        parts.push(`Used by ${countBy(refs.map((r) => r.from.kind))}`);
        details.push(...refs.slice(0, 20).map((r) => refLabel(r.from)));
        if (refs.length > 20) details.push(`… and ${refs.length - 20} more`);
      }
      const save = saveSummary(model, object);
      if (save) parts.push(save);
      break;
    }
    case "CustomObject":
    case "ValidationRule":
    case "ObjectChild":
    case "ApexTrigger": {
      const object = comp.type === "ApexTrigger" ? model.triggers.get(key(comp.name))?.object : comp.object;
      if (!object) break;
      const proc = saveProcedure(model, model.objects.get(key(object))?.name ?? object, "update");
      if (proc.steps.length) {
        parts.push(`Saving ${object} runs ${plural(proc.steps.length, "automation")}`);
        details.push(...proc.steps.map((s) => `${s.order}. ${s.phaseLabel}: ${s.automation.name}`));
      }
      const writers = writersOf(model, object);
      if (writers.length)
        parts.push(`${writers.length === 1 ? "1 automation writes" : `${writers.length} automations write`} ${object}`);
      break;
    }
    case "ApexClass": {
      // Tests call everything; they aren't users.
      const callers = callersOfClass(model, comp.name).filter(
        (c) => !(c.kind === "ApexClass" && model.classes.get(key(c.name))?.isTest),
      );
      const lwc = lightningCallingClass(model, comp.name);
      const pages = pagesUsingClass(model, comp.name);
      const users = [
        ...callers.map((c) => c.kind as string),
        ...lwc.map(() => "LightningComponent"),
        ...pages.map(() => "Visualforce page"),
      ];
      if (users.length) parts.push(`Called by ${countBy(users)}`);
      details.push(
        ...callers.map((c) => `${c.kind} ${c.name}`),
        ...lwc.map((l) => `Lightning component ${l.name}`),
        ...pages.map((p) => `Visualforce page ${p.name}`),
      );
      const cls = model.classes.get(key(comp.name));
      const writes = [...new Set((cls?.writes ?? []).map((w) => w.object))];
      if (writes.length) parts.push(`saves ${writes.slice(0, 4).join(", ")}${writes.length > 4 ? "…" : ""}`);
      break;
    }
    case "Flow": {
      const flow = model.flows.get(key(comp.name));
      if (flow?.trigger) parts.push(`Runs ${flow.trigger.timing} save of ${flow.trigger.object}`);
      const parents = callersOfFlow(model, comp.name);
      if (parents.length) {
        parts.push(`subflow of ${plural(parents.length, "flow")}`);
        details.push(...parents.map((p) => `Flow ${p.name}`));
      }
      if (flow && !flow.active) parts.push("inactive");
      break;
    }
    case "Metadata": {
      const omniKind = omniKindOf(comp);
      if (omniKind) {
        const self = omniOf(model).find((o) => o.file === comp.file);
        if (!self) break;
        const callers = omniCallersOf(model, omniKind, self.name).filter((c) => c.file !== self.file);
        if (callers.length) {
          parts.push(`Used by ${countBy(callers.map((c) => c.kind))}`);
          details.push(...callers.map((c) => `${omniLabel(c.kind)} ${c.name}`));
        }
        const calls = [...new Map(self.calls.map((c) => [`${c.kind}|${c.target.toLowerCase()}`, c])).values()];
        if (calls.length) {
          // Apex classes and components are named apart from OmniStudio's own kinds.
          const kinds = calls.map((c) =>
            c.kind === "ApexClass"
              ? "ApexClassTarget"
              : c.kind === "LightningComponent"
                ? "LightningComponentTarget"
                : c.kind,
          );
          parts.push(`calls ${countBy(kinds)}`);
          details.push(...calls.map((c) => `calls ${omniLabel(c.kind)} ${c.target}${c.method ? `.${c.method}` : ""}`));
        }
        const objects = [...new Set([...self.reads, ...self.writes].map((u) => u.object))];
        if (self.writes.length) parts.push(`saves ${[...new Set(self.writes.map((w) => w.object))].join(", ")}`);
        else if (objects.length) parts.push(`reads ${objects.slice(0, 4).join(", ")}${objects.length > 4 ? "…" : ""}`);
        if (!self.active) parts.push("inactive");
        break;
      }
      if (comp.metadataType === "LightningComponentBundle" || comp.metadataType === "AuraDefinitionBundle") {
        const parents = lightningEmbedding(model, comp.name);
        const pages = flexipagesPlacing(model, comp.name);
        if (parents.length || pages.length)
          parts.push(
            `Used in ${[parents.length ? plural(parents.length, "component") : "", pages.length ? plural(pages.length, "Lightning page") : ""].filter(Boolean).join(" and ")}`,
          );
        details.push(...parents.map((p) => `Component ${p.name}`), ...pages.map((p) => `Lightning page ${p.name}`));
      }
      break;
    }
    default:
      break;
  }
  return { summary: parts.join(" · "), details };
}
