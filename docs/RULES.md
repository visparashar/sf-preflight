# Rules

<!-- Generated from src/core/rules.ts by `npm run docs:rules`. Do not edit by hand. -->

Every finding has a stable rule id. Severity shown is the typical one; some findings are
raised or lowered depending on context (for example, issues in changed code versus code
that is only inside the blast radius).

| Rule | Severity | Summary |
|---|---|---|
| [`recursion-cycle`](#recursion-cycle) | High | Automation writes lead back to an object already being saved in the same transaction. |
| [`automated-write-vs-validation-rule`](#automated-write-vs-validation-rule) | Medium | Automation (or an agent action) writes records that are checked by validation rules. |
| [`field-used-by-validation-rule`](#field-used-by-validation-rule) | Medium | A changed field is referenced by an active validation rule. |
| [`validation-rule-vs-existing-automation`](#validation-rule-vs-existing-automation) | High | A new or changed validation rule applies to existing automation that writes the object. |
| [`automated-write-vs-duplicate-rule`](#automated-write-vs-duplicate-rule) | Medium | Automation saves records that an active duplicate rule can block, or a duplicate rule now blocks saves that automation makes. |
| [`save-rule-changed`](#save-rule-changed) | Low | An assignment, auto-response, escalation, duplicate or matching rule, or an approval process, was switched on or off, added, removed or reads different fields. |
| [`platform-event-contract`](#platform-event-contract) | Medium | A platform event or one of its fields changed; publishers and subscribers depend on it. |
| [`integration-endpoint-changed`](#integration-endpoint-changed) | Medium | A named credential, external credential, outbound message, remote site or CSP trusted site now points somewhere else or authenticates differently. |
| [`integration-insecure`](#integration-insecure) | High | An integration sends data over plain http, sends a session ID out, or keeps a secret in source control. |
| [`integration-allowlist-removed`](#integration-allowlist-removed) | Medium | A remote site setting or CSP trusted site no longer allows a host that code still calls. |
| [`connected-app-access`](#connected-app-access) | Medium | A connected app requests more OAuth scopes or accepts new callback URLs. |
| [`missing-field-reference`](#missing-field-reference) | Medium | A changed report, report type, list view, email template, quick action, compact layout or field set names a custom field the project's object lacks. |
| [`after-save-self-update`](#after-save-self-update) | Medium | An after-save flow updates its own triggering record. |
| [`automation-density`](#automation-density) | Medium | Three or more flows/triggers run on the same object and event. |
| [`multiple-triggers`](#multiple-triggers) | Medium | More than one Apex trigger on the same object. |
| [`dml-or-soql-in-loop`](#dml-or-soql-in-loop) | High | DML or SOQL inside a loop in changed Apex or Apex in the blast radius. |
| [`permission-escalation`](#permission-escalation) | High | A permission set or profile grants Modify All or View All on an object. |
| [`permission-system`](#permission-system) | High | A permission set or profile grants a sensitive system permission (e.g. ModifyAllData). |
| [`permission-delete`](#permission-delete) | Medium | A permission set or profile grants delete on an object. |
| [`permission-field-edit`](#permission-field-edit) | Low | A permission set or profile newly grants edit access to fields. |
| [`permission-access-removed`](#permission-access-removed) | Medium | A permission set, profile, permission set group or muting permission set takes access away. |
| [`permission-group-changed`](#permission-group-changed) | Low | A permission set group now includes more permission sets. |
| [`guest-access`](#guest-access) | High | Guest (unauthenticated) site users gain access to objects, Apex classes or records. |
| [`sharing-model-opened`](#sharing-model-opened) | High | An object's organization-wide default became more open (e.g. Private to Public Read/Write). |
| [`sharing-model-restricted`](#sharing-model-restricted) | Medium | An object's organization-wide default became more restrictive or changed control. |
| [`sharing-rule-changed`](#sharing-rule-changed) | Medium | A sharing rule was added, widened, narrowed or removed. |
| [`deleted-still-referenced`](#deleted-still-referenced) | High | A deleted field, flow or class is still referenced elsewhere. |
| [`deleted-still-named`](#deleted-still-named) | Medium | A deleted component of any metadata type is still named by other files in the project. |
| [`renamed-still-named`](#renamed-still-named) | Medium | A renamed component's old name is still used by other files in the project. |
| [`validation-rule-removed`](#validation-rule-removed) | Info | A validation rule was removed. |
| [`validation-rule-inactive`](#validation-rule-inactive) | Info | A changed validation rule is inactive. |
| [`flow-inactive`](#flow-inactive) | Info | A changed flow is not active. |
| [`org-only-automation`](#org-only-automation) | Medium | Active automation on an impacted object exists in the org (`--org`) but not in the project. |
| [`agent-metadata-changed`](#agent-metadata-changed) | Info | Agentforce metadata changed that no agent action in the project uses. |
| [`agent-action-affected`](#agent-action-affected) | Medium | The change reaches what an agent action calls or saves. |
| [`agent-action-untested`](#agent-action-untested) | Low | No Testing Center test expects an affected agent action. |
| [`agent-action-target-missing`](#agent-action-target-missing) | Low | An affected agent action calls an Apex class or flow that isn't in the project. |
| [`agent-runtime-access`](#agent-runtime-access) | High | With --org: an affected agent's runtime user lacks access its actions need, is inactive or doesn't exist. |
| [`agent-runtime-overprivileged`](#agent-runtime-overprivileged) | Medium | With --org: an affected agent's runtime user holds broad access such as Modify All Data. |
| [`agent-action-no-confirmation`](#agent-action-no-confirmation) | Medium | An agent action deletes records without asking the user for confirmation. |
| [`legacy-workflow`](#legacy-workflow) | Info | A legacy workflow rule changed. |
| [`field-used-by-lightning`](#field-used-by-lightning) | Low | A changed field is used by Lightning Web Components or Aura components. |
| [`apex-called-from-lightning`](#apex-called-from-lightning) | Low | A changed Apex class is called from Lightning components. |
| [`lightning-missing-reference`](#lightning-missing-reference) | Medium | A changed Lightning component uses a field or Apex class that is not in the project. |
| [`omnistudio-used-by`](#omnistudio-used-by) | Info | A changed Integration Procedure, Data Mapper, OmniScript or FlexCard is used by other OmniStudio components. |
| [`omnistudio-missing-reference`](#omnistudio-missing-reference) | Medium | A changed OmniStudio component calls an Integration Procedure, Data Mapper, Apex class, OmniScript, Lightning component or field that is not in the project. |
| [`omnistudio-remote-not-callable`](#omnistudio-remote-not-callable) | High | An Apex class used by a Remote Action implements neither System.Callable nor VlocityOpenInterface2. |
| [`omnistudio-inactive-in-use`](#omnistudio-inactive-in-use) | Medium | An inactive Integration Procedure, OmniScript, Data Mapper or FlexCard is still called, and no active version is in the project. |
| [`omnistudio-cycle`](#omnistudio-cycle) | Medium | An Integration Procedure or OmniScript calls itself through other procedures or scripts. |
| [`apex-called-from-omnistudio`](#apex-called-from-omnistudio) | Low | A changed Apex class is called by OmniScripts, Integration Procedures or FlexCards. |
| [`picklist-value-removed`](#picklist-value-removed) | Medium | Picklist values were removed or deactivated while record types, formulas, flows or Apex still use them. |
| [`record-type-values-removed`](#record-type-values-removed) | Low | A record type no longer offers picklist values it offered before. |
| [`record-type-deactivated`](#record-type-deactivated) | Low | A record type was deactivated. |
| [`record-type-still-referenced`](#record-type-still-referenced) | Medium | A deleted record type is still named in Apex, flows or formulas. |
| [`label-removed-still-used`](#label-removed-still-used) | High | A custom label was removed but Apex, Visualforce, Lightning or flows still use it. |
| [`cmdt-record-still-referenced`](#cmdt-record-still-referenced) | Medium | A deleted custom metadata record is still named in code that reads its type. |
| [`cmdt-record-changed`](#cmdt-record-changed) | Info | A custom metadata record changed; files that read its type are listed. |
| [`visualforce-missing-reference`](#visualforce-missing-reference) | Medium | A Visualforce page or component names an Apex controller or extension the project does not have. |
| [`apex-used-by-page`](#apex-used-by-page) | Info | An Apex class is the controller or extension of Visualforce pages (high when the class is deleted). |
| [`field-on-page`](#field-on-page) | Info | A changed field is on page layouts or Lightning pages. |
| [`lightning-on-page`](#lightning-on-page) | Info | A changed Lightning component is placed on Lightning pages. |
| [`page-missing-reference`](#page-missing-reference) | Medium | A changed layout or Lightning page uses a field or component that is not in the project. |
| [`page-element-removed`](#page-element-removed) | Low | A changed layout or Lightning page no longer shows fields or components it showed before. |
| [`metadata-not-analyzed`](#metadata-not-analyzed) | Info | A changed component is of a metadata type that is not analyzed in depth. |

## recursion-cycle

**RecursionCycle** · default severity: High

Automation writes lead back to an object already being saved in the same transaction.

Cycles that settle at human pace can recurse, double-apply or hit governor limits at bulk or agent volume. Add recursion guards (a static Set<Id> of processed records, not a static Boolean, which also skips the next 200-record chunk), narrow entry criteria, or move the write to a before-save flow.

## automated-write-vs-validation-rule

**AutomatedWriteVsValidationRule** · default severity: Medium

Automation (or an agent action) writes records that are checked by validation rules.

A correct action can still fail validation. Make sure the automation sets the fields the rule checks, and that failures are surfaced to the caller instead of swallowed.

## field-used-by-validation-rule

**FieldUsedByValidationRule** · default severity: Medium

A changed field is referenced by an active validation rule.

Changing the field's type, values or how it is populated changes which saves the rule blocks. Test the boundary values.

## validation-rule-vs-existing-automation

**ValidationRuleVsExistingAutomation** · default severity: High

A new or changed validation rule applies to existing automation that writes the object.

Every flow, trigger and class that saves the object must now satisfy the rule. Check each writer sets the required fields.

## automated-write-vs-duplicate-rule

**AutomatedWriteVsDuplicateRule** · default severity: Medium

Automation saves records that an active duplicate rule can block, or a duplicate rule now blocks saves that automation makes.

A save that matches an existing record fails. Test the automation with matching data; Apex can set Database.DMLOptions.DuplicateRuleHeader.allowSave, and in any case the error must reach the user.

## save-rule-changed

**SaveRuleChanged** · default severity: Low

An assignment, auto-response, escalation, duplicate or matching rule, or an approval process, was switched on or off, added, removed or reads different fields.

These run as part of saving (or submitting) a record: ownership, emails, escalations, duplicate checks and approval locks change. Check which records they now apply to.

## platform-event-contract

**PlatformEventContract** · default severity: Medium

A platform event or one of its fields changed; publishers and subscribers depend on it.

Subscribers run later in their own transaction, so a mismatch shows up as failed event handling rather than a save error. Change publishers and subscribers together and test one event end to end.

## integration-endpoint-changed

**IntegrationEndpointChanged** · default severity: Medium · security

A named credential, external credential, outbound message, remote site or CSP trusted site now points somewhere else or authenticates differently.

Callouts and messages go to the new host with the same data and credentials, and secrets are set up per org rather than deployed. Confirm the host and test each caller the report lists.

## integration-insecure

**IntegrationInsecure** · default severity: High · security

An integration sends data over plain http, sends a session ID out, or keeps a secret in source control.

Use https everywhere, send session IDs only to services you control, and keep secrets out of metadata (rotate any that were committed).

## integration-allowlist-removed

**IntegrationAllowlistRemoved** · default severity: Medium

A remote site setting or CSP trusted site no longer allows a host that code still calls.

Apex callouts or Lightning requests to that host fail at runtime. Keep the setting, or move the callers to a named credential in the same change.

## connected-app-access

**ConnectedAppAccess** · default severity: Medium · security

A connected app requests more OAuth scopes or accepts new callback URLs.

Full and refresh-token scopes give broad, long-lived access; callback URLs receive authorization codes. Request only the scopes needed and confirm every callback URL is yours and uses https.

## missing-field-reference

**MissingFieldReference** · default severity: Medium

A changed report, report type, list view, email template, quick action, compact layout or field set names a custom field the project's object lacks.

The deployment fails, or the column, filter or merge field breaks, unless the field already exists in the target org. Add the field to the change or fix the name.

## after-save-self-update

**AfterSaveSelfUpdate** · default severity: Medium

An after-save flow updates its own triggering record.

This re-runs the whole save procedure. Use a before-save flow for same-record field updates.

## automation-density

**AutomationDensity** · default severity: Medium

Three or more flows/triggers run on the same object and event.

Overlapping automation is where ordering bugs and race conditions hide. Consolidate where possible and set flow trigger order.

## multiple-triggers

**MultipleTriggers** · default severity: Medium

More than one Apex trigger on the same object.

Salesforce does not guarantee the order between triggers on one object. Use one trigger per object with a handler.

## dml-or-soql-in-loop

**DmlOrSoqlInLoop** · default severity: High

DML or SOQL inside a loop in changed Apex or Apex in the blast radius.

Queries and DML inside loops hit governor limits under bulk load. Query and write collections outside the loop.

## permission-escalation

**PermissionEscalation** · default severity: High · security

A permission set or profile grants Modify All or View All on an object.

These bypass sharing for everyone holding the permission, including agent and integration users. Confirm the scope is intended.

## permission-system

**PermissionSystem** · default severity: High · security

A permission set or profile grants a sensitive system permission (e.g. ModifyAllData).

System permissions have org-wide blast radius. Grant them to as few users as possible.

## permission-delete

**PermissionDelete** · default severity: Medium · security

A permission set or profile grants delete on an object.

Delete access is rarely needed by integration or agent users, and deletes cascade through master-detail children.

## permission-field-edit

**PermissionFieldEdit** · default severity: Low · security

A permission set or profile newly grants edit access to fields.

Review that each newly editable field is needed by the users holding the permission.

## permission-access-removed

**PermissionAccessRemoved** · default severity: Medium

A permission set, profile, permission set group or muting permission set takes access away.

Users who got the access only from there lose it: objects, fields, Apex classes, Visualforce pages, custom permissions or system permissions. The report names Lightning components and pages that need what was removed. Check who holds the access before deploying.

## permission-group-changed

**PermissionGroupChanged** · default severity: Low · security

A permission set group now includes more permission sets.

Everyone assigned the group gets the added access. Check the group's members need it.

## guest-access

**GuestAccess** · default severity: High · security

Guest (unauthenticated) site users gain access to objects, Apex classes or records.

Anyone who reaches the site gets this access without logging in. Grant guests only what public pages need, and share only records meant to be public.

## sharing-model-opened

**SharingModelOpened** · default severity: High · security

An object's organization-wide default became more open (e.g. Private to Public Read/Write).

Every user can now see or edit records they don't own. Check no record holds data some users must not see or change. Large orgs recalculate sharing on deploy.

## sharing-model-restricted

**SharingModelRestricted** · default severity: Medium

An object's organization-wide default became more restrictive or changed control.

Users can lose access to records they don't own, and automation running with the user's sharing may stop finding records. Add sharing rules for who still needs access.

## sharing-rule-changed

**SharingRuleChanged** · default severity: Medium · security

A sharing rule was added, widened, narrowed or removed.

New or wider rules open records to their audience (high when shared with all internal, partner or portal users for edit); removed or reduced rules take access away. Confirm the audience and access level.

## deleted-still-referenced

**DeletedStillReferenced** · default severity: High

A deleted field, flow or class is still referenced elsewhere.

The deployment will fail or the references will break at runtime. Remove or update the references in the same change.

## deleted-still-named

**DeletedStillNamed** · default severity: Medium

A deleted component of any metadata type is still named by other files in the project.

Found by name, not by parsing, so check each listed file. Where it is a real reference, a deployment that includes the file fails, or the reference breaks once the component is gone from the org. Update or remove the references in the same change.

## renamed-still-named

**RenamedStillNamed** · default severity: Medium

A renamed component's old name is still used by other files in the project.

Renaming a metadata file creates a new component and leaves the old one in the org until it is deleted, so the change can work in an existing org and fail in a new one. Update the references in the same change.

## validation-rule-removed

**ValidationRuleRemoved** · default severity: Info

A validation rule was removed.

Data that was previously blocked can now be saved.

## validation-rule-inactive

**ValidationRuleInactive** · default severity: Info

A changed validation rule is inactive.

Inactive rules do not run.

## flow-inactive

**FlowInactive** · default severity: Info

A changed flow is not active.

It will not run until activated.

## org-only-automation

**OrgOnlyAutomation** · default severity: Medium

Active automation on an impacted object exists in the org (`--org`) but not in the project.

Preflight can only follow automation it can read, so the cascade may be incomplete. Retrieve the components into the project; managed-package automation can't be retrieved but still runs, so keep it enabled when testing.

## agent-metadata-changed

**AgentMetadataChanged** · default severity: Info

Agentforce metadata changed that no agent action in the project uses.

Preflight follows agent changes through the actions that use them. Metadata that no agent in the project uses (or that was deleted) can't be followed; check the agents that use it in Agent Builder.

## agent-action-affected

**AgentActionAffected** · default severity: Medium

The change reaches what an agent action calls or saves.

Agents call actions at volume and can't interpret errors the way a person does. Re-run the agent's Testing Center tests, check the action still succeeds with realistic data, and make sure failures are reported back to the agent. High when the action's saves run into an automation cycle.

## agent-action-untested

**AgentActionUntested** · default severity: Low

No Testing Center test expects an affected agent action.

Testing Center checks the decision layer: that the agent picks the right topic and action for a request. Add a test case (an utterance plus the expected topic and action) for every action a change affects.

## agent-action-target-missing

**AgentActionTargetMissing** · default severity: Low

An affected agent action calls an Apex class or flow that isn't in the project.

Preflight can't follow what the action does. Retrieve the class or flow into the project if it only lives in the org.

## agent-runtime-access

**AgentRuntimeAccess** · default severity: High · security

With --org: an affected agent's runtime user lacks access its actions need, is inactive or doesn't exist.

The action fails when the agent runs it. Grant the object access in a permission set assigned to the agent's user, and keep the user active.

## agent-runtime-overprivileged

**AgentRuntimeOverprivileged** · default severity: Medium · security

With --org: an affected agent's runtime user holds broad access such as Modify All Data.

An agent acts on whatever a conversation leads it to. Give its user only the object access its actions need.

## agent-action-no-confirmation

**AgentActionNoConfirmation** · default severity: Medium · security

An agent action deletes records without asking the user for confirmation.

Require confirmation for destructive actions so a misunderstood request can't delete data.

## legacy-workflow

**LegacyWorkflow** · default severity: Info

A legacy workflow rule changed.

Workflow rules are not analyzed yet; consider migrating them to flows.

## field-used-by-lightning

**FieldUsedByLightning** · default severity: Low

A changed field is used by Lightning Web Components or Aura components.

Components read and show the field directly. After changing its type, values or access, check the component and the pages it sits on.

## apex-called-from-lightning

**ApexCalledFromLightning** · default severity: Low

A changed Apex class is called from Lightning components.

Lightning components call Apex from the browser, so a changed signature, result shape or error behaviour reaches users without a flow or trigger in between. Re-test the component.

## lightning-missing-reference

**LightningMissingReference** · default severity: Medium

A changed Lightning component uses a field or Apex class that is not in the project.

Importing a missing field or class fails the deployment. Add it to the project, or make sure it exists in the target org before this change deploys.

## omnistudio-used-by

**OmniStudioUsedBy** · default severity: Info

A changed Integration Procedure, Data Mapper, OmniScript or FlexCard is used by other OmniStudio components.

A changed input, output or response shape reaches them. Run them after deploying.

## omnistudio-missing-reference

**OmniStudioMissingReference** · default severity: Medium

A changed OmniStudio component calls an Integration Procedure, Data Mapper, Apex class, OmniScript, Lightning component or field that is not in the project.

OmniStudio names these in JSON settings, so the deployment does not check them and the script fails when it runs. Add them to the project, or make sure the target org has them.

## omnistudio-remote-not-callable

**OmniStudioRemoteNotCallable** · default severity: High

An Apex class used by a Remote Action implements neither System.Callable nor VlocityOpenInterface2.

OmniStudio calls remote classes through one of those interfaces. Implement System.Callable and dispatch on the method name.

## omnistudio-inactive-in-use

**OmniStudioInactiveInUse** · default severity: Medium

An inactive Integration Procedure, OmniScript, Data Mapper or FlexCard is still called, and no active version is in the project.

Callers fail at run time unless the target org has an active version. Activate it or update the callers.

## omnistudio-cycle

**OmniStudioCycle** · default severity: Medium

An Integration Procedure or OmniScript calls itself through other procedures or scripts.

Unless a condition stops it, it runs until a limit is hit. Check the loop is intended and guarded.

## apex-called-from-omnistudio

**ApexCalledFromOmniStudio** · default severity: Low

A changed Apex class is called by OmniScripts, Integration Procedures or FlexCards.

A changed method name, input or output keys reach their users directly. Run the components that call it.

## picklist-value-removed

**PicklistValueRemoved** · default severity: Medium

Picklist values were removed or deactivated while record types, formulas, flows or Apex still use them.

Records keep the old value, but saves that set it fail or take the wrong branch. Remove it from the record types and replace it in the formulas, flows and code, or keep it active.

## record-type-values-removed

**RecordTypeValuesRemoved** · default severity: Low

A record type no longer offers picklist values it offered before.

Users of that record type can no longer pick them. Existing records keep their values.

## record-type-deactivated

**RecordTypeDeactivated** · default severity: Low

A record type was deactivated.

New records can no longer use it. Flows or Apex that create records of this type may fail.

## record-type-still-referenced

**RecordTypeStillReferenced** · default severity: Medium

A deleted record type is still named in Apex, flows or formulas.

Comparing against a record type by name does not fail the deployment; it quietly stops matching. Update the code, flows and formulas that name it.

## label-removed-still-used

**LabelRemovedStillUsed** · default severity: High

A custom label was removed but Apex, Visualforce, Lightning or flows still use it.

Code that names a missing label fails to compile. Restore the label or update what uses it.

## cmdt-record-still-referenced

**CmdtRecordStillReferenced** · default severity: Medium

A deleted custom metadata record is still named in code that reads its type.

Lookups by the record's name return nothing after the delete. Update the code, or keep the record.

## cmdt-record-changed

**CmdtRecordChanged** · default severity: Info

A custom metadata record changed; files that read its type are listed.

Custom metadata is configuration that code reads at run time. Check the readers behave with the new values.

## visualforce-missing-reference

**VisualforceMissingReference** · default severity: Medium

A Visualforce page or component names an Apex controller or extension the project does not have.

The page cannot be saved without its classes. Deploy them together or fix the name.

## apex-used-by-page

**ApexUsedByPage** · default severity: Info

An Apex class is the controller or extension of Visualforce pages (high when the class is deleted).

Changes to its properties and actions reach users through those pages. A deleted class breaks them.

## field-on-page

**FieldOnPage** · default severity: Info

A changed field is on page layouts or Lightning pages.

A changed label, type or access shows up on those pages. Open one to check it still reads well.

## lightning-on-page

**LightningOnPage** · default severity: Info

A changed Lightning component is placed on Lightning pages.

Open the pages to check the component renders and behaves as intended where it is placed.

## page-missing-reference

**PageMissingReference** · default severity: Medium

A changed layout or Lightning page uses a field or component that is not in the project.

A page that names a missing field or component fails the deployment. Add it to the project, or make sure the target org already has it.

## page-element-removed

**PageElementRemoved** · default severity: Low

A changed layout or Lightning page no longer shows fields or components it showed before.

Users of the page lose them. Confirm that is intended, and that nothing in their process depends on seeing them.

## metadata-not-analyzed

**MetadataNotAnalyzed** · default severity: Info

A changed component is of a metadata type that is not analyzed in depth.

sf-preflight recognizes the type (layouts, Lightning components, page layouts, labels, ...) but only lists it and the files that mention it. Review what depends on it yourself, and turn the rule off in .preflight.json if the noise is not useful.
