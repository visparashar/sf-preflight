# Acting on findings

Each finding has a `rule`, a `severity` and the files involved. Fix the cause, not the report:
don't disable a rule or edit `.preflight.json` to make a finding go away unless the user asks.

| Rule | Severity | What it means | Usual fix |
|---|---|---|---|
| `recursion-cycle` | High | Automation writes lead back to an object already being saved in the same transaction. | Add a recursion guard (a static `Set<Id>` of processed IDs, not a static Boolean, which also skips the next 200-record chunk), narrow flow entry criteria to the fields that matter, or move the write to an async path. Run `check_fix` and the generated bulk test on the guard. |
| `dml-or-soql-in-loop` | High | DML or SOQL inside a loop, which hits governor limits in bulk. | Collect records/IDs in the loop, query and save once outside it. |
| `validation-rule-vs-existing-automation` | High | A new or changed validation rule applies to automation that already writes the object; those saves can now fail. | Make the automation set the required values, or exempt it in the rule's formula; add a test that runs the automation against the rule. |
| `deleted-still-referenced` | High | A deleted field, flow or class is still used elsewhere. | Remove or update the references in the same change, or don't delete it yet. |
| `permission-escalation` | High | Modify All or View All granted on an object. | Grant only the object/field access needed; confirm with the user if broad access is intended. |
| `permission-system` | High | A sensitive system permission (e.g. Modify All Data) is granted. | Remove it unless the user confirms it's required. |
| `guest-access` | High | Guest (unauthenticated) site users gain object, Apex class or record access. | Grant guests only what public pages need; share only records meant to be public. Ask the user before keeping it. |
| `integration-insecure` | High | An integration uses plain http, sends a session ID out, or has a secret in the file. | Switch to https, drop the session ID unless the receiver is yours, remove the secret and ask the user to rotate it. |
| `sharing-model-opened` | High | An organization-wide default became more open (e.g. Private to Public Read/Write). | Confirm every user may see or edit records they don't own; otherwise keep it private and add sharing rules. |
| `agent-runtime-access` | High | With `--org`: an agent's runtime user lacks access its actions need, or is inactive. | Grant the missing object access or Apex class access through a permission set assigned to that user. |
| `ignored-save-result` | Medium | Apex saves with `allOrNone=false` (partial success) and never reads which records failed. | Read the result (`isSuccess`, `getErrors`) and log, retry or surface failures, or drop the `false` so the save fails loudly. |
| `permission-access-removed` | Medium | A permission set, profile, group or muting permission set takes access away; the report names components that need it. | Check who holds the access; keep it, or grant it elsewhere in the same change. |
| `sharing-model-restricted` | Medium | An organization-wide default became more restrictive. | Add sharing rules for users and automation that still need the records. |
| `sharing-rule-changed` | Medium | A sharing rule was added, widened, narrowed or removed (high for all internal/partner/portal users with edit). | Confirm the audience and access level; for removals, check who loses access. |
| `permission-group-changed` | Low | A permission set group now includes more permission sets. | Check the group's members need the added access. |
| `automated-write-vs-duplicate-rule` | Medium | Automation saves records an active duplicate rule can block (high when a changed rule newly blocks existing automation). | Test with data matching an existing record; in Apex set `Database.DMLOptions.DuplicateRuleHeader.allowSave` if saving duplicates is intended; make sure errors reach the user. |
| `platform-event-contract` | Medium | A platform event or its field changed; lists publishers and subscribers (high when deleted). | Update publishers and subscribers in the same change and test one event end to end. |
| `save-rule-changed` | Low | An assignment, auto-response, escalation, duplicate or matching rule, or approval process, changed state or criteria. | Check which records it now applies to and what it does to them (owner, emails, locks). |
| `integration-endpoint-changed` | Medium | A named/external credential, outbound message, remote site or CSP site points to a new host or authenticates differently. | Confirm the host with the user; list the callers to test; remind that secrets are set up per org. |
| `integration-allowlist-removed` | Medium | A remote site or CSP trusted site no longer allows a host code still calls. | Keep the setting or move callers to a named credential in the same change. |
| `connected-app-access` | Medium | A connected app requests more OAuth scopes or new callback URLs (high for Full or http callbacks). | Keep scopes minimal; confirm callback URLs are the user's own and https. |
| `missing-field-reference` | Medium | A changed report, report type, list view, email template, quick action, compact layout or field set names a custom field the project lacks. | Add the field to the change or fix the name; check whether it exists in the target org. |
| `deleted-still-named` | Medium | A deleted component of any metadata type (static resource, named credential, custom permission, tab, value set, ...) is still named by other files. Found by name, not parsed. | Open each listed file: update or remove real references in the same change; ignore matches that are not references. |
| `renamed-still-named` | Medium | A renamed component's old name is still used by other files. The old component stays in the org, so it can work there and fail in a new org. | Update the references to the new name in the same change. |
| `automated-write-vs-validation-rule` | Medium | Automation or an agent action writes records that validation rules check. | Make sure the written values satisfy the rules; test the save path. |
| `field-used-by-validation-rule` | Medium | A changed field is used by an active validation rule. | Check the rule still behaves with the field's new type, values or meaning. |
| `after-save-self-update` | Medium | An after-save flow updates its own triggering record (re-runs the save). | Use a before-save flow for same-record updates. |
| `automation-density` | Medium | Three or more flows/triggers run on the same object and event. | Consider consolidating; order and interaction become hard to reason about. |
| `multiple-triggers` | Medium | More than one Apex trigger on an object (order isn't guaranteed). | Consolidate into one trigger with a handler. |
| `permission-delete` | Medium | Delete access granted on an object. | Confirm it's intended. |
| `org-only-automation` | Medium | With `--org`: active automation on an impacted object exists in the org but not in the project. | Retrieve it into the project so the analysis (and review) sees it. |
| `agent-action-affected` | Medium | The change reaches what an Agentforce action calls or saves. | Re-run the agent's Testing Center tests; check the action still succeeds with realistic data. |
| `agent-runtime-overprivileged` | Medium | With `--org`: an agent's runtime user has broad access. | Reduce it to what the actions need. |
| `agent-action-no-confirmation` | Medium | An agent action deletes records without asking for confirmation. | Require confirmation on the action. |
| `permission-field-edit` | Low | Edit access newly granted to fields. | Confirm it's intended. |
| `agent-action-untested` | Low | No Testing Center test expects an affected agent action. | Add a test case (utterance plus expected topic and action). |
| `agent-action-target-missing` | Low | An agent action calls an Apex class or flow that isn't in the project. | Retrieve it, or check the reference. |
| `validation-rule-removed`, `validation-rule-inactive`, `flow-inactive`, `agent-metadata-changed`, `legacy-workflow` | Info | Context worth mentioning in your summary. | Usually nothing to fix. |
| `field-used-by-lightning`, `apex-called-from-lightning` | Low | Lightning Web Components or Aura components use the changed field, or call the changed Apex class from the browser. | Re-test those components and the pages they sit on. |
| `lightning-missing-reference` | Medium | A changed Lightning component imports a field or Apex class that is not in the project. | Add it to the project, or make sure the target org already has it. |
| `omnistudio-used-by`, `apex-called-from-omnistudio` | Info / Low | OmniScripts, Integration Procedures or FlexCards use the changed OmniStudio component or Apex class. | Run them after deploying; check inputs and outputs still match. |
| `omnistudio-missing-reference` | Medium | A changed OmniStudio component calls something not in the project (procedure, Data Mapper, class, script, component or field). The deployment does not check these. | Add it to the project, or make sure the target org has it. |
| `omnistudio-remote-not-callable` | High | A Remote Action's Apex class implements neither `System.Callable` nor `VlocityOpenInterface2`. | Implement `System.Callable` and dispatch on the method name. |
| `omnistudio-inactive-in-use` | Medium | An inactive OmniStudio component is still called and no active version is in the project. | Activate it, or update the callers. |
| `omnistudio-cycle` | Medium | A procedure or script calls itself through others. | Make sure a condition ends the loop. |
| `label-removed-still-used` | High | A custom label was removed but Apex, Visualforce, Lightning or flows still use it. | Restore the label or update what uses it. |
| `cmdt-record-still-referenced` | Medium | A deleted custom metadata record is still named in code that reads its type. | Update the code or keep the record. |
| `cmdt-record-changed` | Info | A custom metadata record changed; files that read its type are listed. | Check the readers behave with the new values. |
| `visualforce-missing-reference` | Medium | A Visualforce page or component names an Apex controller or extension the project lacks. | Deploy the classes together or fix the name. |
| `apex-used-by-page` | Info (High if deleted) | An Apex class is the controller or extension of Visualforce pages. | Check the pages; a deleted class breaks them. |
| `picklist-value-removed` | Medium | Picklist values were removed or deactivated while record types, formulas, flows or Apex still use them (Low if nothing does). | Remove them from the record types and replace them in the code, or keep them active. |
| `record-type-values-removed`, `record-type-deactivated` | Low | A record type no longer offers picklist values, or was deactivated. | Check who creates or edits records of that type. |
| `record-type-still-referenced` | Medium | A deleted record type is still named in Apex, flows or formulas. | Update what names it; the comparison will quietly stop matching. |
| `field-on-page`, `lightning-on-page` | Info | A changed field is on layouts or Lightning pages, or a changed component is placed on Lightning pages. | Open one of the pages to check it still reads and behaves well. |
| `page-missing-reference` | Medium | A changed layout or Lightning page names a field or component that is not in the project. | Add it to the project, or make sure the target org already has it. |
| `page-element-removed` | Low | A changed layout or Lightning page no longer shows fields or components it did before. | Confirm that is intended. |
| `metadata-not-analyzed` | Info | A changed component is of a metadata type sf-preflight only lists (layout, Lightning component, flexipage, label, ...). The report shows which project files mention it. | Check those files yourself: the analysis did not cover what this change affects. |

Full explanations: https://github.com/visparashar/sf-preflight/blob/main/docs/RULES.md
