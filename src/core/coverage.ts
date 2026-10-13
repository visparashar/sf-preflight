// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import path from "node:path";
import { readProjectFile } from "./files.js";
import { looksLikeSObject } from "./standardObjects.js";
import type { Change, ComponentRef, ComponentType, Coverage, OrgModel } from "./types.js";

/** Component types with their own analysis. Everything else is recognized but analyzed only by name. */
const DEEP: ReadonlySet<ComponentType> = new Set([
  "CustomObject",
  "CustomField",
  "ValidationRule",
  "ObjectChild",
  "Flow",
  "ApexTrigger",
  "ApexClass",
  "PermissionSet",
  "Profile",
  "AgentMetadata",
]);

/** Metadata types that have their own analysis although they are not a dedicated component type. */
const DEEP_METADATA: ReadonlySet<string> = new Set([
  "LightningComponentBundle",
  "AuraDefinitionBundle",
  "Layout",
  "FlexiPage",
  "CustomLabels",
  "CustomMetadata",
  "ApexPage",
  "ApexComponent",
  "SharingRules",
  "PermissionSetGroup",
  "MutingPermissionSet",
  "AssignmentRules",
  "AutoResponseRules",
  "EscalationRules",
  "DuplicateRule",
  "MatchingRules",
  "ApprovalProcess",
  "NamedCredential",
  "ExternalCredential",
  "RemoteSiteSetting",
  "CspTrustedSite",
  "ConnectedApp",
]);

export const isAnalyzedInDepth = (c: ComponentRef): boolean =>
  DEEP.has(c.type) || (c.metadataType !== undefined && DEEP_METADATA.has(c.metadataType));

const MAX_COMPONENTS = 50;
const MAX_FILES_PER_COMPONENT = 15;
const MAX_FILE_BYTES = 1024 * 1024;
/** Text formats that can name another component. Binary and archive files are never read. */
const TEXT_FILE = /\.(xml|cls|trigger|js|ts|html|css|cmp|app|evt|design|page|component|json|agent|yaml|yml|csv)$/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The strings other files use to refer to a component: its API name. */
const tokensFor = (name: string): string[] => [name];

/**
 * What the change touches that has no dedicated analysis: counts by type, and which other files in
 * the project mention each component, so a reviewer knows where to look. Returns nothing when every
 * changed component is analyzed in depth.
 */
export function buildCoverage(model: OrgModel, changes: Change[]): Coverage | undefined {
  const basic = changes.filter((c) => !isAnalyzedInDepth(c.component));
  if (!basic.length) return undefined;

  const byType = new Map<string, number>();
  const label = (c: Change) => c.component.metadataType ?? c.component.type;
  for (const c of basic) byType.set(label(c), (byType.get(label(c)) ?? 0) + 1);

  // One pass over the project's text files, looking for every component's tokens.
  const objectNames = new Set(model.objects.keys());
  const targets = basic.slice(0, MAX_COMPONENTS).map((c) => ({
    type: label(c),
    name: c.component.name,
    // Nothing to search for when the name is also an object's name (Account.settings, sharing rules
    // for Account) or the type is the legacy workflow: every file would match.
    tokens:
      c.component.type === "WorkflowRule" || looksLikeSObject(c.component.name, objectNames)
        ? []
        : tokensFor(c.component.name).filter((t) => t.length >= 3),
    found: new Set<string>(),
  }));
  const boundary = (token: string) => new RegExp(`(?<![A-Za-z0-9_])${escapeRe(token)}(?![A-Za-z0-9_])`);
  const patterns = targets.map((t) => t.tokens.map((tok) => ({ tok, re: boundary(tok) })));

  for (const [file, ref] of model.components) {
    if (!TEXT_FILE.test(file)) continue;
    let text: string | undefined;
    for (const [i, t] of targets.entries()) {
      // A component's own files (a bundle's .js/.html, a class and its meta file) are not mentions.
      if (ref.type === "Metadata" && ref.metadataType === t.type && ref.name === t.name) continue;
      for (const { tok, re } of patterns[i] ?? []) {
        text ??= readText(model, file) ?? "";
        if (text.includes(tok) && re.test(text)) {
          t.found.add(file);
          break;
        }
      }
    }
  }

  return {
    deep: changes.length - basic.length,
    basic: basic.length,
    basicByType: [...byType]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    mentions: targets
      .filter((t) => t.found.size)
      .map((t) => {
        const files = [...t.found].sort();
        return {
          component: t.name,
          type: t.type,
          files: files.slice(0, MAX_FILES_PER_COMPONENT),
          more: Math.max(0, files.length - MAX_FILES_PER_COMPONENT),
        };
      }),
  };
}

function readText(model: OrgModel, file: string): string | undefined {
  try {
    const text = readProjectFile(model, file);
    return text.length > MAX_FILE_BYTES ? undefined : text;
  } catch {
    return undefined;
  }
}
