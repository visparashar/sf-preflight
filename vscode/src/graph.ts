// SPDX-License-Identifier: Apache-2.0
/**
 * The blast-radius graph shown in the graph panel: what the change touches, as nodes (the changed
 * components, the objects they save, the automation that runs, what references them, affected
 * agent actions) and edges, with each node's distance from the change and its worst finding.
 * Computed from an analysis result without the VS Code API, so it can be tested on its own.
 */
import path from "node:path";
import type { AnalysisResult, AutomationRef, CascadeNode, Severity } from "../../src/core/types.js";

export type GraphNodeKind =
  | "hub"
  | "Object"
  | "Field"
  | "Flow"
  | "ApexTrigger"
  | "ApexClass"
  | "ValidationRule"
  | "RollUpSummary"
  | "PermissionSet"
  | "Profile"
  | "FormulaField"
  | "LightningComponent"
  | "Agent"
  | "AgentTopic"
  | "AgentAction"
  | "Other";

export interface GraphNode {
  id: string;
  label: string;
  kind: GraphNodeKind;
  /** Secondary text, e.g. "Before-save flow" or the agent and topic. */
  detail?: string;
  /** Hops from the change (0 for the change itself). */
  depth: number;
  /** Part of the change. */
  changed?: boolean;
  /** Worst finding on this node. */
  severity?: Severity;
  /** Titles of the findings on this node. */
  findings: string[];
  /** Absolute file to open, and 0-based line. */
  file?: string;
  line?: number;
}

export type GraphEdgeKind = "changes" | "reaches" | "runs" | "writes" | "references" | "agent" | "related";

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  /** Closes an automation cycle: the save comes back to an object already on the path. */
  recursion?: boolean;
}

export interface Graph {
  center: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  risk: AnalysisResult["summary"]["risk"];
  base?: string;
  /** Nodes left out to keep the graph readable. */
  omitted: number;
}

/** Most nodes drawn; the nearest and riskiest are kept. */
export const MAX_GRAPH_NODES = 80;

const ORDER: Severity[] = ["high", "medium", "low", "info"];
const rank = (s?: Severity) => (s ? ORDER.indexOf(s) : ORDER.length);

const AUTOMATION_KIND: Record<AutomationRef["kind"], GraphNodeKind> = {
  Flow: "Flow",
  ApexTrigger: "ApexTrigger",
  ApexClass: "ApexClass",
  ValidationRule: "ValidationRule",
  RollUpSummary: "RollUpSummary",
  LightningComponent: "LightningComponent",
  DuplicateRule: "Other",
  AssignmentRule: "Other",
  AutoResponseRule: "Other",
  EscalationRule: "Other",
  ApprovalProcess: "Other",
  WorkflowRule: "Other",
  OmniScript: "Other",
  IntegrationProcedure: "Other",
  DataMapper: "Other",
  FlexCard: "Other",
  CascadeDelete: "Other",
  Change: "Other",
};

/** Kind of a metadata file, from its path. */
function kindOfFile(file: string): GraphNodeKind {
  if (/\.validationRule-meta\.xml$/.test(file)) return "ValidationRule";
  if (/\.flow-meta\.xml$/.test(file)) return "Flow";
  if (/\.trigger$/.test(file)) return "ApexTrigger";
  if (/\.cls$/.test(file)) return "ApexClass";
  if (/\.permissionset-meta\.xml$/.test(file)) return "PermissionSet";
  if (/\.profile-meta\.xml$/.test(file)) return "Profile";
  if (/\.field-meta\.xml$/.test(file)) return "Field";
  if (/\.object-meta\.xml$/.test(file)) return "Object";
  if (/\/(lwc|aura)\//.test(file)) return "LightningComponent";
  if (/\.genAiFunction-meta\.xml$/.test(file)) return "AgentAction";
  if (/\.genAiPlugin-meta\.xml$/.test(file)) return "AgentTopic";
  if (/\.(bot|botVersion)-meta\.xml$|\.genAiPlannerBundle$|\.agent$/.test(file)) return "Agent";
  return "Other";
}

/** A readable name for a metadata file: `Tier_Required` for `…/Tier_Required.validationRule-meta.xml`. */
function nameOfFile(file: string): string {
  return path.posix.basename(file).replace(/(\.[A-Za-z]+)?-meta\.xml$|\.(cls|trigger|agent)$/, "");
}

export function graphOf(result: AnalysisResult): Graph {
  const abs = (f: string) => path.resolve(result.projectDir, f);
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const node = (id: string, init: Omit<GraphNode, "id" | "depth" | "findings">): GraphNode => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, depth: Number.POSITIVE_INFINITY, findings: [], ...init };
      nodes.set(id, n);
    }
    return n;
  };
  const edge = (from: string, to: string, kind: GraphEdgeKind, recursion = false) => {
    if (from === to) return;
    const key = `${from}\u0000${to}`;
    const e = edges.get(key);
    if (e) e.recursion ||= recursion;
    else edges.set(key, { from, to, kind, ...(recursion ? { recursion } : {}) });
  };

  // Automation is identified by its file when it has one, so the same flow or trigger seen as a
  // change, a save step or a reference is one node.
  const automationId = (a: { kind: string; name: string; file?: string }) =>
    a.file ? `f:${a.file}` : `a:${a.kind}:${a.name}`;
  const automation = (a: AutomationRef, detail?: string) =>
    node(automationId(a), {
      label: a.name,
      kind: AUTOMATION_KIND[a.kind] ?? "Other",
      ...(detail ? { detail } : {}),
      ...(a.file ? { file: abs(a.file), line: 0 } : {}),
    });
  const object = (name: string) => node(`o:${name}`, { label: name, kind: "Object" });
  const objectEvents = new Map<string, Set<string>>();

  // The change.
  const changeIds: string[] = [];
  for (const c of result.changes) {
    const id = `f:${c.component.file}`;
    const kind: GraphNodeKind =
      c.component.type === "CustomField"
        ? "Field"
        : c.component.type === "CustomObject"
          ? "Object"
          : (AUTOMATION_KIND[c.component.type as AutomationRef["kind"]] ?? kindOfFile(c.component.file));
    const n = node(id, {
      label: c.component.name,
      kind,
      detail: c.component.metadataType ? `${c.component.metadataType} · ${c.changeType}` : c.changeType,
      ...(c.changeType === "deleted" ? {} : { file: abs(c.component.file), line: 0 }),
    });
    n.changed = true;
    n.detail = c.changeType;
    changeIds.push(id);
  }
  let center: string;
  if (changeIds.length === 1) center = changeIds[0]!;
  else {
    center = "hub";
    node(center, {
      label: changeIds.length ? `${changeIds.length} changes` : "No changes",
      kind: "hub",
    });
    for (const id of changeIds) edge(center, id, "changes");
  }

  // What runs when each impacted object is saved, and what each step writes.
  for (const sp of result.saveProcedures) {
    const o = object(sp.object);
    const events = objectEvents.get(o.id) ?? new Set<string>();
    events.add(sp.event);
    objectEvents.set(o.id, events);
    for (const st of sp.steps) {
      const a = automation(st.automation, st.phaseLabel);
      edge(o.id, a.id, "runs");
      for (const w of st.writes) edge(a.id, object(w.object).id, "writes");
    }
  }

  // The cascade: where it starts, and the saves that come back round (recursion).
  const walk = (n: CascadeNode, parent?: string) => {
    const o = object(n.object);
    if (n.via) {
      const a = automation(n.via);
      if (parent) edge(parent, a.id, "runs");
      edge(a.id, o.id, parent ? "writes" : "runs", Boolean(n.cycle));
    } else if (parent) edge(parent, o.id, "writes", Boolean(n.cycle));
    for (const child of n.children) walk(child, o.id);
  };
  for (const root of result.cascade) walk(root);

  // How each changed component joins the rest: the object it belongs to, or (an Apex class a
  // trigger calls, say) the automation the cascade starts from.
  for (const c of result.changes) {
    const id = `f:${c.component.file}`;
    if (c.component.object) edge(id, object(c.component.object).id, "changes");
  }
  // Joined to something other than the hub that groups several changes.
  const joined = (id: string) => [...edges.values()].some((e) => (e.from === id || e.to === id) && e.from !== "hub");
  for (const c of result.changes) {
    const id = `f:${c.component.file}`;
    if (c.component.type !== "ApexClass" || joined(id)) continue;
    for (const root of result.cascade) {
      const target = root.via ? automationId(root.via) : `o:${root.object}`;
      if (target !== id && !changeIds.includes(target)) edge(id, target, "reaches");
    }
  }

  // What references the changed fields.
  for (const r of result.references) {
    const from = r.from;
    const kind: GraphNodeKind =
      from.kind === "PermissionSet" || from.kind === "Profile" || from.kind === "FormulaField"
        ? from.kind
        : (AUTOMATION_KIND[from.kind as AutomationRef["kind"]] ?? "Other");
    const n = node(from.file ? `f:${from.file}` : `a:${from.kind}:${from.name}`, {
      label: from.name,
      kind,
      detail: `references ${r.to}`,
      ...(from.file ? { file: abs(from.file), line: 0 } : {}),
    });
    const changedField = result.changes.find((c) => c.component.name === r.to);
    const target = changedField ? `f:${changedField.component.file}` : object(r.to.split(".")[0]!).id;
    edge(target, n.id, "references");
  }

  // Agent actions the change reaches, with what they call; the agent's own files hang off them.
  const ownedBy = new Map<string, string>();
  for (const a of result.agents) {
    const n = node(`g:${a.agent}.${a.action}`, {
      label: a.actionLabel ?? a.action,
      kind: "AgentAction",
      detail: [a.agentLabel ?? a.agent, a.topic].filter(Boolean).join(" · "),
      ...(a.files[0] ? { file: abs(a.files[0]), line: 0 } : {}),
    });
    edge(center, n.id, "agent");
    const targetKind = a.target.kind === "ApexClass" || a.target.kind === "Flow" ? a.target.kind : undefined;
    const targetFile = a.files.find(
      (f) => targetKind && kindOfFile(f) === targetKind && nameOfFile(f) === a.target.name,
    );
    const existing = [...nodes.values()].find((x) => x.kind === targetKind && x.label === a.target.name);
    if (existing) edge(n.id, existing.id, "runs");
    else if (targetFile && targetKind)
      edge(
        n.id,
        node(`f:${targetFile}`, { label: a.target.name!, kind: targetKind, file: abs(targetFile), line: 0 }).id,
        "runs",
      );
    for (const f of a.files) if (!ownedBy.has(f)) ownedBy.set(f, n.id);
  }

  // Findings: the worst one colours each node it names; files not yet in the graph join it.
  const byFile = new Map<string, GraphNode>();
  for (const n of nodes.values()) if (n.file) byFile.set(n.file, n);
  const mark = (n: GraphNode, severity: Severity, title: string) => {
    if (rank(severity) < rank(n.severity)) n.severity = severity;
    if (!n.findings.includes(title)) n.findings.push(title);
  };
  for (const f of result.findings) {
    let marked = false;
    for (const file of f.files) {
      let n = byFile.get(abs(file));
      if (!n) {
        n = node(`f:${file}`, {
          label: nameOfFile(file),
          kind: kindOfFile(file),
          file: abs(file),
          line: file === f.files[0] && f.line ? f.line - 1 : 0,
        });
        byFile.set(abs(file), n);
        edge(f.object ? object(f.object).id : (ownedBy.get(file) ?? center), n.id, "related");
      }
      mark(n, f.severity, f.title);
      marked = true;
    }
    if (!marked && f.object) mark(object(f.object), f.severity, f.title);
    else if (!marked) mark(nodes.get(center)!, f.severity, f.title);
  }

  for (const [id, events] of objectEvents) {
    const n = nodes.get(id)!;
    n.detail = [...events].join(", ");
  }

  // Distance from the change, following edges either way.
  const neighbours = new Map<string, string[]>();
  for (const e of edges.values()) {
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to]);
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from]);
  }
  const queue = [center, ...changeIds.filter((id) => id !== center)];
  nodes.get(center)!.depth = 0;
  if (center === "hub") for (const id of changeIds) nodes.get(id)!.depth = 0;
  while (queue.length) {
    const id = queue.shift()!;
    const d = nodes.get(id)!.depth;
    for (const next of neighbours.get(id) ?? []) {
      const n = nodes.get(next)!;
      if (n.depth > d + 1) {
        n.depth = d + 1;
        queue.push(next);
      }
    }
  }
  // Anything not reached (shouldn't happen) hangs off the change.
  for (const n of nodes.values()) {
    if (Number.isFinite(n.depth)) continue;
    n.depth = 1;
    edge(center, n.id, "related");
  }

  // Keep the graph readable: the nearest nodes, and the riskiest at equal distance.
  let kept = [...nodes.values()].sort(
    (a, b) => a.depth - b.depth || rank(a.severity) - rank(b.severity) || a.label.localeCompare(b.label),
  );
  const omitted = Math.max(0, kept.length - MAX_GRAPH_NODES);
  kept = kept.slice(0, MAX_GRAPH_NODES);
  const keptIds = new Set(kept.map((n) => n.id));
  return {
    center,
    nodes: kept,
    edges: [...edges.values()].filter((e) => keptIds.has(e.from) && keptIds.has(e.to)),
    risk: result.summary.risk,
    ...(result.base ? { base: result.base } : {}),
    omitted,
  };
}
