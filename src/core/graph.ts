// SPDX-License-Identifier: Apache-2.0

import { omniCallersOf, omniRef, omniWriters } from "./omnistudio.js";
import { customComponent } from "./parsers/pages.js";
import type {
  ApexClassDef,
  ApexTriggerDef,
  AutomationRef,
  FlexiPageDef,
  FlowDef,
  LightningDef,
  OrgModel,
  Write,
} from "./types.js";
import { key, uniqBy } from "./util.js";

const MAX_DEPTH = 4;

const writeKey = (w: Write) => `${w.object.toLowerCase()}|${w.op}|${w.selfUpdate ? "self" : ""}|${w.via ?? ""}`;

/** Project classes referenced from a class/trigger (system classes and unknown names dropped). */
export function knownClassRefs(model: OrgModel, refs: string[]): ApexClassDef[] {
  return refs.map((r) => model.classes.get(key(r))).filter((c): c is ApexClassDef => !!c && !c.isTest);
}

/** Writes performed by a class, including classes it calls (transitively, bounded). */
export function classWrites(model: OrgModel, cls: ApexClassDef, seen = new Set<string>(), depth = 0): Write[] {
  if (seen.has(key(cls.name)) || depth > MAX_DEPTH) return [];
  seen.add(key(cls.name));
  const out: Write[] = cls.writes.map((w) => ({ ...w, via: `${cls.name} ${w.via ?? ""}`.trim() }));
  for (const callee of knownClassRefs(model, cls.classRefs)) out.push(...classWrites(model, callee, seen, depth + 1));
  return uniqBy(out, writeKey);
}

/** Writes performed by a trigger body and the handler classes it calls. */
export function triggerWrites(model: OrgModel, trig: ApexTriggerDef): Write[] {
  const out: Write[] = trig.writes.map((w) => ({ ...w, via: `${trig.name} ${w.via ?? ""}`.trim() }));
  const seen = new Set<string>();
  for (const cls of knownClassRefs(model, trig.classRefs)) {
    for (const w of classWrites(model, cls, seen)) {
      // `Trigger.new` passed into a handler and updated there is a self update.
      const self = w.object.toLowerCase() === trig.object.toLowerCase() && w.op === "update" ? true : w.selfUpdate;
      out.push({ ...w, selfUpdate: self || undefined });
    }
  }
  return uniqBy(out, writeKey);
}

/**
 * Writes performed by a flow, its Apex actions and its subflows.
 *
 * `recordVars` names this flow's variables that hold the top-level flow's triggering record (passed
 * in as `$Record` by a caller): an update through one of them is an update of that record.
 */
export function flowWrites(
  model: OrgModel,
  flow: FlowDef,
  seen = new Set<string>(),
  depth = 0,
  recordVars = new Set<string>(),
): Write[] {
  if (seen.has(key(flow.name)) || depth > MAX_DEPTH) return [];
  seen.add(key(flow.name));
  const out: Write[] = flow.writes.map((w) => ({
    ...w,
    via: `${flow.name}${w.via ? ` › ${w.via}` : ""}`,
    ...(w.op === "update" && w.recordVar && recordVars.has(key(w.recordVar)) ? { selfUpdate: true } : {}),
  }));
  const classSeen = new Set<string>();
  for (const action of flow.apexActions) {
    const cls = model.classes.get(key(action));
    if (cls) out.push(...classWrites(model, cls, classSeen));
  }
  const calls = flow.subflowCalls ?? flow.subflows.map((f) => ({ flow: f, inputs: [] }));
  for (const call of calls) {
    const subflow = model.flows.get(key(call.flow));
    if (!subflow) continue;
    const passed = new Set(
      call.inputs
        .filter((i) => (i.ref === "$Record" && depth === 0 && flow.trigger) || recordVars.has(key(i.ref)))
        .map((i) => key(i.variable)),
    );
    out.push(...flowWrites(model, subflow, seen, depth + 1, passed));
  }
  return uniqBy(out, writeKey);
}

export interface Writer {
  automation: AutomationRef;
  writes: Write[];
}

/**
 * Every automation in the project that writes to `object` (active flows, triggers, non-test classes,
 * OmniStudio Data Mapper Loads).
 */
export function writersOf(model: OrgModel, object: string): Writer[] {
  const target = object.toLowerCase();
  const result: Writer[] = [];
  for (const flow of model.flows.values()) {
    if (!flow.active) continue;
    const ws = flowWrites(model, flow).filter((w) => w.object.toLowerCase() === target && w.op !== "delete");
    if (ws.length) result.push({ automation: { kind: "Flow", name: flow.name, file: flow.file }, writes: ws });
  }
  for (const trig of model.triggers.values()) {
    const ws = triggerWrites(model, trig).filter((w) => w.object.toLowerCase() === target && w.op !== "delete");
    if (ws.length) result.push({ automation: { kind: "ApexTrigger", name: trig.name, file: trig.file }, writes: ws });
  }
  for (const cls of model.classes.values()) {
    if (cls.isTest) continue;
    const ws = cls.writes.filter((w) => w.object.toLowerCase() === target && w.op !== "delete");
    if (ws.length) result.push({ automation: { kind: "ApexClass", name: cls.name, file: cls.file }, writes: ws });
  }
  result.push(...omniWriters(model, object));
  return result;
}

/** Triggers, flows, classes, Lightning components and OmniStudio components that directly reference a class. */
export function callersOfClass(model: OrgModel, className: string): AutomationRef[] {
  const k = key(className);
  const callers: AutomationRef[] = [];
  for (const trig of model.triggers.values()) {
    if (trig.classRefs.some((r) => key(r) === k))
      callers.push({ kind: "ApexTrigger", name: trig.name, file: trig.file });
  }
  for (const flow of model.flows.values()) {
    if (flow.apexActions.some((a) => key(a) === k)) callers.push({ kind: "Flow", name: flow.name, file: flow.file });
  }
  for (const cls of model.classes.values()) {
    if (key(cls.name) !== k && cls.classRefs.some((r) => key(r) === k)) {
      callers.push({ kind: "ApexClass", name: cls.name, file: cls.file });
    }
  }
  for (const lc of lightningCallingClass(model, className)) {
    callers.push({ kind: "LightningComponent", name: lc.name, file: lc.file });
  }
  for (const o of omniCallersOf(model, "ApexClass", className)) callers.push(omniRef(o));
  return callers;
}

/** Lightning Web Components and Aura components that call methods of an Apex class. */
export function lightningCallingClass(model: OrgModel, className: string): LightningDef[] {
  const k = key(className);
  return [...model.lightning.values()].filter((lc) => lc.apex.some((a) => key(a.cls) === k));
}

/** Lightning components that embed the component `name`. */
export function lightningEmbedding(model: OrgModel, name: string): LightningDef[] {
  const k = key(name);
  return [...model.lightning.values()].filter((lc) => lc.children.some((c) => key(c) === k));
}

/** Lightning pages that place the custom component `name` (c:name, or a bare name for the page's own namespace). */
export function flexipagesPlacing(model: OrgModel, name: string): FlexiPageDef[] {
  const k = key(name);
  return [...model.flexipages.values()].filter((p) =>
    p.components.some((c) => {
      const custom = customComponent(c);
      return custom !== undefined && key(custom) === k;
    }),
  );
}

/**
 * Flows that run, directly or through other subflows, a flow that uses `Object.Field`
 * (`direct`: the flows that use it themselves). Each comes with the subflow chain it reaches
 * the field through and whether its call passes its triggering record.
 */
export function flowsReachingThroughSubflows(
  model: OrgModel,
  direct: FlowDef[],
): { flow: FlowDef; chain: string[]; passesRecord: boolean }[] {
  const out: { flow: FlowDef; chain: string[]; passesRecord: boolean }[] = [];
  const done = new Set(direct.map((f) => key(f.name)));
  let level = direct.map((f) => ({ flow: f, chain: [] as string[] }));
  for (let depth = 0; depth < MAX_DEPTH && level.length; depth++) {
    const next: typeof level = [];
    for (const { flow, chain } of level) {
      for (const parent of callersOfFlow(model, flow.name)) {
        if (done.has(key(parent.name))) continue;
        done.add(key(parent.name));
        const viaChain = [flow.name, ...chain];
        const passesRecord =
          !!parent.trigger &&
          (parent.subflowCalls ?? []).some(
            (c) => key(c.flow) === key(flow.name) && c.inputs.some((i) => i.ref === "$Record"),
          );
        out.push({ flow: parent, chain: viaChain, passesRecord });
        next.push({ flow: parent, chain: viaChain });
      }
    }
    level = next;
  }
  return out;
}

/** Flows that call `flowName` as a subflow. */
export function callersOfFlow(model: OrgModel, flowName: string): FlowDef[] {
  const k = key(flowName);
  return [...model.flows.values()].filter((f) => f.subflows.some((s) => key(s) === k));
}
