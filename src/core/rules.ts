// SPDX-License-Identifier: Apache-2.0
import type { Severity } from "./types.js";

/**
 * Catalog of finding rules. Used for SARIF rule metadata and docs/RULES.md.
 * Rule ids are stable: never rename one, deprecate it instead.
 */
export interface RuleInfo {
  id: string;
  name: string;
  /** Typical severity; individual findings may differ (e.g. changed vs impacted code). */
  defaultSeverity: Severity;
  summary: string;
  /** Why it matters and what to do about it. */
  help: string;
  security?: boolean;
}

export const RULES: RuleInfo[] = [
  {
    id: "recursion-cycle",
    name: "RecursionCycle",
    defaultSeverity: "high",
    summary: "Automation writes lead back to an object already being saved in the same transaction.",
    help: "Cycles that settle at human pace can recurse, double-apply or hit governor limits at bulk or agent volume. Add recursion guards (a static Set<Id> of processed records, not a static Boolean, which also skips the next 200-record chunk), narrow entry criteria, or move the write to a before-save flow.",
  },
  {
    id: "automated-write-vs-validation-rule",
    name: "AutomatedWriteVsValidationRule",
    defaultSeverity: "medium",
    summary: "Automation (or an agent action) writes records that are checked by validation rules.",
    help: "A correct action can still fail validation. Make sure the automation sets the fields the rule checks, and that failures are surfaced to the caller instead of swallowed.",
  },
  {
    id: "field-used-by-validation-rule",
    name: "FieldUsedByValidationRule",
    defaultSeverity: "medium",
    summary: "A changed field is referenced by an active validation rule.",
    help: "Changing the field's type, values or how it is populated changes which saves the rule blocks. Test the boundary values.",
  },
  {
    id: "validation-rule-vs-existing-automation",
    name: "ValidationRuleVsExistingAutomation",
    defaultSeverity: "high",
    summary: "A new or changed validation rule applies to existing automation that writes the object.",
    help: "Every flow, trigger and class that saves the object must now satisfy the rule. Check each writer sets the required fields.",
  },
  {
    id: "automated-write-vs-duplicate-rule",
    name: "AutomatedWriteVsDuplicateRule",
    defaultSeverity: "medium",
    summary:
      "Automation saves records that an active duplicate rule can block, or a duplicate rule now blocks saves that automation makes.",
    help: "A save that matches an existing record fails. Test the automation with matching data; Apex can set Database.DMLOptions.DuplicateRuleHeader.allowSave, and in any case the error must reach the user.",
  },
  {
    id: "save-rule-changed",
    name: "SaveRuleChanged",
    defaultSeverity: "low",
    summary:
      "An assignment, auto-response, escalation, duplicate or matching rule, or an approval process, was switched on or off, added, removed or reads different fields.",
    help: "These run as part of saving (or submitting) a record: ownership, emails, escalations, duplicate checks and approval locks change. Check which records they now apply to.",
  },
  {
    id: "platform-event-contract",
    name: "PlatformEventContract",
    defaultSeverity: "medium",
    summary: "A platform event or one of its fields changed; publishers and subscribers depend on it.",
    help: "Subscribers run later in their own transaction, so a mismatch shows up as failed event handling rather than a save error. Change publishers and subscribers together and test one event end to end.",
  },
  {
    id: "integration-endpoint-changed",
    name: "IntegrationEndpointChanged",
    defaultSeverity: "medium",
    summary:
      "A named credential, external credential, outbound message, remote site or CSP trusted site now points somewhere else or authenticates differently.",
    help: "Callouts and messages go to the new host with the same data and credentials, and secrets are set up per org rather than deployed. Confirm the host and test each caller the report lists.",
    security: true,
  },
  {
    id: "integration-insecure",
    name: "IntegrationInsecure",
    defaultSeverity: "high",
    summary: "An integration sends data over plain http, sends a session ID out, or keeps a secret in source control.",
    help: "Use https everywhere, send session IDs only to services you control, and keep secrets out of metadata (rotate any that were committed).",
    security: true,
  },
  {
    id: "integration-allowlist-removed",
    name: "IntegrationAllowlistRemoved",
    defaultSeverity: "medium",
    summary: "A remote site setting or CSP trusted site no longer allows a host that code still calls.",
    help: "Apex callouts or Lightning requests to that host fail at runtime. Keep the setting, or move the callers to a named credential in the same change.",
  },
  {
    id: "connected-app-access",
    name: "ConnectedAppAccess",
    defaultSeverity: "medium",
    summary: "A connected app requests more OAuth scopes or accepts new callback URLs.",
    help: "Full and refresh-token scopes give broad, long-lived access; callback URLs receive authorization codes. Request only the scopes needed and confirm every callback URL is yours and uses https.",
    security: true,
  },
  {
    id: "missing-field-reference",
    name: "MissingFieldReference",
    defaultSeverity: "medium",
    summary:
      "A changed report, report type, list view, email template, quick action, compact layout or field set names a custom field the project's object lacks.",
    help: "The deployment fails, or the column, filter or merge field breaks, unless the field already exists in the target org. Add the field to the change or fix the name.",
  },
  {
    id: "ignored-save-result",
    name: "IgnoredSaveResult",
    defaultSeverity: "medium",
    summary: "Apex saves with allOrNone=false (partial success) and never reads which records failed.",
    help: "Records that fail are skipped without an error, so data silently goes missing. Read the result (isSuccess / getErrors) and log, retry or surface the failures, or drop the false so the save fails loudly.",
  },
  {
    id: "after-save-self-update",
    name: "AfterSaveSelfUpdate",
    defaultSeverity: "medium",
    summary: "An after-save flow updates its own triggering record.",
    help: "This re-runs the whole save procedure. Use a before-save flow for same-record field updates.",
  },
  {
    id: "automation-density",
    name: "AutomationDensity",
    defaultSeverity: "medium",
    summary: "Three or more flows/triggers run on the same object and event.",
    help: "Overlapping automation is where ordering bugs and race conditions hide. Consolidate where possible and set flow trigger order.",
  },
  {
    id: "multiple-triggers",
    name: "MultipleTriggers",
    defaultSeverity: "medium",
    summary: "More than one Apex trigger on the same object.",
    help: "Salesforce does not guarantee the order between triggers on one object. Use one trigger per object with a handler.",
  },
  {
    id: "dml-or-soql-in-loop",
    name: "DmlOrSoqlInLoop",
    defaultSeverity: "high",
    summary: "DML or SOQL inside a loop in changed Apex or Apex in the blast radius.",
    help: "Queries and DML inside loops hit governor limits under bulk load. Query and write collections outside the loop.",
  },
  {
    id: "permission-escalation",
    name: "PermissionEscalation",
    defaultSeverity: "high",
    summary: "A permission set or profile grants Modify All or View All on an object.",
    help: "These bypass sharing for everyone holding the permission, including agent and integration users. Confirm the scope is intended.",
    security: true,
  },
  {
    id: "permission-system",
    name: "PermissionSystem",
    defaultSeverity: "high",
    summary: "A permission set or profile grants a sensitive system permission (e.g. ModifyAllData).",
    help: "System permissions have org-wide blast radius. Grant them to as few users as possible.",
    security: true,
  },
  {
    id: "permission-delete",
    name: "PermissionDelete",
    defaultSeverity: "medium",
    summary: "A permission set or profile grants delete on an object.",
    help: "Delete access is rarely needed by integration or agent users, and deletes cascade through master-detail children.",
    security: true,
  },
  {
    id: "permission-field-edit",
    name: "PermissionFieldEdit",
    defaultSeverity: "low",
    summary: "A permission set or profile newly grants edit access to fields.",
    help: "Review that each newly editable field is needed by the users holding the permission.",
    security: true,
  },
  {
    id: "permission-access-removed",
    name: "PermissionAccessRemoved",
    defaultSeverity: "medium",
    summary: "A permission set, profile, permission set group or muting permission set takes access away.",
    help: "Users who got the access only from there lose it: objects, fields, Apex classes, Visualforce pages, custom permissions or system permissions. The report names Lightning components and pages that need what was removed. Check who holds the access before deploying.",
  },
  {
    id: "permission-group-changed",
    name: "PermissionGroupChanged",
    defaultSeverity: "low",
    summary: "A permission set group now includes more permission sets.",
    help: "Everyone assigned the group gets the added access. Check the group's members need it.",
    security: true,
  },
  {
    id: "guest-access",
    name: "GuestAccess",
    defaultSeverity: "high",
    summary: "Guest (unauthenticated) site users gain access to objects, Apex classes or records.",
    help: "Anyone who reaches the site gets this access without logging in. Grant guests only what public pages need, and share only records meant to be public.",
    security: true,
  },
  {
    id: "sharing-model-opened",
    name: "SharingModelOpened",
    defaultSeverity: "high",
    summary: "An object's organization-wide default became more open (e.g. Private to Public Read/Write).",
    help: "Every user can now see or edit records they don't own. Check no record holds data some users must not see or change. Large orgs recalculate sharing on deploy.",
    security: true,
  },
  {
    id: "sharing-model-restricted",
    name: "SharingModelRestricted",
    defaultSeverity: "medium",
    summary: "An object's organization-wide default became more restrictive or changed control.",
    help: "Users can lose access to records they don't own, and automation running with the user's sharing may stop finding records. Add sharing rules for who still needs access.",
  },
  {
    id: "sharing-rule-changed",
    name: "SharingRuleChanged",
    defaultSeverity: "medium",
    summary: "A sharing rule was added, widened, narrowed or removed.",
    help: "New or wider rules open records to their audience (high when shared with all internal, partner or portal users for edit); removed or reduced rules take access away. Confirm the audience and access level.",
    security: true,
  },
  {
    id: "deleted-still-referenced",
    name: "DeletedStillReferenced",
    defaultSeverity: "high",
    summary: "A deleted field, flow or class is still referenced elsewhere.",
    help: "The deployment will fail or the references will break at runtime. Remove or update the references in the same change.",
  },
  {
    id: "deleted-still-named",
    name: "DeletedStillNamed",
    defaultSeverity: "medium",
    summary: "A deleted component of any metadata type is still named by other files in the project.",
    help: "Found by name, not by parsing, so check each listed file. Where it is a real reference, a deployment that includes the file fails, or the reference breaks once the component is gone from the org. Update or remove the references in the same change.",
  },
  {
    id: "renamed-still-named",
    name: "RenamedStillNamed",
    defaultSeverity: "medium",
    summary: "A renamed component's old name is still used by other files in the project.",
    help: "Renaming a metadata file creates a new component and leaves the old one in the org until it is deleted, so the change can work in an existing org and fail in a new one. Update the references in the same change.",
  },
  {
    id: "validation-rule-removed",
    name: "ValidationRuleRemoved",
    defaultSeverity: "info",
    summary: "A validation rule was removed.",
    help: "Data that was previously blocked can now be saved.",
  },
  {
    id: "validation-rule-inactive",
    name: "ValidationRuleInactive",
    defaultSeverity: "info",
    summary: "A changed validation rule is inactive.",
    help: "Inactive rules do not run.",
  },
  {
    id: "flow-inactive",
    name: "FlowInactive",
    defaultSeverity: "info",
    summary: "A changed flow is not active.",
    help: "It will not run until activated.",
  },
  {
    id: "org-only-automation",
    name: "OrgOnlyAutomation",
    defaultSeverity: "medium",
    summary: "Active automation on an impacted object exists in the org (`--org`) but not in the project.",
    help: "Preflight can only follow automation it can read, so the cascade may be incomplete. Retrieve the components into the project; managed-package automation can't be retrieved but still runs, so keep it enabled when testing.",
  },
  {
    id: "agent-metadata-changed",
    name: "AgentMetadataChanged",
    defaultSeverity: "info",
    summary: "Agentforce metadata changed that no agent action in the project uses.",
    help: "Preflight follows agent changes through the actions that use them. Metadata that no agent in the project uses (or that was deleted) can't be followed; check the agents that use it in Agent Builder.",
  },
  {
    id: "agent-action-affected",
    name: "AgentActionAffected",
    defaultSeverity: "medium",
    summary: "The change reaches what an agent action calls or saves.",
    help: "Agents call actions at volume and can't interpret errors the way a person does. Re-run the agent's Testing Center tests, check the action still succeeds with realistic data, and make sure failures are reported back to the agent. High when the action's saves run into an automation cycle.",
  },
  {
    id: "agent-action-untested",
    name: "AgentActionUntested",
    defaultSeverity: "low",
    summary: "No Testing Center test expects an affected agent action.",
    help: "Testing Center checks the decision layer: that the agent picks the right topic and action for a request. Add a test case (an utterance plus the expected topic and action) for every action a change affects.",
  },
  {
    id: "agent-action-target-missing",
    name: "AgentActionTargetMissing",
    defaultSeverity: "low",
    summary: "An affected agent action calls an Apex class or flow that isn't in the project.",
    help: "Preflight can't follow what the action does. Retrieve the class or flow into the project if it only lives in the org.",
  },
  {
    id: "agent-runtime-access",
    name: "AgentRuntimeAccess",
    defaultSeverity: "high",
    summary:
      "With --org: an affected agent's runtime user lacks access its actions need, is inactive or doesn't exist.",
    help: "The action fails when the agent runs it. Grant the object access in a permission set assigned to the agent's user, and keep the user active.",
    security: true,
  },
  {
    id: "agent-runtime-overprivileged",
    name: "AgentRuntimeOverprivileged",
    defaultSeverity: "medium",
    summary: "With --org: an affected agent's runtime user holds broad access such as Modify All Data.",
    help: "An agent acts on whatever a conversation leads it to. Give its user only the object access its actions need.",
    security: true,
  },
  {
    id: "agent-action-no-confirmation",
    name: "AgentActionNoConfirmation",
    defaultSeverity: "medium",
    summary: "An agent action deletes records without asking the user for confirmation.",
    help: "Require confirmation for destructive actions so a misunderstood request can't delete data.",
    security: true,
  },
  {
    id: "legacy-workflow",
    name: "LegacyWorkflow",
    defaultSeverity: "info",
    summary: "A legacy workflow rule changed.",
    help: "Workflow rules are not analyzed yet; consider migrating them to flows.",
  },
  {
    id: "field-used-by-lightning",
    name: "FieldUsedByLightning",
    defaultSeverity: "low",
    summary: "A changed field is used by Lightning Web Components or Aura components.",
    help: "Components read and show the field directly. After changing its type, values or access, check the component and the pages it sits on.",
  },
  {
    id: "apex-called-from-lightning",
    name: "ApexCalledFromLightning",
    defaultSeverity: "low",
    summary: "A changed Apex class is called from Lightning components.",
    help: "Lightning components call Apex from the browser, so a changed signature, result shape or error behaviour reaches users without a flow or trigger in between. Re-test the component.",
  },
  {
    id: "lightning-missing-reference",
    name: "LightningMissingReference",
    defaultSeverity: "medium",
    summary: "A changed Lightning component uses a field or Apex class that is not in the project.",
    help: "Importing a missing field or class fails the deployment. Add it to the project, or make sure it exists in the target org before this change deploys.",
  },
  {
    id: "omnistudio-used-by",
    name: "OmniStudioUsedBy",
    defaultSeverity: "info",
    summary:
      "A changed Integration Procedure, Data Mapper, OmniScript or FlexCard is used by other OmniStudio components.",
    help: "A changed input, output or response shape reaches them. Run them after deploying.",
  },
  {
    id: "omnistudio-missing-reference",
    name: "OmniStudioMissingReference",
    defaultSeverity: "medium",
    summary:
      "A changed OmniStudio component calls an Integration Procedure, Data Mapper, Apex class, OmniScript, Lightning component or field that is not in the project.",
    help: "OmniStudio names these in JSON settings, so the deployment does not check them and the script fails when it runs. Add them to the project, or make sure the target org has them.",
  },
  {
    id: "omnistudio-remote-not-callable",
    name: "OmniStudioRemoteNotCallable",
    defaultSeverity: "high",
    summary: "An Apex class used by a Remote Action implements neither System.Callable nor VlocityOpenInterface2.",
    help: "OmniStudio calls remote classes through one of those interfaces. Implement System.Callable and dispatch on the method name.",
  },
  {
    id: "omnistudio-inactive-in-use",
    name: "OmniStudioInactiveInUse",
    defaultSeverity: "medium",
    summary:
      "An inactive Integration Procedure, OmniScript, Data Mapper or FlexCard is still called, and no active version is in the project.",
    help: "Callers fail at run time unless the target org has an active version. Activate it or update the callers.",
  },
  {
    id: "omnistudio-cycle",
    name: "OmniStudioCycle",
    defaultSeverity: "medium",
    summary: "An Integration Procedure or OmniScript calls itself through other procedures or scripts.",
    help: "Unless a condition stops it, it runs until a limit is hit. Check the loop is intended and guarded.",
  },
  {
    id: "apex-called-from-omnistudio",
    name: "ApexCalledFromOmniStudio",
    defaultSeverity: "low",
    summary: "A changed Apex class is called by OmniScripts, Integration Procedures or FlexCards.",
    help: "A changed method name, input or output keys reach their users directly. Run the components that call it.",
  },
  {
    id: "picklist-value-removed",
    name: "PicklistValueRemoved",
    defaultSeverity: "medium",
    summary: "Picklist values were removed or deactivated while record types, formulas, flows or Apex still use them.",
    help: "Records keep the old value, but saves that set it fail or take the wrong branch. Remove it from the record types and replace it in the formulas, flows and code, or keep it active.",
  },
  {
    id: "record-type-values-removed",
    name: "RecordTypeValuesRemoved",
    defaultSeverity: "low",
    summary: "A record type no longer offers picklist values it offered before.",
    help: "Users of that record type can no longer pick them. Existing records keep their values.",
  },
  {
    id: "record-type-deactivated",
    name: "RecordTypeDeactivated",
    defaultSeverity: "low",
    summary: "A record type was deactivated.",
    help: "New records can no longer use it. Flows or Apex that create records of this type may fail.",
  },
  {
    id: "record-type-still-referenced",
    name: "RecordTypeStillReferenced",
    defaultSeverity: "medium",
    summary: "A deleted record type is still named in Apex, flows or formulas.",
    help: "Comparing against a record type by name does not fail the deployment; it quietly stops matching. Update the code, flows and formulas that name it.",
  },
  {
    id: "label-removed-still-used",
    name: "LabelRemovedStillUsed",
    defaultSeverity: "high",
    summary: "A custom label was removed but Apex, Visualforce, Lightning or flows still use it.",
    help: "Code that names a missing label fails to compile. Restore the label or update what uses it.",
  },
  {
    id: "cmdt-record-still-referenced",
    name: "CmdtRecordStillReferenced",
    defaultSeverity: "medium",
    summary: "A deleted custom metadata record is still named in code that reads its type.",
    help: "Lookups by the record's name return nothing after the delete. Update the code, or keep the record.",
  },
  {
    id: "cmdt-record-changed",
    name: "CmdtRecordChanged",
    defaultSeverity: "info",
    summary: "A custom metadata record changed; files that read its type are listed.",
    help: "Custom metadata is configuration that code reads at run time. Check the readers behave with the new values.",
  },
  {
    id: "visualforce-missing-reference",
    name: "VisualforceMissingReference",
    defaultSeverity: "medium",
    summary: "A Visualforce page or component names an Apex controller or extension the project does not have.",
    help: "The page cannot be saved without its classes. Deploy them together or fix the name.",
  },
  {
    id: "apex-used-by-page",
    name: "ApexUsedByPage",
    defaultSeverity: "info",
    summary: "An Apex class is the controller or extension of Visualforce pages (high when the class is deleted).",
    help: "Changes to its properties and actions reach users through those pages. A deleted class breaks them.",
  },
  {
    id: "field-on-page",
    name: "FieldOnPage",
    defaultSeverity: "info",
    summary: "A changed field is on page layouts or Lightning pages.",
    help: "A changed label, type or access shows up on those pages. Open one to check it still reads well.",
  },
  {
    id: "lightning-on-page",
    name: "LightningOnPage",
    defaultSeverity: "info",
    summary: "A changed Lightning component is placed on Lightning pages.",
    help: "Open the pages to check the component renders and behaves as intended where it is placed.",
  },
  {
    id: "page-missing-reference",
    name: "PageMissingReference",
    defaultSeverity: "medium",
    summary: "A changed layout or Lightning page uses a field or component that is not in the project.",
    help: "A page that names a missing field or component fails the deployment. Add it to the project, or make sure the target org already has it.",
  },
  {
    id: "page-element-removed",
    name: "PageElementRemoved",
    defaultSeverity: "low",
    summary: "A changed layout or Lightning page no longer shows fields or components it showed before.",
    help: "Users of the page lose them. Confirm that is intended, and that nothing in their process depends on seeing them.",
  },
  {
    id: "metadata-not-analyzed",
    name: "MetadataNotAnalyzed",
    defaultSeverity: "info",
    summary: "A changed component is of a metadata type that is not analyzed in depth.",
    help: "sf-preflight recognizes the type (layouts, Lightning components, page layouts, labels, ...) but only lists it and the files that mention it. Review what depends on it yourself, and turn the rule off in .preflight.json if the noise is not useful.",
  },
];

const BY_ID = new Map(RULES.map((r) => [r.id, r]));

export function ruleInfo(id: string): RuleInfo | undefined {
  return BY_ID.get(id);
}

const SEVERITY_LABEL: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low", info: "Info" };

/** Render docs/RULES.md from the catalog (kept in sync by a test). */
export function renderRulesMarkdown(): string {
  const lines = [
    "# Rules",
    "",
    "<!-- Generated from src/core/rules.ts by `npm run docs:rules`. Do not edit by hand. -->",
    "",
    "Every finding has a stable rule id. Severity shown is the typical one; some findings are",
    "raised or lowered depending on context (for example, issues in changed code versus code",
    "that is only inside the blast radius).",
    "",
    "| Rule | Severity | Summary |",
    "|---|---|---|",
    ...RULES.map((r) => `| [\`${r.id}\`](#${r.id}) | ${SEVERITY_LABEL[r.defaultSeverity]} | ${r.summary} |`),
    "",
  ];
  for (const r of RULES) {
    lines.push(
      `## ${r.id}`,
      "",
      `**${r.name}** · default severity: ${SEVERITY_LABEL[r.defaultSeverity]}${r.security ? " · security" : ""}`,
      "",
      r.summary,
      "",
      r.help,
      "",
    );
  }
  return lines.join("\n");
}
