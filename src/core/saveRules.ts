// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import path from "node:path";
import { readProjectFile } from "./files.js";
import { writersOf } from "./graph.js";
import {
  parseApprovalProcess,
  parseDuplicateRule,
  parseMatchingRules,
  parseRuleSet,
  parseWorkflow,
  type SaveRuleDef,
} from "./parsers/saveRules.js";
import type { AutomationRef, ComponentRef, Finding, OrgModel } from "./types.js";
import { key, uniq } from "./util.js";

export type { SaveRuleDef } from "./parsers/saveRules.js";

/** Metadata types holding save rules. */
export const SAVE_RULE_TYPES = new Set([
  "AssignmentRules",
  "AutoResponseRules",
  "EscalationRules",
  "DuplicateRule",
  "MatchingRules",
  "ApprovalProcess",
]);

const LABEL: Record<SaveRuleDef["kind"], string> = {
  AssignmentRule: "assignment rule",
  AutoResponseRule: "auto-response rule",
  EscalationRule: "escalation rule",
  DuplicateRule: "duplicate rule",
  MatchingRule: "matching rule",
  ApprovalProcess: "approval process",
  WorkflowRule: "workflow rule",
};
export const ruleLabel = (r: SaveRuleDef) => `${LABEL[r.kind]} ${r.name}`;

/** Parse one save-rule file. `Object.Name` components carry the object in the name. */
export function parseSaveRuleFile(comp: ComponentRef, xml: string): SaveRuleDef[] {
  const [object = comp.name] = comp.name.split(".");
  if (comp.type === "WorkflowRule") return parseWorkflow(xml, object, comp.file);
  switch (comp.metadataType) {
    case "AssignmentRules":
    case "AutoResponseRules":
    case "EscalationRules":
      return parseRuleSet(xml, comp.name, comp.file);
    case "DuplicateRule":
      return [parseDuplicateRule(xml, comp.name, object, comp.file)];
    case "MatchingRules":
      return parseMatchingRules(xml, comp.name, comp.file);
    case "ApprovalProcess":
      return [parseApprovalProcess(xml, comp.name, object, comp.file)];
    default:
      return [];
  }
}

const cache = new WeakMap<OrgModel, SaveRuleDef[]>();

/** Every save rule in the project. Duplicate rules also list the fields of their matching rules. */
export function saveRulesOf(model: OrgModel): SaveRuleDef[] {
  let rules = cache.get(model);
  if (rules) return rules;
  rules = [];
  for (const c of model.components.values()) {
    if (c.type !== "WorkflowRule" && (!c.metadataType || !SAVE_RULE_TYPES.has(c.metadataType))) continue;
    try {
      rules.push(...parseSaveRuleFile(c, readProjectFile(model, c.file)));
    } catch {
      model.warnings.push(`Could not parse ${c.file}.`);
    }
  }
  const matching = rules.filter((r) => r.kind === "MatchingRule");
  for (const d of rules) {
    if (d.kind !== "DuplicateRule") continue;
    for (const m of d.matchingRules ?? []) {
      const mk = key(m.includes(".") ? m : `${d.object}.${m}`);
      const mr = matching.find((x) => key(x.name) === mk);
      if (mr) d.fields = uniq([...d.fields, ...mr.fields]);
    }
  }
  cache.set(model, rules);
  return rules;
}

/** Active rules of a kind on an object. */
export const activeRules = (model: OrgModel, object: string, kind: SaveRuleDef["kind"]) =>
  saveRulesOf(model).filter((r) => r.active && r.kind === kind && key(r.object) === key(object));

/** Rules (any kind) whose criteria read a field. */
export const rulesReadingField = (model: OrgModel, object: string, field: string) =>
  saveRulesOf(model).filter(
    (r) => r.kind !== "MatchingRule" && key(r.object) === key(object) && r.fields.some((f) => key(f) === key(field)),
  );

export const automationRef = (r: SaveRuleDef): AutomationRef => ({
  kind: r.kind === "MatchingRule" ? "DuplicateRule" : r.kind,
  name: r.name,
  file: r.file,
});

const describeWriter = (a: AutomationRef) =>
  `${a.kind === "Flow" ? "flow" : a.kind === "ApexTrigger" ? "trigger" : a.kind === "ApexClass" ? "class" : a.kind === "LightningComponent" ? "component" : a.kind} ${a.name}`;

/**
 * A changed save-rule file, compared with its base version: rules switched on or off, duplicate
 * rules that now block saves (with the automation that saves the object), approval processes.
 */
export function saveRuleChangeFindings(
  model: OrgModel,
  comp: ComponentRef,
  current: SaveRuleDef[],
  previous: SaveRuleDef[] | undefined,
): Finding[] {
  const out: Finding[] = [];
  const before = new Map((previous ?? []).map((r) => [key(r.name), r]));
  for (const r of current) {
    const p = before.get(key(r.name));
    const isNew = !p;
    const activated = r.active && (!p || !p.active);
    const deactivated = !r.active && p?.active;
    if (r.kind === "DuplicateRule") {
      const nowBlocks = r.active && (r.blocks?.insert || r.blocks?.update);
      const blockedBefore = p?.active && (p.blocks?.insert || p.blocks?.update);
      if (nowBlocks && (!blockedBefore || activated)) {
        const events = [r.blocks?.insert ? "insert" : "", r.blocks?.update ? "update" : ""].filter(Boolean);
        const writers = writersOf(model, r.object).filter((w) =>
          w.writes.some((x) => events.includes(x.op === "upsert" ? "insert" : x.op) || x.op === "upsert"),
        );
        out.push({
          rule: "automated-write-vs-duplicate-rule",
          severity: writers.length ? "high" : "medium",
          title: `Duplicate rule ${r.name} now blocks ${events.join(" and ")} of ${r.object} records it matches`,
          detail: writers.length
            ? `${writers.map((w) => describeWriter(w.automation)).join(", ")} save ${r.object} records and fail when a save matches${r.fields.length ? ` on ${r.fields.join(", ")}` : ""}. Apex can set Database.DMLOptions.DuplicateRuleHeader.allowSave to save anyway. Test them with data that matches an existing record.`
            : `Users, imports and integrations that save matching ${r.object} records are blocked${r.fields.length ? ` (it matches on ${r.fields.join(", ")})` : ""}. Check data loads and integrations.`,
          object: r.object,
          files: uniq([r.file, ...writers.map((w) => w.automation.file).filter((f): f is string => !!f)]),
        });
        continue;
      }
    }
    if (activated || deactivated || (isNew && r.active)) {
      out.push({
        rule: "save-rule-changed",
        severity: r.kind === "ApprovalProcess" || r.kind === "AssignmentRule" ? "medium" : "low",
        title: `${LABEL[r.kind][0]?.toUpperCase()}${LABEL[r.kind].slice(1)} ${r.name} ${deactivated ? "switched off" : isNew ? "added" : "switched on"}`,
        detail: `${EFFECT[r.kind]}${r.fields.length ? ` Its criteria read ${r.fields.join(", ")}.` : ""}`,
        object: r.object,
        files: [r.file],
      });
    } else if (p && r.active && key(p.fields.join()) !== key(r.fields.join())) {
      out.push({
        rule: "save-rule-changed",
        severity: "low",
        title: `${LABEL[r.kind][0]?.toUpperCase()}${LABEL[r.kind].slice(1)} ${r.name} now reads different fields`,
        detail: `${EFFECT[r.kind]} Criteria fields: ${p.fields.join(", ") || "none"} → ${r.fields.join(", ") || "none"}. Check which records it now applies to.`,
        object: r.object,
        files: [r.file],
      });
    }
  }
  const now = new Set(current.map((r) => key(r.name)));
  const removed = (previous ?? []).filter((p) => p.active && !now.has(key(p.name)));
  for (const r of removed) {
    out.push({
      rule: "save-rule-changed",
      severity: "low",
      title: `${LABEL[r.kind][0]?.toUpperCase()}${LABEL[r.kind].slice(1)} ${r.name} removed`,
      detail: EFFECT[r.kind],
      object: r.object,
      files: [comp.file],
    });
  }
  return out;
}

const EFFECT: Record<SaveRuleDef["kind"], string> = {
  AssignmentRule:
    "Assignment rules set the record owner after the after-save triggers, when the save asks for them (web-to-lead and web-to-case use the active rule; the UI and API ask with a checkbox or header). Ownership decides sharing, queues and reports.",
  AutoResponseRule: "Auto-response rules email the person who submitted a lead or case.",
  EscalationRule:
    "Escalation rules reassign or notify on open cases after a time; their actions run later, outside the save.",
  DuplicateRule:
    "Duplicate rules check each saved record against matching rules after validation rules run, and can alert or block.",
  MatchingRule: "Matching rules decide which records the duplicate rules that use them treat as duplicates.",
  WorkflowRule:
    "Workflow rules run after the after-save triggers: field updates change the record and run its before and after update triggers (and flows) once more; email alerts and outbound messages go out; task actions create Task records. Workflow is a legacy tool; consider moving the rule to a flow.",
  ApprovalProcess:
    "Approval processes lock records while they are in approval and run field updates when they are approved, rejected or recalled. Locked records can only be edited by the people the process allows.",
};

// ---- Platform events ------------------------------------------------------------------------

export const isPlatformEvent = (object: string) => /__e$/i.test(object);

/** Who publishes a platform event and who subscribes to it. */
export function platformEventParties(model: OrgModel, event: string) {
  const k = key(event);
  const re = new RegExp(`\\b${event.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const publishers: AutomationRef[] = [];
  const subscribers: AutomationRef[] = [];
  for (const f of model.flows.values()) {
    if (f.platformEvent && key(f.platformEvent) === k) subscribers.push({ kind: "Flow", name: f.name, file: f.file });
    else if (f.writes.some((w) => key(w.object) === k)) publishers.push({ kind: "Flow", name: f.name, file: f.file });
  }
  for (const t of model.triggers.values()) {
    if (key(t.object) === k) subscribers.push({ kind: "ApexTrigger", name: t.name, file: t.file });
    else if (/EventBus\.publish/i.test(t.stripped) && re.test(t.stripped))
      publishers.push({ kind: "ApexTrigger", name: t.name, file: t.file });
  }
  // Lightning components subscribe through the Emp API, on channel `/event/Name__e`.
  const channel = new RegExp(`/event/${event.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i");
  for (const lc of model.lightning.values()) {
    const named = lc.files.some((f) => {
      if (/__tests__/.test(f)) return false;
      try {
        return channel.test(readProjectFile(model, f));
      } catch {
        return false;
      }
    });
    if (named) subscribers.push({ kind: "LightningComponent", name: lc.name, file: lc.file });
  }
  for (const c of model.classes.values()) {
    if (c.isTest) continue;
    if (/EventBus\.publish/i.test(c.stripped) && re.test(c.stripped))
      publishers.push({ kind: "ApexClass", name: c.name, file: c.file });
  }
  return { publishers, subscribers };
}

/** A changed or deleted platform event, or one of its fields. */
export function platformEventFindings(model: OrgModel, comp: ComponentRef, event: string, deleted: boolean): Finding[] {
  const { publishers, subscribers } = platformEventParties(model, event);
  if (!publishers.length && !subscribers.length) return [];
  const what = comp.type === "CustomField" ? `field ${comp.name}` : `platform event ${event}`;
  const parts = [
    publishers.length
      ? `Published by ${publishers.map(describeWriter).join(", ")}.`
      : "No publisher in the project (an integration or another package may publish it).",
    subscribers.length ? `Subscribed to by ${subscribers.map(describeWriter).join(", ")}.` : "",
  ].filter(Boolean);
  return [
    {
      rule: "platform-event-contract",
      severity: deleted ? "high" : "medium",
      title: `${deleted ? "Deleted" : "Changed"} ${what} is a contract between its publishers and ${subscribers.length} subscriber(s)`,
      detail: `${parts.join(" ")} Events reach subscribers after the publishing transaction commits, so a mismatch shows up as failed or skipped event handling, not as a save error. ${deleted ? "Remove it from publishers and subscribers in the same change." : "Deploy publishers and subscribers together and test one event end to end."}`,
      object: event,
      files: uniq([comp.file, ...[...publishers, ...subscribers].map((a) => a.file).filter((f): f is string => !!f)]),
    },
  ];
}
