// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import path from "node:path";
import { readProjectFile } from "./files.js";
import { parsePermissionContainer } from "./parsers/permissions.js";
import { filesNaming } from "./references.js";
import type { Finding, ObjectGrant, OrgModel, PermissionContainerDef } from "./types.js";
import { pagesUsingClass } from "./usage.js";
import { key, nodes, parseMetadataXml, text, uniq } from "./util.js";

/**
 * Access changes beyond "what a permission set newly grants": access taken away, guest user
 * access, organization-wide defaults, sharing rules, permission set groups and muting
 * permission sets. Most compare the file with its version at the base ref.
 */

const MAX_LISTED = 8;
const list = (xs: string[]) =>
  `${xs.slice(0, MAX_LISTED).join(", ")}${xs.length > MAX_LISTED ? ` and ${xs.length - MAX_LISTED} more` : ""}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const containerLabel = (c: { kind: string; name: string }) =>
  `${c.kind === "Profile" ? "Profile" : c.kind === "MutingPermissionSet" ? "Muting permission set" : "Permission set"} ${c.name}`;

// ---- Access taken away ------------------------------------------------------------------

const OBJECT_FLAGS: [keyof ObjectGrant, string][] = [
  ["read", "read"],
  ["create", "create"],
  ["edit", "edit"],
  ["delete", "delete"],
];

/** What `previous` allowed that `current` no longer does. */
export function accessLost(current: PermissionContainerDef, previous: PermissionContainerDef) {
  const curObj = new Map(current.objects.map((o) => [key(o.object), o]));
  const objects: string[] = [];
  for (const p of previous.objects) {
    const c = curObj.get(key(p.object));
    const lost = OBJECT_FLAGS.filter(([f]) => p[f] && !c?.[f]).map(([, l]) => l);
    if (lost.length) objects.push(`${p.object} (${lost.join(", ")})`);
  }
  const curFields = new Map(current.fields.map((f) => [key(f.field), f]));
  const fields: string[] = [];
  for (const p of previous.fields) {
    const c = curFields.get(key(p.field));
    if (p.readable && !c?.readable) fields.push(p.field);
    else if (p.editable && !c?.editable) fields.push(`${p.field} (edit)`);
  }
  const gone = (before: string[] = [], now: string[] = []) => {
    const keep = new Set(now.map(key));
    return before.filter((x) => !keep.has(key(x)));
  };
  return {
    objects,
    fields,
    classes: gone(previous.classes, current.classes),
    pages: gone(previous.pages, current.pages),
    customPermissions: gone(previous.customPermissions, current.customPermissions),
    userPermissions: gone(previous.userPermissions, current.userPermissions),
  };
}

/** Lightning components and pages that need what was taken away. */
function usersOf(model: OrgModel, lost: ReturnType<typeof accessLost>): string[] {
  const users: string[] = [];
  const classes = new Set(lost.classes.map(key));
  const fields = new Set(lost.fields.map((f) => key(f.replace(/ \(edit\)$/, ""))));
  for (const lc of model.lightning.values()) {
    if (lc.apex.some((a) => classes.has(key(a.cls))) || lc.fields.some((f) => fields.has(key(f))))
      users.push(`${lc.kind === "aura" ? "Aura" : "LWC"} ${lc.name}`);
  }
  for (const cls of lost.classes) for (const p of pagesUsingClass(model, cls)) users.push(`page ${p.name}`);
  for (const cp of lost.customPermissions) {
    const files = filesNaming(model, {
      type: "Metadata",
      metadataType: "CustomPermission",
      name: cp,
      file: `customPermissions/${cp}.customPermission-meta.xml`,
    }).filter((f) => !/\.(permissionset|profile|permissionsetgroup)-meta\.xml$/.test(f));
    users.push(...files.map((f) => path.posix.basename(f)));
  }
  return uniq(users);
}

/** A permission set, profile or muting permission set that takes access away. */
export function accessRemovedFindings(
  model: OrgModel,
  current: PermissionContainerDef & { kind: string },
  previous: PermissionContainerDef | undefined,
  verb = "no longer grants",
): Finding[] {
  if (!previous) return [];
  const lost = accessLost(current, previous);
  const parts: [string[], string, string][] = [
    [lost.objects, "object permission", "Objects"],
    [lost.fields, "field", "Fields"],
    [lost.classes, "Apex class", "Apex classes"],
    [lost.pages, "Visualforce page", "Visualforce pages"],
    [lost.customPermissions, "custom permission", "Custom permissions"],
    [lost.userPermissions, "system permission", "System permissions"],
  ];
  const present = parts.filter(([xs]) => xs.length);
  if (!present.length) return [];
  const users = usersOf(model, lost);
  return [
    {
      rule: "permission-access-removed",
      severity: "medium",
      title: `${containerLabel(current)} ${verb} ${present.map(([xs, one]) => plural(xs.length, one)).join(", ")}`,
      detail: `${present.map(([xs, , head]) => `${head}: ${list(xs)}.`).join(" ")} Users who got this access only from here lose it${users.length ? `; ${list(users)} use it and may fail or show blank values for them` : ""}. Check who holds it before deploying.`,
      files: [current.file],
    },
  ];
}

// ---- Guest users ------------------------------------------------------------------------

const isGuest = (c: PermissionContainerDef) => /guest/i.test(c.userLicense ?? "");

/** A guest user profile (unauthenticated site visitors) that gains access. */
export function guestFindings(
  current: PermissionContainerDef,
  previous: PermissionContainerDef | undefined,
): Finding[] {
  if (!isGuest(current)) return [];
  const prev = new Map((previous?.objects ?? []).map((o) => [key(o.object), o]));
  const gained: string[] = [];
  for (const o of current.objects) {
    const p = prev.get(key(o.object));
    const flags = OBJECT_FLAGS.filter(([f]) => o[f] && !p?.[f]).map(([, l]) => l);
    if (flags.length) gained.push(`${o.object} (${flags.join(", ")})`);
  }
  const prevClasses = new Set((previous?.classes ?? []).map(key));
  const classes = (current.classes ?? []).filter((c) => !prevClasses.has(key(c)));
  if (!gained.length && !classes.length) return [];
  return [
    {
      rule: "guest-access",
      severity: "high",
      title: `Guest profile ${current.name} ${previous ? "newly grants" : "grants"} access to ${[gained.length ? plural(gained.length, "object") : "", classes.length ? plural(classes.length, "Apex class", "Apex classes") : ""].filter(Boolean).join(" and ")}`,
      detail: `${[gained.length ? `Objects: ${list(gained)}.` : "", classes.length ? `Apex classes: ${list(classes)}.` : ""].filter(Boolean).join(" ")} Anyone on the internet who reaches the site has this access, without logging in. Grant guests only what the public pages need, and check the sharing rules that expose records to them.`,
      files: [current.file],
    },
  ];
}

// ---- Organization-wide defaults ---------------------------------------------------------

const OWD_RANK: Record<string, number> = {
  private: 0,
  read: 1,
  readselect: 1,
  readwrite: 2,
  readwritetransfer: 3,
  fullaccess: 4,
};
const OWD_WORDS: Record<string, string> = {
  private: "Private",
  read: "Public Read Only",
  readselect: "Public Read Only",
  readwrite: "Public Read/Write",
  readwritetransfer: "Public Read/Write/Transfer",
  fullaccess: "Public Full Access",
};
const owdWords = (v: string) =>
  OWD_WORDS[key(v)] ??
  (v.startsWith("ControlledBy") ? `controlled by ${v.slice("ControlledBy".length).toLowerCase()}` : v);

/** `sharingModel` and `externalSharingModel` of an object file. */
export function parseSharingModel(xml: string | undefined): { internal?: string; external?: string } {
  if (!xml) return {};
  try {
    const { body } = parseMetadataXml(xml);
    return { internal: text(body.sharingModel), external: text(body.externalSharingModel) };
  } catch {
    return {};
  }
}

/** A changed organization-wide default. */
export function sharingModelFindings(
  object: string,
  file: string,
  current: { internal?: string; external?: string },
  previous: { internal?: string; external?: string },
): Finding[] {
  const out: Finding[] = [];
  for (const [which, who] of [
    ["internal", "internal users"],
    ["external", "external (Experience Cloud) users"],
  ] as const) {
    const before = previous[which];
    const after = current[which];
    if (!before || !after || key(before) === key(after)) continue;
    const rb = OWD_RANK[key(before)];
    const ra = OWD_RANK[key(after)];
    const change = `${object} default access for ${who}: ${owdWords(before)} → ${owdWords(after)}`;
    if (rb !== undefined && ra !== undefined && ra > rb) {
      out.push({
        rule: "sharing-model-opened",
        severity: "high",
        title: `Sharing opened up: ${change}`,
        detail: `Every ${who.replace(/s( \(|$)/, "$1")} can now ${ra >= 2 ? "edit" : "see"} ${object} records they don't own. Check that no record holds data some users must not ${ra >= 2 ? "change" : "see"}. Large orgs recalculate sharing when this deploys.`,
        object,
        files: [file],
      });
    } else {
      out.push({
        rule: "sharing-model-restricted",
        severity: "medium",
        title: `Sharing changed: ${change}`,
        detail: `Users can lose access to ${object} records they don't own. Automation that runs with the user's sharing (screen flows, \`with sharing\` Apex, Lightning components) may stop finding records, and reports shrink. Add sharing rules for who still needs access. Large orgs recalculate sharing when this deploys.`,
        object,
        files: [file],
      });
    }
  }
  return out;
}

// ---- Sharing rules ----------------------------------------------------------------------

export interface SharingRuleDef {
  kind: "criteria" | "owner" | "guest" | "territory";
  name: string;
  accessLevel: string;
  /** e.g. { type: "group", name: "Sales" } or { type: "allInternalUsers" }. */
  sharedTo: { type: string; name?: string };
  /** Criteria and source, to notice a rule that now shares different records. */
  scope: string;
}

const KINDS: [string, SharingRuleDef["kind"]][] = [
  ["sharingCriteriaRules", "criteria"],
  ["sharingOwnerRules", "owner"],
  ["sharingGuestRules", "guest"],
  ["sharingTerritoryRules", "territory"],
];

export function parseSharingRules(xml: string | undefined): SharingRuleDef[] {
  if (!xml) return [];
  let body: Record<string, unknown>;
  try {
    body = parseMetadataXml(xml).body;
  } catch {
    return [];
  }
  const out: SharingRuleDef[] = [];
  for (const [el, kind] of KINDS) {
    for (const r of nodes(body[el])) {
      const name = text(r.fullName);
      if (!name) continue;
      const to = (r.sharedTo && typeof r.sharedTo === "object" ? r.sharedTo : {}) as Record<string, unknown>;
      const type = Object.keys(to)[0] ?? "unknown";
      out.push({
        kind,
        name,
        accessLevel: text(r.accessLevel) ?? "Read",
        sharedTo: { type, name: text(to[type]) || undefined },
        scope: JSON.stringify([r.criteriaItems ?? null, r.booleanFilter ?? null, r.sharedFrom ?? null]),
      });
    }
  }
  return out;
}

const ACCESS_RANK: Record<string, number> = { read: 1, edit: 2, all: 3 };
const BROAD = new Set(["allinternalusers", "allpartnerusers", "allcustomerportalusers"]);
const AUDIENCE: Record<string, string> = {
  allinternalusers: "all internal users",
  allpartnerusers: "all partner users",
  allcustomerportalusers: "all customer portal users",
  guestuser: "guest (unauthenticated) users",
};
const audience = (r: SharingRuleDef) =>
  AUDIENCE[key(r.sharedTo.type)] ??
  `${r.sharedTo.type.replace(/([A-Z])/g, " $1").toLowerCase()} ${r.sharedTo.name ?? ""}`.trim();
const guestRule = (r: SharingRuleDef) => r.kind === "guest" || key(r.sharedTo.type) === "guestuser";

/** Sharing rules of one object, compared with the base version. */
export function sharingRuleFindings(
  object: string,
  file: string,
  current: SharingRuleDef[],
  previous: SharingRuleDef[] | undefined,
): Finding[] {
  const out: Finding[] = [];
  const before = new Map((previous ?? []).map((r) => [key(r.name), r]));
  const now = new Map(current.map((r) => [key(r.name), r]));
  const rank = (r: SharingRuleDef) => ACCESS_RANK[key(r.accessLevel)] ?? 1;
  const edit = (r: SharingRuleDef) => rank(r) >= 2;

  for (const r of current) {
    const p = before.get(key(r.name));
    const widened =
      !p || rank(r) > rank(p) || key(p.sharedTo.type) !== key(r.sharedTo.type) || p.sharedTo.name !== r.sharedTo.name;
    if (!widened) {
      if (p && p.scope !== r.scope)
        out.push({
          rule: "sharing-rule-changed",
          severity: "low",
          title: `Sharing rule ${object}.${r.name} now shares a different set of records`,
          detail: `Its criteria or source changed; it still gives ${audience(r)} ${r.accessLevel} access. Check which records are now in or out.`,
          object,
          files: [file],
        });
      continue;
    }
    const what = `${p ? "now gives" : "gives"} ${audience(r)} ${r.accessLevel} access to ${object} records`;
    if (guestRule(r)) {
      out.push({
        rule: "guest-access",
        severity: "high",
        title: `Guest sharing rule ${object}.${r.name} ${what}`,
        detail:
          "Unauthenticated site visitors can see these records without logging in. Share only records meant to be public.",
        object,
        files: [file],
      });
      continue;
    }
    const broad = BROAD.has(key(r.sharedTo.type));
    out.push({
      rule: "sharing-rule-changed",
      severity: broad && edit(r) ? "high" : broad || edit(r) ? "medium" : "low",
      title: `Sharing rule ${object}.${r.name} ${what}`,
      detail: `${broad ? "Everyone in that audience" : "Every member"} can ${edit(r) ? "edit" : "see"} the records the rule matches, whatever the default access is. Confirm the audience and access level are intended.`,
      object,
      files: [file],
    });
  }
  const lost = (previous ?? []).filter((p) => {
    const c = now.get(key(p.name));
    return !c || rank(c) < rank(p);
  });
  if (lost.length) {
    out.push({
      rule: "sharing-rule-changed",
      severity: "medium",
      title: `${plural(lost.length, "sharing rule")} on ${object} removed or reduced`,
      detail: `${list(lost.map((r) => `${r.name} (${audience(r)}, ${r.accessLevel})`))}. Those users can lose access to records they relied on; automation running with their sharing may stop finding records.`,
      object,
      files: [file],
    });
  }
  return out;
}

// ---- Permission set groups and muting ---------------------------------------------------

export function parsePermissionSetGroup(xml: string | undefined): { permissionSets: string[]; muting: string[] } {
  if (!xml) return { permissionSets: [], muting: [] };
  try {
    const { body } = parseMetadataXml(xml);
    const names = (v: unknown) =>
      (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => text(x) ?? "").filter(Boolean);
    return { permissionSets: names(body.permissionSets), muting: names(body.mutingPermissionSets) };
  } catch {
    return { permissionSets: [], muting: [] };
  }
}

const groupCache = new WeakMap<
  OrgModel,
  { name: string; file: string; permissionSets: string[]; muting: string[] }[]
>();
/** Every permission set group in the project. */
export function permissionSetGroups(model: OrgModel) {
  let groups = groupCache.get(model);
  if (!groups) {
    groups = [];
    for (const c of model.components.values()) {
      if (c.metadataType !== "PermissionSetGroup") continue;
      let xml: string | undefined;
      try {
        xml = readProjectFile(model, c.file);
      } catch {
        xml = undefined;
      }
      groups.push({ name: c.name, file: c.file, ...parsePermissionSetGroup(xml) });
    }
    groupCache.set(model, groups);
  }
  return groups;
}

/** Groups that include a permission set (or mute with a muting permission set). */
export const groupsIncluding = (model: OrgModel, name: string, muting = false) =>
  permissionSetGroups(model)
    .filter((g) => (muting ? g.muting : g.permissionSets).some((p) => key(p) === key(name)))
    .map((g) => g.name);

/** What a permission set grants that bypasses sharing or reaches org-wide. */
function sensitiveGrants(ps: PermissionContainerDef | undefined, sensitive: Set<string>): string[] {
  if (!ps) return [];
  return [
    ...ps.objects.filter((o) => o.modifyAll).map((o) => `Modify All on ${o.object}`),
    ...ps.objects.filter((o) => o.viewAll && !o.modifyAll).map((o) => `View All on ${o.object}`),
    ...ps.userPermissions.filter((u) => sensitive.has(key(u))),
  ];
}

/** A changed permission set group: permission sets added or removed, mutes added. */
export function permissionSetGroupFindings(
  model: OrgModel,
  name: string,
  file: string,
  current: { permissionSets: string[]; muting: string[] },
  previous: { permissionSets: string[]; muting: string[] } | undefined,
  sensitive: Set<string>,
): Finding[] {
  if (!previous) previous = { permissionSets: [], muting: [] };
  const diff = (a: string[], b: string[]) => {
    const keep = new Set(b.map(key));
    return a.filter((x) => !keep.has(key(x)));
  };
  const added = diff(current.permissionSets, previous.permissionSets);
  const removed = diff(previous.permissionSets, current.permissionSets);
  const mutes = diff(current.muting, previous.muting);
  const out: Finding[] = [];
  const escalations = added.flatMap((ps) =>
    sensitiveGrants(model.permissionContainers.get(key(`PermissionSet:${ps}`)), sensitive).map(
      (g) => `${g} (from ${ps})`,
    ),
  );
  if (escalations.length) {
    out.push({
      rule: "permission-escalation",
      severity: "high",
      title: `Permission set group ${name} now grants ${list(escalations)}`,
      detail:
        "Everyone assigned the group gets it, including agent and integration users. Confirm the group's members should bypass sharing or hold these permissions.",
      files: [file],
    });
  }
  if (added.length && !escalations.length) {
    out.push({
      rule: "permission-group-changed",
      severity: "low",
      title: `Permission set group ${name} now includes ${list(added)}`,
      detail: "Everyone assigned the group gets these permission sets' access. Check the group's members need it.",
      files: [file],
    });
  }
  if (removed.length || mutes.length) {
    out.push({
      rule: "permission-access-removed",
      severity: "medium",
      title: `Permission set group ${name} ${[removed.length ? `drops ${list(removed)}` : "", mutes.length ? `mutes through ${list(mutes)}` : ""].filter(Boolean).join(" and ")}`,
      detail:
        "Members of the group lose that access unless another assignment grants it. Check who relies on it before deploying.",
      files: [file],
    });
  }
  return out;
}

/** A changed muting permission set: what it now mutes in the groups that use it. */
export function mutingFindings(
  model: OrgModel,
  current: PermissionContainerDef,
  previous: PermissionContainerDef | undefined,
): Finding[] {
  // Muting flags mean "take away": newly muted = in current, not in previous. Swap and reuse accessLost.
  const empty: PermissionContainerDef = {
    ...current,
    objects: [],
    fields: [],
    userPermissions: [],
    classes: [],
    pages: [],
    customPermissions: [],
  };
  const lost = accessLost(previous ?? empty, current);
  const items = [...lost.objects, ...lost.fields, ...lost.userPermissions];
  if (!items.length) return [];
  const groups = groupsIncluding(model, current.name, true);
  return [
    {
      rule: "permission-access-removed",
      severity: "medium",
      title: `Muting permission set ${current.name} now mutes ${plural(items.length, "permission")}`,
      detail: `${list(items)}. Members of ${groups.length ? `group(s) ${list(groups)}` : "the groups that use it"} lose this access.`,
      files: [current.file],
    },
  ];
}

/** Read a muting permission set file like a permission set (its flags mean "muted"). */
export const parseMuting = (xml: string, name: string, file: string): PermissionContainerDef =>
  parsePermissionContainer(xml, name, "PermissionSet", file);
