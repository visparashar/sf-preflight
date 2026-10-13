// SPDX-License-Identifier: Apache-2.0

import { mergeNeeds } from "../agentImpact.js";
import { summarizeFindings } from "../analyze.js";
import { omniLabel } from "../omnistudio.js";
import type {
  AccessNeed,
  AgentUserAccess,
  AnalysisResult,
  AutomationRef,
  CascadeNode,
  Finding,
  OrgAutomation,
  OrgContext,
  OrgModel,
  SaveEvent,
} from "../types.js";
import { key, redactEmails, uniq } from "../util.js";
import { assertSafeOrg, createSfRunner, field, query, SfError, type SfRunner, soqlList, soqlStringList } from "./sf.js";

/**
 * Optional, read-only enrichment from a Salesforce org (`--org`):
 *
 * - record counts for impacted objects (realistic bulk tests),
 * - active flows, triggers and validation rules on impacted objects that exist in the org but
 *   not in the project (the cascade can't see them),
 * - how many active users hold each changed permission set / profile,
 * - installed packages (to label managed automation).
 *
 * Only counts and metadata names are collected — never record data or user names — so the
 * context is safe to include in pull-request comments. When `--org` is a username, reports use
 * the org's alias instead (or a neutral label), and error messages have email addresses removed.
 */
export interface OrgEnrichOptions {
  org: string;
  runner?: SfRunner;
  /** Cap on objects queried (default 100). */
  maxObjects?: number;
}

const RECORD_TRIGGER_EVENTS: Record<string, string[]> = {
  Create: ["insert"],
  Update: ["update"],
  CreateAndUpdate: ["insert", "update"],
  Delete: ["delete"],
};
const FLOW_TIMING: Record<string, string> = {
  RecordBeforeSave: "before",
  RecordAfterSave: "after",
  RecordBeforeDelete: "before",
};
const TRIGGER_USAGE: [string, string][] = [
  ["UsageBeforeInsert", "before insert"],
  ["UsageAfterInsert", "after insert"],
  ["UsageBeforeUpdate", "before update"],
  ["UsageAfterUpdate", "after update"],
  ["UsageBeforeDelete", "before delete"],
  ["UsageAfterDelete", "after delete"],
  ["UsageAfterUndelete", "after undelete"],
];
/** Source file names of standard profiles → their names in the org. */
const STANDARD_PROFILES: Record<string, string> = {
  admin: "System Administrator",
  standard: "Standard User",
  readonly: "Read Only",
  solutionmanager: "Solution Manager",
  marketingprofile: "Marketing User",
  contractmanager: "Contract Manager",
  standardaul: "Standard Platform User",
};

/** Report label for an org whose only identifier is a username and that has no alias. */
export const GENERIC_ORG_LABEL = "target org";

/**
 * How the org is named in reports. Usernames identify a person (and usually their company), so
 * they never reach a report: use the org's alias, or a neutral label when it has none.
 */
export function orgLabel(input: string, alias?: unknown): string {
  if (!input.includes("@")) return input;
  const a = typeof alias === "string" ? alias : "";
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(a) ? a : GENERIC_ORG_LABEL;
}

/** "dev" → "dev"; the generic label reads as "the target org" inside sentences. */
export const orgRef = (label: string) => (label === GENERIC_ORG_LABEL ? `the ${label}` : label);

const redact = redactEmails;

/**
 * Object → events this change reaches in its cascade, with the automation (or the change
 * itself) that reaches each one. Empty when the result has no cascade.
 */
export function reachedEvents(result: Pick<AnalysisResult, "cascade">): Map<string, Map<SaveEvent, AutomationRef[]>> {
  const reached = new Map<string, Map<SaveEvent, AutomationRef[]>>();
  const walk = (n: CascadeNode) => {
    const events = reached.get(key(n.object)) ?? new Map<SaveEvent, AutomationRef[]>();
    reached.set(key(n.object), events);
    const vias = events.get(n.event) ?? [];
    if (n.via && !vias.some((v) => v.kind === n.via!.kind && v.name === n.via!.name)) vias.push(n.via);
    events.set(n.event, vias);
    for (const c of n.children) walk(c);
  };
  for (const root of result.cascade ?? []) walk(root);
  return reached;
}

/** Does org automation fire for this DML event? Validation rules run on insert and update. */
function firesOn(a: OrgAutomation, event: SaveEvent): boolean {
  if (a.kind === "ValidationRule") return event === "insert" || event === "update";
  if (!a.when.length) return true; // unknown: keep it
  return a.when.some((w) => w.split(" ")[1] === event);
}

const isId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9]{15,18}$/.test(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function collectOrgContext(model: OrgModel, result: AnalysisResult, opts: OrgEnrichOptions): OrgContext {
  const org = assertSafeOrg(opts.org);
  const run = opts.runner ?? createSfRunner();

  // Fail fast when the org isn't reachable: the user explicitly asked for org context.
  // Only the alias is kept from the display result.
  let alias: unknown;
  try {
    alias = (run(["org", "display", "--target-org", org]) as { alias?: unknown } | undefined)?.alias;
  } catch (err) {
    throw new SfError(`Could not use org "${org}": ${(err as Error).message}`);
  }

  const ctx: OrgContext = {
    org: orgLabel(org, alias),
    queriedAt: new Date().toISOString(),
    recordCounts: {},
    assignments: [],
    orgOnlyAutomation: [],
    packages: [],
    errors: [],
  };
  const attempt = (label: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      ctx.errors.push(`${label}: ${redact((err as Error).message)}`);
    }
  };

  const objects = uniq([
    ...result.impactedObjects,
    ...result.changes.map((c) => c.component.object).filter((o): o is string => !!o),
  ])
    .filter((o) => /^[A-Za-z][A-Za-z0-9_]*$/.test(o))
    .slice(0, opts.maxObjects ?? 100);

  // Object ids/labels, to match automation that references custom objects by id.
  const objectByRef = new Map<string, string>();
  if (objects.length) {
    attempt("objects", () => {
      for (const o of objects) objectByRef.set(key(o), o);
      const rows = query(
        run,
        org,
        `SELECT QualifiedApiName, DurableId, Label FROM EntityDefinition WHERE QualifiedApiName IN (${soqlList(objects)})`,
      );
      for (const r of rows) {
        const name = str(r.QualifiedApiName);
        if (!name) continue;
        for (const ref of [r.DurableId, r.Label]) if (str(ref)) objectByRef.set(key(ref as string), name);
      }
    });
    attempt("record counts", () => {
      const rows = run([
        "org",
        "list",
        "sobject",
        "record-counts",
        "--target-org",
        org,
        ...objects.flatMap((o) => ["--sobject", o]),
      ]) as { name?: string; count?: number }[] | undefined;
      for (const r of rows ?? []) if (r.name && typeof r.count === "number") ctx.recordCounts[r.name] = r.count;
    });
  }

  const packageByNamespace = new Map<string, string>();
  attempt("installed packages", () => {
    const rows = query(
      run,
      org,
      "SELECT SubscriberPackage.NamespacePrefix, SubscriberPackage.Name, SubscriberPackageVersion.MajorVersion, SubscriberPackageVersion.MinorVersion, SubscriberPackageVersion.PatchVersion FROM InstalledSubscriberPackage",
      true,
    );
    for (const r of rows) {
      const name = str(field(r, "SubscriberPackage.Name")) ?? "unknown package";
      const namespace = str(field(r, "SubscriberPackage.NamespacePrefix"));
      const version = ["MajorVersion", "MinorVersion", "PatchVersion"]
        .map((f) => field(r, `SubscriberPackageVersion.${f}`))
        .filter((v) => v !== undefined && v !== null)
        .join(".");
      ctx.packages.push({ namespace, name, version });
      if (namespace) packageByNamespace.set(key(namespace), name);
    }
  });

  const objectOf = (...refs: unknown[]): string | undefined => {
    for (const r of refs) {
      const hit = str(r) && objectByRef.get(key(r as string));
      if (hit) return hit;
    }
    return undefined;
  };
  const owner = (ns: unknown) => {
    const namespace = str(ns);
    return { namespace, packageName: namespace ? packageByNamespace.get(key(namespace)) : undefined };
  };

  if (objects.length) {
    attempt("flows", () => {
      const rows = query(
        run,
        org,
        "SELECT ApiName, TriggerType, RecordTriggerType, TriggerObjectOrEventId, TriggerObjectOrEventLabel, NamespacePrefix FROM FlowDefinitionView WHERE IsActive = true",
      );
      for (const r of rows) {
        const timing = FLOW_TIMING[str(r.TriggerType) ?? ""];
        const name = str(r.ApiName);
        if (!timing || !name) continue;
        const object = objectOf(r.TriggerObjectOrEventId, r.TriggerObjectOrEventLabel);
        if (!object || model.flows.has(key(name))) continue;
        const events =
          str(r.TriggerType) === "RecordBeforeDelete"
            ? ["delete"]
            : (RECORD_TRIGGER_EVENTS[str(r.RecordTriggerType) ?? ""] ?? []);
        ctx.orgOnlyAutomation.push({
          kind: "Flow",
          name,
          object,
          when: events.map((e) => `${timing} ${e}`),
          ...owner(r.NamespacePrefix),
        });
      }
    });
    attempt("triggers", () => {
      const rows = query(
        run,
        org,
        `SELECT Name, TableEnumOrId, NamespacePrefix, ${TRIGGER_USAGE.map(([f]) => f).join(", ")} FROM ApexTrigger WHERE Status = 'Active'`,
      );
      for (const r of rows) {
        const name = str(r.Name);
        const object = objectOf(r.TableEnumOrId);
        if (!name || !object || model.triggers.has(key(name))) continue;
        ctx.orgOnlyAutomation.push({
          kind: "ApexTrigger",
          name,
          object,
          when: TRIGGER_USAGE.filter(([f]) => r[f] === true).map(([, label]) => label),
          ...owner(r.NamespacePrefix),
        });
      }
    });
    attempt("validation rules", () => {
      const rows = query(
        run,
        org,
        "SELECT ValidationName, EntityDefinitionId, NamespacePrefix FROM ValidationRule WHERE Active = true",
        true,
      );
      const inProject = new Set(model.validationRules.map((v) => key(v.fullName)));
      for (const r of rows) {
        const name = str(r.ValidationName);
        const object = objectOf(r.EntityDefinitionId);
        if (!name || !object || inProject.has(key(`${object}.${name}`))) continue;
        ctx.orgOnlyAutomation.push({
          kind: "ValidationRule",
          name,
          object,
          when: ["validation"],
          ...owner(r.NamespacePrefix),
        });
      }
    });
  }

  // Who holds the changed permission sets / profiles (direct assignments, active users only).
  const changedPerms = result.changes.filter(
    (c) => (c.component.type === "PermissionSet" || c.component.type === "Profile") && c.changeType !== "deleted",
  );
  const permSets = changedPerms.filter((c) => c.component.type === "PermissionSet").map((c) => c.component.name);
  const profiles = changedPerms
    .filter((c) => c.component.type === "Profile")
    .map((c) => {
      const decoded = safeDecode(c.component.name);
      return { file: c.component.name, orgName: STANDARD_PROFILES[key(decoded)] ?? decoded };
    });
  if (permSets.length) {
    attempt("permission set assignments", () => {
      const sets = query(
        run,
        org,
        `SELECT Id, Name FROM PermissionSet WHERE IsOwnedByProfile = false AND Name IN (${soqlList(permSets)})`,
      );
      const ids = sets.map((s) => s.Id).filter(isId);
      const counts = new Map<string, number>();
      if (ids.length) {
        const rows = query(
          run,
          org,
          `SELECT PermissionSetId, COUNT(Id) n FROM PermissionSetAssignment WHERE Assignee.IsActive = true AND PermissionSetId IN (${ids.map((i) => `'${i}'`).join(", ")}) GROUP BY PermissionSetId`,
        );
        for (const r of rows) if (isId(r.PermissionSetId)) counts.set(r.PermissionSetId, Number(r.n ?? 0));
      }
      for (const name of permSets) {
        const set = sets.find((s) => key(String(s.Name)) === key(name));
        if (set) ctx.assignments.push({ kind: "PermissionSet", name, activeUsers: counts.get(String(set.Id)) ?? 0 });
      }
    });
  }
  if (profiles.length) {
    attempt("profile assignments", () => {
      const rows = query(
        run,
        org,
        `SELECT Id, Name FROM Profile WHERE Name IN (${soqlStringList(profiles.map((p) => p.orgName))})`,
      );
      const ids = rows.map((r) => r.Id).filter(isId);
      const counts = new Map<string, number>();
      if (ids.length) {
        const users = query(
          run,
          org,
          `SELECT ProfileId, COUNT(Id) n FROM User WHERE IsActive = true AND ProfileId IN (${ids.map((i) => `'${i}'`).join(", ")}) GROUP BY ProfileId`,
        );
        for (const u of users) if (isId(u.ProfileId)) counts.set(u.ProfileId, Number(u.n ?? 0));
      }
      for (const p of profiles) {
        const row = rows.find((r) => key(String(r.Name)) === key(p.orgName));
        if (row) ctx.assignments.push({ kind: "Profile", name: p.file, activeUsers: counts.get(String(row.Id)) ?? 0 });
      }
    });
  }

  // Runtime users of affected agents: do they have the access their actions need, and no more?
  for (const agentName of uniq((result.agents ?? []).map((a) => a.agent))) {
    const agent = model.agents.get(key(agentName));
    if (!agent?.runtimeUser) continue;
    const label = agent.label ?? agent.name;
    attempt(`runtime user of agent ${label}`, () => {
      const impacts = (result.agents ?? []).filter((a) => a.agent === agentName);
      const access = checkAgentUser(
        run,
        org,
        agent.runtimeUser!,
        mergeNeeds(impacts.flatMap((a) => a.needs)),
        uniq(impacts.map((a) => a.apexClass).filter((c): c is string => !!c)),
      );
      ctx.agentUsers = [...(ctx.agentUsers ?? []), { agent: agent.name, agentLabel: agent.label, ...access }];
    });
  }

  // Keep only automation that fires for an event this change actually reaches.
  const reached = reachedEvents(result);
  ctx.orgOnlyAutomation = ctx.orgOnlyAutomation.filter((a) => {
    const events = reached.get(key(a.object));
    return !events || [...events.keys()].some((e) => firesOn(a, e));
  });

  return ctx;
}

const USERNAME = /^[A-Za-z0-9._%+'-]{1,80}@[A-Za-z0-9.-]{1,180}$/;
const sfId = (v: unknown, prefix: string) =>
  typeof v === "string" && new RegExp(`^${prefix}[A-Za-z0-9]{12,15}$`).test(v) ? v : undefined;

/** Effective object access and broad permissions of one user, from their permission set assignments. */
export function checkAgentUser(
  run: SfRunner,
  org: string,
  username: string,
  needs: AccessNeed[],
  apexClasses: string[] = [],
): Omit<AgentUserAccess, "agent" | "agentLabel"> {
  try {
    return checkAgentUserUnsafe(run, org, username, needs, apexClasses);
  } catch (err) {
    // sf errors can echo the command, which contains the username: never let it through.
    const escaped = username.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const message = redactEmails(
      String((err as Error).message ?? err)
        .split(escaped)
        .join("<runtime user>")
        .split(username)
        .join("<runtime user>"),
    );
    throw new SfError(message.includes("@") ? "query failed" : message);
  }
}

function checkAgentUserUnsafe(
  run: SfRunner,
  org: string,
  username: string,
  needs: AccessNeed[],
  apexClasses: string[],
): Omit<AgentUserAccess, "agent" | "agentLabel"> {
  if (!USERNAME.test(username)) throw new SfError("the runtime user's username has an unexpected format");
  const quoted = `'${username.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const [user] = query(run, org, `SELECT Id, IsActive FROM User WHERE Username = ${quoted} LIMIT 1`);
  const userId = sfId(user?.Id, "005");
  if (!user || !userId) return { status: "not found", missing: [], broad: [] };
  if (user.IsActive !== true) return { status: "inactive", missing: [], broad: [] };

  const assignments = query(
    run,
    org,
    `SELECT PermissionSetId, PermissionSet.PermissionsModifyAllData, PermissionSet.PermissionsViewAllData, PermissionSet.PermissionsAuthorApex FROM PermissionSetAssignment WHERE AssigneeId = '${userId}'`,
  );
  const broad: string[] = [];
  const modifyAllData = assignments.some((a) => field(a, "PermissionSet.PermissionsModifyAllData") === true);
  if (modifyAllData) broad.push("Modify All Data");
  const viewAllData = assignments.some((a) => field(a, "PermissionSet.PermissionsViewAllData") === true);
  if (viewAllData) broad.push("View All Data");

  const ids = uniq(assignments.map((a) => sfId(a.PermissionSetId, "0PS")).filter((i): i is string => !!i));
  const objects = needs.map((n) => n.object).filter((o) => /^[A-Za-z][A-Za-z0-9_]*$/.test(o));
  const effective = new Map<string, Record<string, boolean>>();
  if (ids.length && objects.length) {
    const rows = query(
      run,
      org,
      `SELECT SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsModifyAllRecords FROM ObjectPermissions WHERE ParentId IN (${ids.map((i) => `'${i}'`).join(", ")}) AND SobjectType IN (${soqlList(objects)})`,
    );
    for (const r of rows) {
      const o = key(String(r.SobjectType ?? ""));
      const cur = effective.get(o) ?? {};
      for (const p of ["Read", "Create", "Edit", "Delete", "ModifyAllRecords"]) {
        cur[p] = cur[p] || r[`Permissions${p}`] === true;
      }
      effective.set(o, cur);
    }
  }
  const missing: AccessNeed[] = [];
  for (const n of needs) {
    if (modifyAllData) break;
    const e = effective.get(key(n.object)) ?? {};
    const canRead = !!e.Read || viewAllData;
    const column = { read: "Read", create: "Create", edit: "Edit", delete: "Delete" } as const;
    const lacking = n.access.filter((a) => a !== "read" && !e[column[a]]);
    if (!canRead || lacking.length) {
      missing.push({ object: n.object, access: canRead ? lacking : ["read", ...lacking] });
    }
  }
  for (const n of needs) {
    if (!modifyAllData && effective.get(key(n.object))?.ModifyAllRecords) broad.push(`Modify All on ${n.object}`);
  }
  // Apex class access (Author Apex grants all classes).
  const missingClasses: string[] = [];
  const classes = apexClasses.filter((c) => /^[A-Za-z][A-Za-z0-9_]*$/.test(c));
  const authorApex = assignments.some((a) => field(a, "PermissionSet.PermissionsAuthorApex") === true);
  if (classes.length && !authorApex) {
    const rows = query(
      run,
      org,
      `SELECT Id, Name FROM ApexClass WHERE NamespacePrefix = null AND Name IN (${soqlList(classes)})`,
    );
    const idByName = new Map(rows.map((r) => [key(String(r.Name)), sfId(r.Id, "01p")]));
    const classIds = [...idByName.values()].filter((i): i is string => !!i);
    const granted = new Set<string>();
    if (ids.length && classIds.length) {
      const grants = query(
        run,
        org,
        `SELECT SetupEntityId FROM SetupEntityAccess WHERE SetupEntityType = 'ApexClass' AND ParentId IN (${ids.map((i) => `'${i}'`).join(", ")}) AND SetupEntityId IN (${classIds.map((i) => `'${i}'`).join(", ")})`,
      );
      for (const r of grants) if (typeof r.SetupEntityId === "string") granted.add(r.SetupEntityId);
    }
    for (const c of classes) {
      const id = idByName.get(key(c));
      if (id && !granted.has(id)) missingClasses.push(c);
    }
  }
  return { status: "checked", missing, missingClasses, broad };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const describe = (a: OrgAutomation) => {
  const kind = a.kind === "ApexTrigger" ? "trigger" : a.kind === "Flow" ? "flow" : "validation rule";
  const when = a.kind === "ValidationRule" ? "" : a.when.length ? ` (${a.when.join(", ")})` : "";
  const pkg = a.packageName ? ` [${a.packageName}]` : a.namespace ? ` [${a.namespace}]` : "";
  return `${kind} ${a.namespace ? `${a.namespace}__` : ""}${a.name}${when}${pkg}`;
};

const viaLabel = (v: AutomationRef) => {
  switch (v.kind) {
    case "Change":
      return `the change to ${v.name}`;
    case "Flow":
      return `flow ${v.name}`;
    case "ApexTrigger":
      return `trigger ${v.name}`;
    case "ApexClass":
      return `class ${v.name}`;
    case "RollUpSummary":
      return `roll-up ${v.name}`;
    case "OmniScript":
    case "IntegrationProcedure":
    case "DataMapper":
    case "FlexCard":
      return `${omniLabel(v.kind)} ${v.name}`;
    default:
      return v.name;
  }
};

/** "This change reaches Contact (update) via flow X, so these run too." */
function reachSentence(object: string, events: Map<SaveEvent, AutomationRef[]> | undefined, list: OrgAutomation[]) {
  if (!events) return "";
  const parts = [...events]
    .filter(([event]) => list.some((a) => firesOn(a, event)))
    .map(([event, vias]) => `${object} (${event}) via ${uniq(vias.map(viaLabel)).join(", ")}`);
  return parts.length ? `This change reaches ${parts.join("; ")}, so these run too.` : "";
}

const metadataSpec = (a: OrgAutomation) =>
  a.kind === "ValidationRule" ? `ValidationRule:${a.object}.${a.name}` : `${a.kind}:${a.name}`;

/** Add org findings and annotations to an analysis result (mutates and returns it). */
export function applyOrgContext(result: AnalysisResult, ctx: OrgContext): AnalysisResult {
  const findings: Finding[] = [...result.findings];

  const byObject = new Map<string, OrgAutomation[]>();
  for (const a of ctx.orgOnlyAutomation) {
    const list = byObject.get(a.object) ?? [];
    list.push(a);
    byObject.set(a.object, list);
  }
  const reached = reachedEvents(result);
  const where = orgRef(ctx.org);
  for (const [object, list] of byObject) {
    const managed = list.filter((a) => a.namespace);
    const unmanaged = list.filter((a) => !a.namespace);
    const detail = [
      `${list.map(describe).join("; ")}.`,
      reachSentence(object, reached.get(key(object)), list),
      "Their own effects are not in the cascade above.",
      unmanaged.length
        ? `Retrieve them so preflight can analyze them: \`sf project retrieve start ${unmanaged
            .map((a) => `--metadata ${metadataSpec(a)}`)
            .join(" ")}\`.`
        : "",
      managed.length
        ? "Managed-package automation can't be retrieved as source but still runs: keep it enabled in tests."
        : "",
    ];
    findings.push({
      rule: "org-only-automation",
      severity: unmanaged.length ? "medium" : "low",
      title: `${list.length} automation(s) on ${object} run in ${where} but aren't in this project`,
      detail: detail.filter(Boolean).join(" "),
      object,
      files: [],
    });
  }

  for (const a of ctx.assignments) {
    for (const f of findings) {
      if (!f.rule.startsWith("permission-")) continue;
      const matches = f.title.includes(`${a.kind === "Profile" ? "Profile" : "Permission set"} ${a.name} `);
      if (!matches) continue;
      f.detail += ` In ${where} it is assigned to ${a.activeUsers.toLocaleString("en-US")} active user(s).`;
    }
  }

  for (const u of ctx.agentUsers ?? []) {
    const who = `${u.agentLabel ?? u.agent}'s runtime user`;
    const actions = (result.agents ?? []).filter((a) => a.agent === u.agent);
    const files = uniq(actions.flatMap((a) => a.files));
    if (u.status !== "checked") {
      findings.push({
        rule: "agent-runtime-access",
        severity: u.status === "inactive" ? "high" : "medium",
        title: `${who} is ${u.status === "inactive" ? "inactive" : "not found"} in ${where}`,
        detail:
          u.status === "inactive"
            ? "The agent can't run any action until its user is active."
            : "The agent definition names a user that doesn't exist in this org. In a sandbox, usernames get the sandbox name as a suffix: update the agent's user there.",
        files,
      });
      continue;
    }
    const missingClasses = u.missingClasses ?? [];
    if (u.missing.length || missingClasses.length) {
      const users = (n: AccessNeed) =>
        actions
          .filter((a) => a.needs.some((x) => key(x.object) === key(n.object)))
          .map((a) => a.actionLabel ?? a.action);
      const byClass = (c: string) =>
        actions.filter((a) => a.apexClass && key(a.apexClass) === key(c)).map((a) => a.actionLabel ?? a.action);
      const parts = [
        ...missingClasses.map((c) => `access to Apex class ${c} (needed by ${uniq(byClass(c)).join(", ")})`),
        ...u.missing.map(
          (n) =>
            `${n.access.length ? n.access.join("/") : "read"} on ${n.object} (needed by ${uniq(users(n)).join(", ")})`,
        ),
      ];
      findings.push({
        rule: "agent-runtime-access",
        severity: "high",
        title: `${who} lacks access the affected actions need in ${where}`,
        detail: `Missing: ${parts.join("; ")}. The actions fail when the agent runs them. Grant the access in a permission set assigned to the agent's user.`,
        files,
      });
    }
    if (u.broad.length) {
      findings.push({
        rule: "agent-runtime-overprivileged",
        severity: "medium",
        title: `${who} has broad access in ${where}: ${u.broad.join(", ")}`,
        detail:
          "An agent acts on whatever a conversation leads it to; its user should hold only the access its actions need. Replace broad permissions with object access scoped to the actions.",
        files,
      });
    }
  }

  for (const t of result.suggestedTests) {
    if (t.kind !== "bulk" || !t.object) continue;
    const count = ctx.recordCounts[t.object];
    if (count === undefined) continue;
    const n = `${where} has ${count.toLocaleString("en-US")} ${t.object} record${count === 1 ? "" : "s"}`;
    t.description = t.description.replace(
      "(and at your expected production volume)",
      count < 200
        ? `(${n}; 200 is still the minimum bulk size to test)`
        : `(${n} — test at a realistic share of that volume)`,
    );
  }

  const summary = summarizeFindings(findings);
  result.findings = summary.findings;
  result.summary.findingsBySeverity = summary.findingsBySeverity;
  result.summary.risk = summary.risk;
  result.org = ctx;
  return result;
}

export function enrichWithOrg(model: OrgModel, result: AnalysisResult, opts: OrgEnrichOptions): AnalysisResult {
  return applyOrgContext(result, collectOrgContext(model, result, opts));
}
