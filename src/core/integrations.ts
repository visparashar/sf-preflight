// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import path from "node:path";
import { readProjectFile } from "./files.js";
import { filesNaming } from "./references.js";
import type { ComponentRef, Finding, OrgModel } from "./types.js";
import { bool, key, nodes, parseMetadataXml, text, uniq, type XmlNode } from "./util.js";

/**
 * Integrations: named and external credentials, remote site settings, CSP trusted sites,
 * connected apps and outbound messages. What changes here breaks callouts at runtime, or
 * opens a path for data to leave the org, so each change is compared with the base version and
 * tied to the code that uses it.
 */

export const INTEGRATION_TYPES = new Set([
  "NamedCredential",
  "ExternalCredential",
  "RemoteSiteSetting",
  "CspTrustedSite",
  "ConnectedApp",
]);

export interface IntegrationDef {
  type: string;
  name: string;
  file: string;
  url?: string;
  active: boolean;
  /** How it authenticates: principal type, protocol, external credential. */
  auth?: string;
  /** Named credentials: the external credential they use. */
  externalCredential?: string;
  /** Remote site settings: callouts over plain http are allowed. */
  insecureProtocol?: boolean;
  /** Connected apps. */
  scopes?: string[];
  callbacks?: string[];
  /** Connected apps: a consumer secret is stored in the file. */
  hasSecret?: boolean;
}

const MAX_LISTED = 8;
const list = (xs: string[]) =>
  `${xs.slice(0, MAX_LISTED).join(", ")}${xs.length > MAX_LISTED ? ` and ${xs.length - MAX_LISTED} more` : ""}`;

/** `https://api.example.com/v1` → `api.example.com`. */
export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/:?#]+)/i.exec(url.trim());
  return m?.[1]?.toLowerCase();
}
const isHttp = (url: string | undefined) => !!url && /^http:\/\//i.test(url.trim());

export function parseIntegration(comp: ComponentRef, xml: string | undefined): IntegrationDef | undefined {
  if (!xml || !comp.metadataType) return undefined;
  let body: XmlNode;
  try {
    body = parseMetadataXml(xml).body;
  } catch {
    return undefined;
  }
  const base = { type: comp.metadataType, name: comp.name, file: comp.file };
  switch (comp.metadataType) {
    case "NamedCredential": {
      const params = nodes(body.namedCredentialParameters);
      const url =
        text(body.endpoint) ?? text(params.find((p) => key(text(p.parameterType) ?? "") === "url")?.parameterValue);
      const external = params.map((p) => text(p.externalCredential)).find(Boolean);
      const auth = [text(body.principalType), text(body.protocol), external && `external credential ${external}`]
        .filter(Boolean)
        .join(", ");
      return { ...base, url, active: true, auth: auth || undefined, externalCredential: external };
    }
    case "ExternalCredential": {
      const principals = nodes(body.externalCredentialParameters)
        .filter((p) => /principal/i.test(text(p.parameterType) ?? ""))
        .map((p) => `${text(p.parameterType)} ${text(p.parameterName) ?? ""}`.trim());
      return {
        ...base,
        active: true,
        auth: [text(body.authenticationProtocol), ...principals].filter(Boolean).join(", ") || undefined,
      };
    }
    case "RemoteSiteSetting":
      return {
        ...base,
        url: text(body.url),
        active: bool(body.isActive),
        insecureProtocol: bool(body.disableProtocolSecurity),
      };
    case "CspTrustedSite":
      return { ...base, url: text(body.endpointUrl), active: bool(body.isActive) };
    case "ConnectedApp": {
      const oauth = (body.oauthConfig ?? {}) as XmlNode;
      const scopes = (Array.isArray(oauth.scopes) ? oauth.scopes : oauth.scopes ? [oauth.scopes] : [])
        .map((s) => text(s) ?? "")
        .filter(Boolean);
      return {
        ...base,
        active: true,
        scopes,
        callbacks: (text(oauth.callbackUrl) ?? "")
          .split(/[\s,]+/)
          .map((u) => u.trim())
          .filter(Boolean),
        hasSecret: !!text(oauth.consumerSecret),
      };
    }
    default:
      return undefined;
  }
}

// ---- Who uses it ---------------------------------------------------------------------------

/** Code and configuration files that name a URL's host (Apex, flows, Lightning, Visualforce). */
const CODE_FILE = /\.(cls|trigger|js|ts|html|cmp|page|component|flow-meta\.xml|namedCredential-meta\.xml)$/i;
function filesCallingHost(model: OrgModel, host: string, exceptFile: string): string[] {
  const re = new RegExp(`[a-z]+://${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`, "i");
  const out: string[] = [];
  for (const file of model.components.keys()) {
    if (file === exceptFile || !CODE_FILE.test(file) || /__tests__/.test(file)) continue;
    // Test classes mock their callouts.
    const ref = model.components.get(file);
    if (ref?.type === "ApexClass" && model.classes.get(key(ref.name))?.isTest) continue;
    let t: string;
    try {
      t = readProjectFile(model, file);
    } catch {
      continue;
    }
    if (t.length < 2_000_000 && t.toLowerCase().includes(host) && re.test(t)) out.push(file);
  }
  return out.sort();
}

const nonPermission = (f: string) => !/\.(permissionset|profile|permissionsetgroup)-meta\.xml$/.test(f);

/** Named credentials in the project that use an external credential. */
function namedCredentialsUsing(model: OrgModel, external: string): IntegrationDef[] {
  const out: IntegrationDef[] = [];
  for (const c of model.components.values()) {
    if (c.metadataType !== "NamedCredential") continue;
    let xml: string | undefined;
    try {
      xml = readProjectFile(model, c.file);
    } catch {
      xml = undefined;
    }
    const nc = parseIntegration(c, xml);
    if (nc?.externalCredential && key(nc.externalCredential) === key(external)) out.push(nc);
  }
  return out;
}

// ---- Findings ------------------------------------------------------------------------------

/**
 * A changed, added or deleted integration component. `current` is undefined when deleted,
 * `previous` when added or when there is no base to compare with.
 */
export function integrationFindings(
  model: OrgModel,
  comp: ComponentRef,
  current: IntegrationDef | undefined,
  previous: IntegrationDef | undefined,
): Finding[] {
  const out: Finding[] = [];
  const file = comp.file;
  const type = comp.metadataType ?? "";

  if (type === "NamedCredential" && current) {
    const callers = filesNaming(model, comp).filter(nonPermission);
    const via = callers.length ? ` Used by ${list(callers)}.` : "";
    if (isHttp(current.url) && !isHttp(previous?.url)) {
      out.push({
        rule: "integration-insecure",
        severity: "high",
        title: `Named credential ${comp.name} sends callouts over plain http`,
        detail: `${current.url} is not encrypted: credentials and data travel in clear text.${via} Use https.`,
        files: uniq([file, ...callers]),
      });
    }
    if (previous) {
      const [h0, h1] = [hostOf(previous.url), hostOf(current.url)];
      if (h0 && h1 && h0 !== h1) {
        out.push({
          rule: "integration-endpoint-changed",
          severity: "medium",
          title: `Named credential ${comp.name} now points to ${h1} instead of ${h0}`,
          detail: `Every callout through callout:${comp.name} goes to the new host, with the same credentials.${via} Confirm the host is the intended service, and test each caller against it.`,
          files: uniq([file, ...callers]),
        });
      }
      if ((previous.auth ?? "") !== (current.auth ?? "")) {
        out.push({
          rule: "integration-endpoint-changed",
          severity: "medium",
          title: `Named credential ${comp.name} authenticates differently`,
          detail: `${previous.auth ?? "none"} → ${current.auth ?? "none"}. Secrets are not deployed with metadata, so each org needs the new authentication set up before callers work.${via}`,
          files: uniq([file, ...callers]),
        });
      }
    }
  }

  if (type === "ExternalCredential" && current && previous && (previous.auth ?? "") !== (current.auth ?? "")) {
    const ncs = namedCredentialsUsing(model, comp.name);
    out.push({
      rule: "integration-endpoint-changed",
      severity: "medium",
      title: `External credential ${comp.name} authenticates differently`,
      detail: `${previous.auth ?? "none"} → ${current.auth ?? "none"}.${ncs.length ? ` Named credentials using it: ${list(ncs.map((n) => n.name))}.` : ""} Secrets and principal access are set up per org; callouts fail until they are.`,
      files: uniq([file, ...ncs.map((n) => n.file)]),
    });
  }

  if (type === "RemoteSiteSetting" || type === "CspTrustedSite") {
    const what = type === "RemoteSiteSetting" ? "Remote site setting" : "CSP trusted site";
    const lets = type === "RemoteSiteSetting" ? "Apex callouts to" : "Lightning components loading from";
    if (current?.active && current.insecureProtocol && !previous?.insecureProtocol) {
      out.push({
        rule: "integration-insecure",
        severity: "high",
        title: `${what} ${comp.name} allows callouts over plain http`,
        detail: `disableProtocolSecurity is on for ${current.url}: data can leave the org unencrypted. Turn it off and use https.`,
        files: [file],
      });
    }
    const was = previous?.active ? hostOf(previous.url) : undefined;
    const now = current?.active ? hostOf(current.url) : undefined;
    if (was && was !== now) {
      const callers = filesCallingHost(model, was, file);
      if (callers.length) {
        out.push({
          rule: "integration-allowlist-removed",
          severity: "medium",
          title: `${what} ${comp.name} no longer allows ${was}, which ${callers.length} file(s) still call`,
          detail: `${list(callers)} name ${was}. ${lets} it fail once the setting is ${current ? (current.active ? "changed" : "deactivated") : "deleted"}, unless another setting allows the host.`,
          files: uniq([file, ...callers]),
        });
      }
    }
    if (now && now !== was) {
      out.push({
        rule: "integration-endpoint-changed",
        severity: "low",
        title: `${what} ${comp.name} now allows ${now}`,
        detail: `${lets} ${now} are allowed. Confirm the host is a trusted service: data can be sent to it.`,
        files: [file],
      });
    }
  }

  if (type === "ConnectedApp" && current) {
    if (current.hasSecret) {
      out.push({
        rule: "integration-insecure",
        severity: "high",
        title: `Connected app ${comp.name} has its consumer secret in source control`,
        detail:
          "Anyone with read access to the repository can use the secret. Remove it from the file, rotate it in the org, and keep secrets out of metadata.",
        files: [file],
      });
    }
    const before = new Set((previous?.scopes ?? []).map(key));
    const added = (current.scopes ?? []).filter((s) => !before.has(key(s)));
    if (added.length && previous) {
      const broad = added.filter((s) => /^(full|api|refreshtoken|web)$/i.test(s));
      out.push({
        rule: "connected-app-access",
        severity: added.some((s) => /^full$/i.test(s)) ? "high" : broad.length ? "medium" : "low",
        title: `Connected app ${comp.name} requests more OAuth scopes: ${added.join(", ")}`,
        detail: `Apps and users authorizing it get ${added.join(", ")} access${added.some((s) => /^refreshtoken$/i.test(s)) ? ", including offline access through refresh tokens" : ""}. Request only the scopes the integration needs.`,
        files: [file],
      });
    }
    const cb0 = new Set((previous?.callbacks ?? []).map(key));
    const newCallbacks = (current.callbacks ?? []).filter((u) => !cb0.has(key(u)));
    if (previous && newCallbacks.length) {
      out.push({
        rule: "connected-app-access",
        severity: newCallbacks.some(isHttp) ? "high" : "medium",
        title: `Connected app ${comp.name} accepts new OAuth callback URL(s): ${list(newCallbacks)}`,
        detail: "Authorization codes and tokens are sent to these URLs. Confirm each one is yours and uses https.",
        files: [file],
      });
    }
  }
  return out;
}

// ---- Outbound messages (in workflow files) --------------------------------------------------

export interface OutboundMessageDef {
  name: string;
  object: string;
  url?: string;
  fields: string[];
  includeSessionId: boolean;
  file: string;
}

export function parseOutboundMessages(xml: string | undefined, object: string, file: string): OutboundMessageDef[] {
  if (!xml) return [];
  try {
    const { body } = parseMetadataXml(xml);
    return nodes(body.outboundMessages).map((m) => ({
      name: `${object}.${text(m.fullName) ?? "message"}`,
      object,
      url: text(m.endpointUrl),
      fields: (Array.isArray(m.fields) ? m.fields : m.fields ? [m.fields] : [])
        .map((f) => text(f) ?? "")
        .filter(Boolean),
      includeSessionId: bool(m.includeSessionId),
      file,
    }));
  } catch {
    return [];
  }
}

const outboundCache = new WeakMap<OrgModel, OutboundMessageDef[]>();
/** Outbound messages in the project's workflow files. */
export function outboundMessagesOf(model: OrgModel): OutboundMessageDef[] {
  let all = outboundCache.get(model);
  if (!all) {
    all = [];
    for (const c of model.components.values()) {
      if (c.type !== "WorkflowRule") continue;
      try {
        all.push(...parseOutboundMessages(readProjectFile(model, c.file), c.name, c.file));
      } catch {
        // unreadable
      }
    }
    outboundCache.set(model, all);
  }
  return all;
}

/** A changed workflow file: outbound messages that send a session ID, use http, or point elsewhere. */
export function outboundMessageFindings(
  current: OutboundMessageDef[],
  previous: OutboundMessageDef[] | undefined,
): Finding[] {
  const out: Finding[] = [];
  const before = new Map((previous ?? []).map((m) => [key(m.name), m]));
  for (const m of current) {
    const p = before.get(key(m.name));
    if (m.includeSessionId && !p?.includeSessionId) {
      out.push({
        rule: "integration-insecure",
        severity: "high",
        title: `Outbound message ${m.name} sends a session ID to ${hostOf(m.url) ?? "its endpoint"}`,
        detail:
          "The receiver can act in Salesforce as the integration user for as long as the session lasts. Send a session ID only to a service you control, over https.",
        object: m.object,
        files: [m.file],
      });
    }
    if (isHttp(m.url) && !isHttp(p?.url)) {
      out.push({
        rule: "integration-insecure",
        severity: "high",
        title: `Outbound message ${m.name} posts to plain http`,
        detail: `${m.url} is not encrypted: the record fields it sends (${list(m.fields)}) travel in clear text. Use https.`,
        object: m.object,
        files: [m.file],
      });
    }
    const [h0, h1] = [hostOf(p?.url), hostOf(m.url)];
    if (p && h0 && h1 && h0 !== h1) {
      out.push({
        rule: "integration-endpoint-changed",
        severity: "medium",
        title: `Outbound message ${m.name} now posts to ${h1} instead of ${h0}`,
        detail: `It sends ${list(m.fields)} from ${m.object} records. Confirm the new host is the intended receiver.`,
        object: m.object,
        files: [m.file],
      });
    }
  }
  return out;
}
