// SPDX-License-Identifier: Apache-2.0
import { flowWrites, triggerWrites } from "./graph.js";
import { activeRules, automationRef, isPlatformEvent, type SaveRuleDef } from "./saveRules.js";
import type { OrgModel, Phase, SaveEvent, SaveProcedure, SaveStep, Write } from "./types.js";
import { key } from "./util.js";

/**
 * Simplified Salesforce order of execution for a single DML event on one object.
 *
 * 1. Before-save record-triggered flows (and before-delete flows)
 * 2. Before triggers
 * 3. Custom validation rules (insert/update only)
 * 4. Duplicate rules (insert/update)
 * 5. After triggers
 * 6. Assignment rules, auto-response rules (Case and Lead) and escalation rules (Case)
 * 7. After-save record-triggered flows
 * 8. Roll-up summary recalculation on master records (the parent re-enters its own save)
 *
 * Platform events are different: their subscribers (triggers and platform-event flows) run later,
 * in their own transaction. Legacy workflow and criteria-based sharing are not modelled yet. Order *within* a phase follows Salesforce's
 * flow trigger order where set; otherwise it is undefined in Salesforce and alphabetical here.
 */
export const PHASE_LABELS: Record<Phase, string> = {
  "before-flow": "Before-save flow",
  "before-trigger": "Before trigger",
  validation: "Validation rule",
  duplicate: "Duplicate rule",
  "after-trigger": "After trigger",
  assignment: "Assignment rule",
  "auto-response": "Auto-response rule",
  escalation: "Escalation rule",
  "after-flow": "After-save flow",
  rollup: "Roll-up summary",
};

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

export function saveProcedure(model: OrgModel, object: string, event: SaveEvent): SaveProcedure {
  const k = key(object);
  const steps: Omit<SaveStep, "order">[] = [];

  const flows = [...model.flows.values()]
    .filter((f) => f.active && f.trigger && key(f.trigger.object) === k && f.trigger.events.includes(event))
    .sort(byName);
  const triggers = [...model.triggers.values()].filter((t) => key(t.object) === k).sort(byName);
  const ruleStep = (phase: Phase, r: SaveRuleDef, notes: string[]) =>
    steps.push({
      phase,
      phaseLabel: PHASE_LABELS[phase],
      automation: { ...automationRef(r), phase },
      writes: [],
      notes,
    });
  // Publishing a platform event: subscribers run later, in their own transaction.
  const async = isPlatformEvent(object) ? ["subscriber: runs later, in its own transaction"] : [];

  for (const flow of flows.filter((f) => f.trigger!.timing === "before")) {
    // Before-save flows change the record in memory; their $Record "updates" are not DML.
    const writes = flowWrites(model, flow).filter((w) => !w.selfUpdate);
    const notes = flow.trigger!.entryFields.length ? [`entry criteria on ${flow.trigger!.entryFields.join(", ")}`] : [];
    if (flow.fieldSets.length) notes.push(`sets ${flow.fieldSets.join(", ")}`);
    steps.push({
      phase: "before-flow",
      phaseLabel: PHASE_LABELS["before-flow"],
      automation: { kind: "Flow", name: flow.name, file: flow.file, phase: "before-flow" },
      writes,
      notes,
    });
  }

  for (const timing of ["before", "after"] as const) {
    if (timing === "after" && event !== "delete") {
      // validation rules sit between before and after triggers
      for (const vr of model.validationRules.filter((v) => v.active && key(v.object) === k).sort(byName)) {
        if (event !== "insert" && event !== "update") continue;
        steps.push({
          phase: "validation",
          phaseLabel: PHASE_LABELS.validation,
          automation: { kind: "ValidationRule", name: vr.name, file: vr.file, phase: "validation" },
          writes: [],
          notes: vr.fieldRefs.length ? [`checks ${vr.fieldRefs.join(", ")}`] : [],
        });
      }
      if (event === "insert" || event === "update") {
        for (const d of activeRules(model, object, "DuplicateRule").sort(byName)) {
          const blocks = event === "insert" ? d.blocks?.insert : d.blocks?.update;
          ruleStep("duplicate", d, [
            blocks ? "blocks the save when a duplicate is found" : "alerts on duplicates, allows the save",
            ...(d.fields.length ? [`matches on ${d.fields.join(", ")}`] : []),
          ]);
        }
      }
    }
    const phase: Phase = timing === "before" ? "before-trigger" : "after-trigger";
    for (const trig of triggers.filter((t) => t.events.some((e) => e.timing === timing && e.event === event))) {
      // Attribute DML to the after phase when the trigger has one for this event, else to before.
      const hasAfter = trig.events.some((e) => e.timing === "after" && e.event === event);
      const writes = timing === "after" || !hasAfter ? triggerWrites(model, trig) : [];
      steps.push({
        phase,
        phaseLabel: PHASE_LABELS[phase],
        automation: { kind: "ApexTrigger", name: trig.name, file: trig.file, phase },
        writes,
        notes: [...async],
      });
    }
  }

  if (event === "insert" || event === "update") {
    for (const r of activeRules(model, object, "AssignmentRule").sort(byName))
      ruleStep("assignment", r, ["sets the owner when the save asks for assignment rules"]);
    for (const r of activeRules(model, object, "AutoResponseRule").sort(byName))
      ruleStep("auto-response", r, ["sends an email to the submitter"]);
    for (const r of activeRules(model, object, "EscalationRule").sort(byName))
      ruleStep("escalation", r, ["actions run later, when the case is still open"]);
  }

  for (const flow of flows.filter((f) => f.trigger!.timing === "after")) {
    const writes = flowWrites(model, flow);
    const notes: string[] = [];
    if (flow.trigger!.entryFields.length) notes.push(`entry criteria on ${flow.trigger!.entryFields.join(", ")}`);
    if (writes.some((w) => w.selfUpdate)) notes.push("updates its own triggering record (re-enters the save)");
    if (flow.trigger!.hasScheduledPaths) notes.push("has scheduled paths (runs asynchronously later)");
    steps.push({
      phase: "after-flow",
      phaseLabel: PHASE_LABELS["after-flow"],
      automation: { kind: "Flow", name: flow.name, file: flow.file, phase: "after-flow" },
      writes,
      notes,
    });
  }

  if (async.length && event === "insert") {
    for (const flow of [...model.flows.values()]
      .filter((f) => f.active && f.platformEvent && key(f.platformEvent) === k)
      .sort(byName)) {
      steps.push({
        phase: "after-flow",
        phaseLabel: "Platform event flow",
        automation: { kind: "Flow", name: flow.name, file: flow.file, phase: "after-flow" },
        writes: flowWrites(model, flow),
        notes: [...async],
      });
    }
  }

  for (const parent of model.objects.values()) {
    for (const field of parent.fields.values()) {
      if (!field.summary || key(field.summary.childObject) !== k) continue;
      const write: Write = {
        object: parent.name,
        op: "update",
        fields: [field.name],
        via: "roll-up summary",
        confidence: "high",
      };
      steps.push({
        phase: "rollup",
        phaseLabel: PHASE_LABELS.rollup,
        automation: { kind: "RollUpSummary", name: field.fullName, file: field.file, phase: "rollup" },
        writes: [write],
        notes: [
          `${field.summary.operation ?? "summary"} of ${field.summary.summarizedField ?? field.summary.childObject}`,
        ],
      });
    }
  }

  return { object, event, steps: steps.map((s, i) => ({ ...s, order: i + 1 })) };
}
