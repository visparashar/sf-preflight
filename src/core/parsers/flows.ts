// SPDX-License-Identifier: Apache-2.0
import type { DmlOp, FlowDef, FlowTrigger, FlowValue, SaveEvent, Timing, Write } from "../types.js";
import { nodes, parseMetadataXml, text, uniq, uniqBy, type XmlNode } from "../util.js";

const RECORD_TRIGGER_EVENTS: Record<string, SaveEvent[]> = {
  Create: ["insert"],
  Update: ["update"],
  CreateAndUpdate: ["insert", "update"],
  Delete: ["delete"],
};

const TRIGGER_TIMING: Record<string, Timing> = {
  RecordBeforeSave: "before",
  RecordAfterSave: "after",
  RecordBeforeDelete: "before",
};

/**
 * Parse a `.flow-meta.xml` file.
 *
 * Resolves which objects the flow writes to, including `$Record` (the triggering record),
 * typed SObject variables, Get Records outputs and loop variables.
 */
export function parseFlow(xml: string, fallbackName: string, file: string): FlowDef {
  const { body } = parseMetadataXml(xml);
  const status = text(body.status) ?? "Active";
  const processType = text(body.processType);

  const trigger = parseTrigger(body.start as XmlNode | undefined, text(body.triggerOrder));

  // --- symbol table: name -> SObject type -----------------------------------------
  const symbols = new Map<string, string>();
  for (const v of nodes(body.variables)) {
    const name = text(v.name);
    const objectType = text(v.objectType);
    if (name && objectType && text(v.dataType) === "SObject") symbols.set(name.toLowerCase(), objectType);
  }
  for (const lookup of nodes(body.recordLookups)) {
    const name = text(lookup.name);
    const object = text(lookup.object);
    if (name && object) symbols.set(name.toLowerCase(), object);
  }
  const loopSources = new Map<string, string>();
  for (const loop of nodes(body.loops)) {
    const name = text(loop.name);
    const source = text(loop.collectionReference);
    if (name && source) loopSources.set(name.toLowerCase(), source);
  }

  const resolve = (ref: string | undefined, depth = 0): { object?: string; self: boolean } => {
    if (!ref || depth > 5) return { self: false };
    if (ref === "$Record") return { object: trigger?.object, self: true };
    if (ref.startsWith("$Record")) return { self: false }; // relationship path, unresolved
    const head = ref.split(".")[0]!.toLowerCase();
    const sym = symbols.get(head);
    if (sym) return { object: sym, self: false };
    const loopSource = loopSources.get(head);
    if (loopSource) return resolve(loopSource, depth + 1);
    return { self: false };
  };

  const writes: Write[] = [];
  const fieldRefs: string[] = [];
  const addWrite = (el: XmlNode, op: DmlOp) => {
    const elementName = text(el.name);
    let object = text(el.object);
    let self = false;
    let confidence: Write["confidence"] = "high";
    if (!object) {
      const resolved = resolve(text(el.inputReference));
      object = resolved.object;
      self = resolved.self;
      if (!object) return;
      if (!self) confidence = "medium";
    }
    const fields = uniq(
      nodes(el.inputAssignments)
        .map((a) => text(a.field))
        .filter((f): f is string => !!f),
    );
    // A field assigned or filtered by the triggering record's Id links written records to it.
    const pointsAtRecord = (n: XmlNode) => /^\$Record(\.Id)?$/i.test(flowValue(n.value)?.value ?? "");
    const linkField =
      trigger && !self
        ? text([...nodes(el.inputAssignments), ...nodes(el.filters)].find(pointsAtRecord)?.field)
        : undefined;
    for (const f of fields) fieldRefs.push(`${object}.${f}`);
    for (const filter of nodes(el.filters)) {
      const f = text(filter.field);
      if (f) fieldRefs.push(`${object}.${f}`);
    }
    writes.push({ object, op, fields, selfUpdate: self || undefined, linkField, via: elementName, confidence });
  };

  for (const el of nodes(body.recordUpdates)) addWrite(el, "update");
  for (const el of nodes(body.recordCreates)) addWrite(el, "insert");
  for (const el of nodes(body.recordDeletes)) addWrite(el, "delete");

  // Assignments to the triggering record's fields: how a before-save flow changes the record.
  const fieldSets: string[] = [];
  if (trigger?.timing === "before") {
    // "Update Records" on $Record in a before-save flow sets fields in memory too.
    for (const w of writes) if (w.selfUpdate) fieldSets.push(...(w.fields ?? []));
    for (const el of nodes(body.assignments))
      for (const item of nodes(el.assignmentItems)) {
        const m = /^\$Record\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(text(item.assignToReference) ?? "");
        if (m) fieldSets.push(m[1]!);
      }
  }

  const reads: string[] = [];
  for (const el of nodes(body.recordLookups)) {
    const object = text(el.object);
    if (!object) continue;
    reads.push(object);
    for (const filter of nodes(el.filters)) {
      const f = text(filter.field);
      if (f) fieldRefs.push(`${object}.${f}`);
    }
  }

  const apexActions = uniq(
    nodes(body.actionCalls)
      .filter((a) => text(a.actionType)?.toLowerCase() === "apex")
      .map((a) => text(a.actionName))
      .filter((a): a is string => !!a),
  );
  const subflows = uniq(
    nodes(body.subflows)
      .map((s) => text(s.flowName))
      .filter((s): s is string => !!s),
  );

  if (trigger) {
    for (const f of trigger.entryFields) fieldRefs.push(`${trigger.object}.${f}`);
    // Catch-all: any $Record.Field / $Record__Prior.Field mention in the document.
    for (const m of xml.matchAll(/\$Record(?:__Prior)?\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      fieldRefs.push(`${trigger.object}.${m[1]}`);
    }
  }

  return {
    name: fallbackName,
    label: text(body.label),
    status,
    active: status === "Active",
    processType,
    runInMode: text(body.runInMode),
    trigger,
    platformEvent:
      text((body.start as XmlNode | undefined)?.triggerType) === "PlatformEvent"
        ? text((body.start as XmlNode | undefined)?.object)
        : undefined,
    writes: uniqBy(writes, (w) => `${w.object}|${w.op}|${w.via}`),
    fieldSets: uniq(fieldSets),
    reads: uniq(reads),
    apexActions,
    subflows,
    fieldRefs: uniqBy(fieldRefs, (f) => f.toLowerCase()),
    file,
  };
}

function parseTrigger(start: XmlNode | undefined, flowOrder?: string): FlowTrigger | undefined {
  if (!start) return undefined;
  const object = text(start.object);
  const triggerType = text(start.triggerType);
  const recordTriggerType = text(start.recordTriggerType);
  if (!object || !triggerType || !(triggerType in TRIGGER_TIMING)) return undefined;
  const events =
    triggerType === "RecordBeforeDelete"
      ? (["delete"] as SaveEvent[])
      : (RECORD_TRIGGER_EVENTS[recordTriggerType ?? ""] ?? ["insert", "update"]);
  const filters = nodes(start.filters)
    .map((f) => ({ field: text(f.field) ?? "", operator: text(f.operator) ?? "", value: flowValue(f.value) }))
    .filter((f) => f.field);
  const entryFields = uniq(filters.map((f) => f.field));
  const filterFormula = text(start.filterFormula);
  if (filterFormula) {
    for (const m of filterFormula.matchAll(/\$Record(?:__Prior)?\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (m[1]) entryFields.push(m[1]);
    }
  }
  return {
    object,
    timing: TRIGGER_TIMING[triggerType]!,
    events,
    entryFields: uniq(entryFields),
    filters,
    filterLogic: text(start.filterLogic)?.toLowerCase(),
    filterFormula,
    requiresChange: text(start.doesRequireRecordChangedToMeetCriteria)?.toLowerCase() === "true" || undefined,
    order: triggerOrder(text(start.triggerOrder) ?? flowOrder),
    hasScheduledPaths: nodes(start.scheduledPaths).length > 0,
  };
}

/** The trigger order, 1 to 2000, or undefined when absent or out of range. */
function triggerOrder(v: string | undefined): number | undefined {
  const n = v === undefined ? Number.NaN : Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 2000 ? n : undefined;
}

/** Read a `<value>` element: stringValue, numberValue, booleanValue, dateValue or elementReference. */
export function flowValue(v: unknown): FlowValue | undefined {
  const node = nodes(v)[0];
  if (!node) return undefined;
  const pick = (k: string, kind: FlowValue["kind"]) => {
    const t = text(node[k]);
    return t === undefined ? undefined : { kind, value: t };
  };
  return (
    pick("stringValue", "string") ??
    pick("numberValue", "number") ??
    pick("booleanValue", "boolean") ??
    pick("dateValue", "date") ??
    pick("elementReference", "reference")
  );
}
