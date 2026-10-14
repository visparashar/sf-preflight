// SPDX-License-Identifier: Apache-2.0
import { bool, key, nodes, parseMetadataXml, text, uniq, type XmlNode } from "../util.js";
import { formulaFieldRefs } from "./formula.js";

/**
 * Declarative rules that run when a record is saved (or, for approval processes, submitted):
 * assignment, auto-response, escalation and duplicate rules, matching rules and approval
 * processes. Only what the analysis needs: which object, whether active, which fields they read
 * and, for duplicate rules, whether they block the save.
 */

export type SaveRuleKind =
  | "AssignmentRule"
  | "AutoResponseRule"
  | "EscalationRule"
  | "DuplicateRule"
  | "MatchingRule"
  | "ApprovalProcess"
  | "WorkflowRule";

export interface SaveRuleDef {
  kind: SaveRuleKind;
  /** `Object.Rule`. */
  name: string;
  object: string;
  active: boolean;
  /** Field API names (without the object) its criteria read. */
  fields: string[];
  file: string;
  /** Duplicate rules: whether a match blocks the save. */
  blocks?: { insert: boolean; update: boolean };
  /** Duplicate rules: the matching rules they use (`Object.Rule` or the rule name). */
  matchingRules?: string[];
  /** Approval processes: who can edit a record while it is locked in approval. */
  recordEditability?: string;
  /** Approval processes and workflow rules: field updates and other actions they run. */
  actions?: string[];
  /** Workflow rules: the saves they run on. */
  events?: ("insert" | "update")[];
  /** Workflow rules: objects whose records their actions create (tasks). */
  creates?: string[];
  /** Workflow rules: some actions run later (time-dependent). */
  timeDependent?: boolean;
}

/** `Case.Origin` or `Origin` → `Origin`, for fields of `object`. */
const fieldOf = (object: string, f: string): string | undefined => {
  const parts = f.split(".");
  if (parts.length === 1) return f;
  return key(parts[0] ?? "") === key(object) && parts.length === 2 ? parts[1] : undefined;
};

/** Fields in `criteriaItems` and `formula` / `booleanFilter`-style elements anywhere below a node. */
function criteriaFields(object: string, node: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown, el?: string) => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x, el);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) visit(child, k);
      return;
    }
    const s = text(v);
    if (!s) return;
    if (el === "field" || el === "fieldName") {
      const f = fieldOf(object, s);
      if (f) out.push(f);
    } else if (el === "formula") {
      for (const r of formulaFieldRefs(s)) {
        const f = fieldOf(object, r);
        if (f) out.push(f);
      }
    }
  };
  visit(node);
  return uniq(out);
}

const RULE_SETS: Record<string, { element: string; kind: SaveRuleKind }> = {
  AssignmentRules: { element: "assignmentRule", kind: "AssignmentRule" },
  AutoResponseRules: { element: "autoResponseRule", kind: "AutoResponseRule" },
  EscalationRules: { element: "escalationRule", kind: "EscalationRule" },
};

/** An assignment, auto-response or escalation rules file (`Case.assignmentRules-meta.xml`). */
export function parseRuleSet(xml: string, object: string, file: string): SaveRuleDef[] {
  const { root, body } = parseMetadataXml(xml);
  const set = RULE_SETS[root];
  if (!set) return [];
  return nodes(body[set.element]).map((r: XmlNode) => ({
    kind: set.kind,
    name: `${object}.${text(r.fullName) ?? "rule"}`,
    object,
    active: bool(r.active),
    fields: criteriaFields(object, r.ruleEntry),
    file,
  }));
}

/** A duplicate rule (`Account.Standard_Rule.duplicateRule-meta.xml`). */
export function parseDuplicateRule(xml: string, name: string, object: string, file: string): SaveRuleDef {
  const { body } = parseMetadataXml(xml);
  const block = (v: unknown) => key(text(v) ?? "") === "block";
  return {
    kind: "DuplicateRule",
    name,
    object,
    active: bool(body.isActive),
    fields: criteriaFields(object, body.duplicateRuleFilter),
    file,
    blocks: { insert: block(body.actionOnInsert), update: block(body.actionOnUpdate) },
    matchingRules: nodes(body.duplicateRuleMatchRules)
      .map((m) => text(m.matchingRule) ?? "")
      .filter(Boolean),
  };
}

/** A matching rules file (`Account.matchingRule-meta.xml`), one or more rules. */
export function parseMatchingRules(xml: string, object: string, file: string): SaveRuleDef[] {
  const { body } = parseMetadataXml(xml);
  return nodes(body.matchingRules).map((r) => ({
    kind: "MatchingRule" as const,
    name: `${object}.${text(r.fullName) ?? "rule"}`,
    object,
    active: key(text(r.ruleStatus) ?? "") === "active",
    fields: criteriaFields(object, r.matchingRuleItems),
    file,
  }));
}

/** An approval process (`Opportunity.Discount.approvalProcess-meta.xml`). */
export function parseApprovalProcess(xml: string, name: string, object: string, file: string): SaveRuleDef {
  const { body } = parseMetadataXml(xml);
  const actions = [
    "initialSubmissionActions",
    "finalApprovalActions",
    "finalRejectionActions",
    "recallActions",
  ].flatMap((el) =>
    nodes(body[el]).flatMap((a) =>
      nodes(a.action).map((x) => `${text(x.type) ?? "action"} ${text(x.name) ?? ""}`.trim()),
    ),
  );
  return {
    kind: "ApprovalProcess",
    name,
    object,
    active: bool(body.active),
    fields: criteriaFields(object, [body.entryCriteria, nodes(body.approvalStep).map((s) => s.entryCriteria)]),
    file,
    recordEditability: text(body.recordEditability),
    actions: uniq(actions),
  };
}

/**
 * A workflow file (`Opportunity.workflow-meta.xml`): one entry per rule. A rule reads the fields of
 * its criteria and formula, and of the field updates and email alerts it runs; its actions are listed
 * by what they do, and a task action creates Task records.
 */
export function parseWorkflow(xml: string, object: string, file: string): SaveRuleDef[] {
  const { body } = parseMetadataXml(xml);
  const byName = (el: string) => new Map(nodes(body[el]).map((n) => [key(text(n.fullName) ?? ""), n]));
  const updates = byName("fieldUpdates");
  const alerts = byName("alerts");
  const flows = byName("flowActions");
  return nodes(body.rules).map((r: XmlNode) => {
    const timed = nodes(r.workflowTimeTriggers);
    const actions = [...nodes(r.actions), ...timed.flatMap((t) => nodes(t.actions))];
    const fieldNodes: unknown[] = [r.criteriaItems, r.formula ? { formula: r.formula } : undefined];
    const labels: string[] = [];
    let creates = false;
    for (const a of actions) {
      const name = text(a.name) ?? "";
      const k = key(name);
      switch (text(a.type)) {
        case "FieldUpdate": {
          const u = updates.get(k);
          fieldNodes.push(u);
          labels.push(`field update ${text(u?.field) ?? name}`);
          break;
        }
        case "Alert":
          fieldNodes.push(alerts.get(k));
          labels.push(`email alert ${name}`);
          break;
        case "Task":
          creates = true;
          labels.push(`task ${name}`);
          break;
        case "OutboundMessage":
          labels.push(`outbound message ${name}`);
          break;
        case "FlowAction":
          labels.push(`flow ${text(flows.get(k)?.flow) ?? name}`);
          break;
        default:
          labels.push(`${text(a.type) ?? "action"} ${name}`.trim());
      }
    }
    const trigger = text(r.triggerType) ?? "onCreateOrTriggeringUpdate";
    return {
      kind: "WorkflowRule" as const,
      name: `${object}.${text(r.fullName) ?? "rule"}`,
      object,
      active: bool(r.active),
      fields: criteriaFields(object, fieldNodes),
      file,
      actions: uniq(labels),
      events: trigger === "onCreateOnly" ? ["insert" as const] : ["insert" as const, "update" as const],
      creates: creates ? ["Task"] : undefined,
      timeDependent: timed.length > 0 || undefined,
    };
  });
}
