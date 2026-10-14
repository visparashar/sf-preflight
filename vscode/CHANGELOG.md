# Changelog

## [Unreleased]

## [0.6.1] - 2026-10-14

The analysis of sf-preflight 0.13.0, and a Review tab:

- **Legacy workflow rules** are parsed: where they run in the save order, the fields they read and write, and
  changes to a rule are reported.
- **Cascade deletes** (master-detail and cascade-delete lookups) appear in the save order of a delete.
- **Flow trigger order**: record-triggered flows on one object are placed in their real run order.
- **Before-save flows** show the fields they set, which feeds the validation-rule and recursion findings.
- New finding `ignored-save-result`: `Database.insert/update/...` with `allOrNone=false` whose result is never
  checked.
- Clearer advice on recursion cycles.
- **Review tab** (`sf-preflight: Review findings and fixes`, or the checklist button in the sidebar): a wide
  editor tab with the findings on the left, the selected finding in the middle, and what runs when its object is
  saved on the right. Fixes show as a diff before they are applied, **Apply safe fixes** applies every safe fix
  that touches its own file in one edit, and a finding can be accepted as known, opened, or sent to test
  generation from the same place. Filter by severity, risk factor or "has a fix"; arrow keys move through the
  list. The dashboard has a **Review & fix** button.

## [0.6.0] - 2026-10-13

- **Fix it**: when a problem has a checked fix (see `preflight fix`), it is the first quick fix in the light
  bulb. Safe fixes apply directly; fixes that undo part of the change or should be read open VS Code's preview
  first. A fix is never applied to a file that changed since it was checked.
- **Update notification**: when a newer sf-preflight is out, a notification offers **Update** (opens the
  extension's page), **What's new** and **Skip this version**. Checked at most once a day against Open VSX (only
  the version number is requested). Off with `sfPreflight.checkForUpdates`.
- **OmniStudio**: findings for OmniScripts, Integration Procedures, Data Mappers and FlexCards, an OmniStudio
  factor on the risk dashboard, and CodeLens above their files (who uses it, what it calls, what it saves).
- **Quick fixes** (the light bulb) on sf-preflight problems: open the other files involved; generate Apex tests
  for recursion, validation-rule and loop findings; accept a finding about the org's state as a known issue,
  which adds it to `.preflight-baseline.json` (and sets `"baseline"` in `.preflight.json` the first time) so it
  stops being reported, in the editor, the hook and CI alike.
- **Faster analysis while typing**: the analysis worker stays up between runs instead of starting for each one,
  so the analyzer and its parse cache are already loaded. On NPSP, analyzing again after an edit takes about
  0.6 s instead of 1.2 s. An idle worker stops after five minutes.
- The extension no longer throws away the command line's parse cache (or the other way round), which cost
  about 28 s on NPSP each time you switched between them.

## [0.5.0] - 2026-10-13

- **As you type**: unsaved edits are analyzed after a short pause (`sfPreflight.analyzeOnType`), so findings
  show up while writing, not only after saving.
- **Precise underlines**: a problem is underlined on the field, rule or class its finding names, or on the
  statement's line for Apex findings, instead of the first line of the file.
- **CodeLens** above field, object, validation rule, trigger, class, flow and Lightning component files: who uses
  it and what runs when its object is saved (`sfPreflight.codeLens`).
- Brings sf-preflight 0.11.0's analysis: baseline mode (only what a change introduces, from `.preflight.json`),
  `--staged` and the property-based fuzzing fixes.

## [0.4.0] - 2026-10-09

- **Risk dashboard**: the change's risk, the quality gate's findings check, and its risk factors
  (recursion, rule collisions, access and sharing, broken references, Agentforce, integrations, code
  and automation load), each with a count, its worst finding and what it means. Click a factor to
  list its findings and open them. **Where the risk sits** ranks the impacted objects by their
  findings, the recursion cycles they're on and the automation that runs on save. The **trend** shows
  high, medium and low findings over the branch's recent analyses (a bar each time the result
  changes), kept per project and branch in VS Code's storage on your computer. Opens from the status
  bar, the dashboard button on the Blast radius view, or **sf-preflight: Show risk dashboard**.

- **Open report in the web viewer**: saves the current analysis as `preflight.json` and opens the
  [report viewer](https://sf-preflight-web.vercel.app/) in your browser, for reviewers who don't use
  VS Code. The file is read in the browser and never uploaded. `sfPreflight.viewerUrl` points it at
  a self-hosted copy.

- The status bar now opens the risk dashboard.

## [0.3.0] - 2026-10-10

- Brings the analysis of sf-preflight 0.10.0 into the editor: a reference check for every metadata type
  (deletions, renames and `destructiveChanges.xml`), access and sharing (permissions taken away, guest access,
  organization-wide defaults, sharing rules, permission set groups), the save path (duplicate, assignment,
  auto-response and escalation rules, platform events), integrations (named credentials, remote and CSP sites,
  connected apps, outbound messages) and reports, list views, email templates and other metadata that name fields.
- Fields from other managed packages (`ns__Field__c`) are no longer reported as missing.

## [0.2.0] - 2026-10-09

- **New extension ID: `visparashar.sf-preflight-vscode`** (the name `sf-preflight` is taken on the
  VS Code Marketplace). On Open VSX, install it in place of `visparashar.sf-preflight` 0.1.0, which
  is deprecated. Settings (`sfPreflight.*`) and commands are unchanged.

- **Blast radius graph**: the change at the centre and what it sets off around it, one ring per
  hop: the objects it saves, the flows, triggers, validation rules and roll-ups that run, what
  references it, and the Agentforce actions it reaches. Nodes are coloured by their worst finding
  (impacted, collision, high risk), automation cycles are drawn as recursion arrows, and hovering
  a node lists its findings. Click a node to open its file. Opens from the graph button on the
  Blast radius view, the risk line in it, or **sf-preflight: Show blast-radius graph**, and
  follows every re-analysis. Several changes gather round a hub. Large graphs keep the 80
  nearest and riskiest nodes.

- **Click the legend to highlight**: in the blast radius graph, click *changed*, *impacted*, *collision*, *high risk* or *recursion* to keep those nodes (and the edges between them) in focus and fade the rest. Pick several kinds at once; click again or press Esc to clear. Each kind shows how many nodes it has, and kinds with none are greyed out. The choice stays when the graph updates.

- **Wider analysis (bundled library 0.8.0)**: Lightning Web Components and Aura appear in the graph as their own *LIGHTNING* nodes; the Blast radius view shows each change's metadata type and how many changes were analyzed in depth; layouts, Lightning pages, picklists and record types, custom labels, custom metadata and Visualforce are now followed. Large projects analyze faster (parse cache and parallel parsing).

## [0.1.0]

First release.

- Findings in the Problems panel on the files they're about, linked to the rule's explanation.
- The **Blast radius** view: risk, findings, changed components, what runs on each impacted object
  in order of execution, automation cycles and affected Agentforce actions.
- Analyzes again a moment after Salesforce metadata changes (saves, branch switches, pulls,
  retrieves), one run per project at a time and at most two projects at once; compares with your
  default branch from where your branch left it, or a branch you choose per workspace folder.
- Commands: show the full report, explain what runs when an object is saved, generate Apex tests
  for the change, install the agent skill.
- Offers the sf-preflight MCP server to agent mode (GitHub Copilot and other agents) in editors
  that support MCP server providers (VS Code 1.101+).
- Needs a trusted workspace. Writes generated tests and the agent skill only inside the project,
  never through symbolic links. Ships the licences of the libraries it bundles.
