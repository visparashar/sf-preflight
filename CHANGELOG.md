# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Fixes as suggested changes on pull requests**: the GitHub Action's `suggest-fixes: true` posts checked fixes as
  suggested changes the author applies with one click (`suggest-fix-kinds`, default `safe,undo`). Only a fix that
  edits one file, on lines the pull request changed and that are still as analyzed, is suggested; each fix is posted
  once. `preflight fix --suggestions-out <file>` writes the same suggestions as JSON, and `--config-ref` reads the
  policy from the base branch as `analyze` does.
- **Checked fixes**: `preflight fix` proposes edits for findings with a mechanical fix and checks each one
  by analyzing the change again with it applied; a fix is kept only if its finding is gone and no new high or
  medium finding appears. `--apply` writes the safe ones (`--kinds`, `--only <id>` for more); a file that changed
  since it was checked is never overwritten.
  - safe: `http` → `https` for named credentials, remote sites, CSP sites and outbound messages (protocol
    security back on); a committed consumer secret removed; confirmation required on agent actions that delete.
  - undo: View All / Modify All, delete, system permissions and new field edit access taken back; a sharing
    default restored; removed picklist values restored in their original place.
  - review: references to a renamed component's old name updated; an outbound message's session ID stopped; a Remote Action class made `System.Callable`, with a `call` method
    that runs the methods the scripts name; `update`/`insert`/`delete` of a loop variable moved to one save after
    the loop (only in the plain shape: no `return`, `try` or later use of the record).
  - `suggest_fixes` MCP tool: the same checked diffs for coding agents (it writes nothing).
  - `check_fix` MCP tool: runs the same check on an edit an agent wrote itself ("fix with AI"), so a fix
    for a finding without a built-in fix is verified before it is written. sf-preflight makes no model
    calls of its own.

- **Update notice**: when a newer release is on npm, a short banner after a command says so, with the update
  command for how sf-preflight was started (`npx`, project or global install). Checked at most once a day by
  a detached process, so commands never wait; shown at most once a day, only in an interactive terminal (not in
  CI, hooks, the agent hook or the MCP server). Only the latest version number is requested. Off with
  `PREFLIGHT_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1`.

- **OmniStudio** (standard runtime: OmniScripts, Integration Procedures, Data Mappers, FlexCards). Their
  references sit in JSON settings that deployments don't check, so a broken one fails only when a user runs it.
  sf-preflight now reads them:
  - Remote Actions, Data Mapper actions (and pre/post transform Data Mappers), Integration Procedure actions,
    embedded OmniScripts, custom Lightning components and HTTP actions' named credentials, including inside
    blocks; FlexCard data sources and child cards; the objects and fields Data Mapper Extracts read and Loads
    write.
  - New findings: `omnistudio-used-by`, `omnistudio-missing-reference`, `omnistudio-remote-not-callable` (a Remote
    Action class without `System.Callable` or `VlocityOpenInterface2`, directly or through its parent class),
    `omnistudio-inactive-in-use`, `omnistudio-cycle` and `apex-called-from-omnistudio`.
  - A deleted Data Mapper, procedure, script or card that is still used is `deleted-still-referenced`, unless
    another version remains; so is a deleted Apex class or field they use.
  - Data Mapper Loads count as writers of their objects: a new validation rule lists them, and a changed
    procedure's saves (through Data Mappers and Remote Action classes, and nested procedures) feed the save
    procedure analysis.
  - The older managed-package format (Vlocity DataPacks) is not read.

- `acceptIntoBaseline`: add one finding to the project's baseline file (the VS Code quick fix uses it).

### Changed

- Faster on large projects, most of all when analyzing again after a small edit. On NPSP, one edited class
  analyzed with `--baseline base` went from 1.6 s to 0.85 s:
  - The parse cache checks a file's size and modification time before reading it, and reads and hashes it
    only when they changed. Files modified within the last two seconds are always checked by content, so a
    same-size edit is never missed.
  - Each Apex file is read and hashed once per run, not twice.
  - The comment-free copy of each class's source is made only when a check needs it.
  - A long-running process (the editor extension) keeps the parse cache in memory between runs.
- The command line and the VS Code extension keep separate parse caches. They were sharing one file and,
  being built differently, each threw the other's away: about 28 s to rebuild on NPSP at every switch. A
  project's caches for other versions are removed after 14 days unused.

## [0.11.0] - 2026-10-13

### Added

- `preflight agent-hook`: a Claude Code PostToolUse hook. After the agent edits Salesforce metadata, it reports
  what that edit introduces (compared with `HEAD`) back to the agent, which fixes it in the same turn.
  `preflight agent-hook install` adds it to `.claude/settings.json`. See
  [docs/AI_AGENTS.md](docs/AI_AGENTS.md#4-check-every-edit-automatically-claude-code-hook).
- Analyses accept unsaved editor text (`overlay` in the API): the VS Code extension now checks while you type.
- `insightFor`: who uses a component and what runs when its object is saved, for editors (the extension's
  CodeLens).
- `preflight hook install`: a git pre-commit hook that checks the staged Salesforce metadata on every commit and
  blocks it when a finding reaches the threshold (the policy's, else high). Commits without metadata are not
  slowed down; `--no-verify` or `PREFLIGHT_SKIP=1` skips it. Works with Husky, lefthook and pre-commit. See
  [docs/HOOKS.md](docs/HOOKS.md).
- `preflight analyze --staged` (and the other analysis commands): analyze what is staged, against `HEAD`.
- Baseline mode: report only the findings a change introduces. `"baseline": "base"` in `.preflight.json` (or
  `--baseline base`) analyzes the changed components at the base ref too and hides what was already there;
  `preflight baseline` writes a reviewed list of accepted findings to commit and point the policy at. Only
  findings about the org's state (cycles, DML in loops, untested agent actions, ...) can be hidden; findings
  about the change itself are always shown. The pre-commit hook uses `"base"` by default (`--all` shows
  everything). See [docs/CONFIG.md](docs/CONFIG.md#baseline-only-new-findings).

### Changed

- Releases carry the npm tarball or `.vsix` with a signed build provenance bundle (`*.sigstore.json`), verifiable
  with `gh attestation verify` (see SECURITY.md).
- Property-based tests (fast-check) fuzz the code that reads untrusted input. They found that a component name
  ending in any `__x` suffix was matched anywhere as if it were a custom object or field; only Salesforce's own
  suffixes (`__c`, `__e`, `__mdt`, ...) are now.

### Security

- The VS Code extension's publishing tool (ovsx) no longer pulls a vulnerable `braces` through an old `vsce`
  (GHSA-vfj7-8cjw-p6xm); it uses the same, patched `vsce` as the build.

## [0.10.1] - 2026-10-09

### Added

- The report viewer links to the VS Code extension. Its landing page explains opening a saved report from the editor with **sf-preflight: Open report in the web viewer**.

## [0.10.0] - 2026-10-10

### Added

- Reports, report types, list views, email templates (merge fields), quick actions, compact layouts and field sets
  count as field references, so deleting or renaming a field they name is caught. A changed one that names a
  custom field the project's object lacks is flagged (`missing-field-reference`).
- Integrations are analyzed in depth, each change compared with the base version:
  - Named credentials that move to another host, authenticate differently or use plain http, with the Apex and
    flows that call them; external credentials whose authentication changes, with the named credentials using
    them (`integration-endpoint-changed`, `integration-insecure`).
  - Remote site settings and CSP trusted sites that are deleted, deactivated or moved while code still calls the
    host (`integration-allowlist-removed`), that newly allow a host, or that turn off protocol security.
  - Connected apps that request more OAuth scopes (high for Full) or accept new callback URLs, and consumer
    secrets committed to source control (`connected-app-access`).
  - Outbound messages in workflow files that send a session ID, post over http or move host; the fields they send
    count as references.
- The save path covers more of Salesforce's order of execution:
  - Duplicate rules (after validation rules) and assignment, auto-response and escalation rules (after the
    after-save triggers) appear in `preflight explain` and the report's order-of-execution tables.
  - Fields read by these rules, matching rules and approval processes count as references, so changing or
    deleting such a field is caught.
  - `automated-write-vs-duplicate-rule`: automation saves records that an active duplicate rule can block,
    or a changed duplicate rule now blocks saves that automation makes (high).
  - `save-rule-changed`: assignment, auto-response, escalation, duplicate and matching rules and approval
    processes switched on or off, added, removed, or reading different fields.
  - Platform events: a changed or deleted event or event field lists its publishers (Apex, flows) and
    subscribers (triggers, platform-event flows, Lightning components on the Emp API)
    (`platform-event-contract`). The cascade stops at a published event, since subscribers run later in their
    own transaction, instead of treating them as part of the same save.
- A report viewer (`web/`): a static site that opens a JSON report or an evidence pack in the browser, with the
  risk, quality gate, findings, the blast-radius graph from the VS Code extension, order of execution, cascade,
  affected Agentforce actions, tests to run, org context and authorship. Evidence packs get their digest checked
  in the browser (the same check as `preflight evidence --verify`). Opens GitHub Actions artifact zips, pasted JSON
  and links (`?url=`), copies the CLI's Markdown, and prints cleanly. Files are never uploaded. Ships with
  settings for Vercel and Netlify.
- A reference check for every metadata type. When a component is deleted, the files that still name it are
  flagged (`deleted-still-named`), for the types without a precise check of their own: static resources,
  named credentials, custom permissions, tabs, apps, value sets, quick actions, email templates, layouts,
  custom objects and the rest. Matching uses each type's own reference syntax (`$Resource.X`,
  `callout:X`, `$Permission.X`, `<valueSetName>`, ...) and, for distinctive names, XML values and quoted
  strings, so common words don't match.
- Renames: when a component of any type is renamed, files that still use the old name are flagged
  (`renamed-still-named`). The old component stays in the org, so this works in one org and fails in a new one.
- Access changes are analyzed in depth:
  - Access taken away by a permission set or profile (objects, fields, Apex classes, Visualforce pages, custom
    permissions, system permissions), naming the Lightning components and pages that use it
    (`permission-access-removed`).
  - Guest user profiles (by their Guest User License) and guest sharing rules that expose objects, classes or
    records to unauthenticated visitors (`guest-access`).
  - Organization-wide defaults that open up (`sharing-model-opened`) or tighten (`sharing-model-restricted`).
  - Sharing rules added, widened, re-scoped, reduced or removed, rated by audience and access level
    (`sharing-rule-changed`).
  - Permission set groups that gain permission sets with Modify All, View All or system permissions, drop sets or
    add mutes, and muting permission sets that mute more (`permission-group-changed`). Escalations in a
    permission set also name the groups that carry it to users.
- Destructive manifests: components listed in a changed `destructiveChanges.xml` (or `...Pre`/`...Post`) are
  checked like deleted files, including fields, classes and flows, even when the manifest sits outside the
  package directories.

### Fixed

- Layouts, Lightning pages and Lightning components no longer report fields from other managed packages
  (`ns__Field__c`) as missing from the project.

## [0.9.1] - 2026-10-09

### Fixed

- Release 0.9.0 was never published: its release run failed because the tests that run the built CLI executed before
  the build. They now build it when it is missing. 0.9.1 contains everything listed under 0.9.0.

## [0.9.0] - 2026-10-09

### Added

- `preflight monitor` watches a production org's Setup Audit Trail (read-only) and alerts on risky changes made
  directly in the org: validation rules and flows switched off, broad permissions, Apex, sharing and security
  settings. It can skip a deployment user, remember what it has reported, and post to the same Slack, Teams or
  webhook as `preflight notify`. See [docs/MONITOR.md](docs/MONITOR.md).
- `preflight notify` sends a short risk alert to Slack, Microsoft Teams or any JSON webhook from a saved
  report. The GitHub Action gets `notify-webhook`, `notify-on` and `notify-on-update` inputs. The message
  leaves out PR titles and branch names, cleans repository text, accepts only public `https` URLs, and a
  failed send never fails the check.
- `sf preflight monitor` in the sf CLI plugin, and a [demos page](https://visparashar.github.io/sf-preflight/demos.html) with one short video per feature.

### Fixed

- `monitor` no longer reports any entry in the "Manage Users" section (such as Login-As) as a broad permission.

## [0.8.0] - 2026-10-09

### Added

- Custom labels, custom metadata records and Visualforce are analyzed in depth. A removed label
  that Apex, pages, Lightning or flows still use is High. A changed custom metadata record lists
  the files that read its type, and a deleted one is searched for by name. A Visualforce page
  that names a missing controller is flagged, and a changed or deleted Apex class lists the pages
  that use it as controller or extension.
- A Salesforce CLI plugin, `sf-plugin-preflight` (in `sf-plugin/`): `sf preflight analyze`, `tests`,
  `agents`, `agent-tests`, `incidents`, `rollback`, `explain` and `evidence`. It runs this CLI, so
  results match, and maps `--target-org` and `--json` onto it.
- Picklist values and record types. Removing or deactivating a picklist value lists the record
  types that still offer it and the Apex, flows, validation rules and formulas that write it as
  text (only in files that also name the field). A changed record type reports values it no
  longer offers and deactivation; a deleted one is searched for in code.
- Page layouts and Lightning pages (flexipages) are analyzed in depth. A changed field lists the
  layouts and record pages that show it (`field-on-page`); deleting a field a layout still shows,
  or a component a page still places, is `deleted-still-referenced`; a changed component lists
  the pages it sits on (`lightning-on-page`); a changed layout or page is checked for fields and
  components the project does not have (`page-missing-reference`) and compared with the base for
  what it no longer shows (`page-element-removed`).
- Lightning Web Components and Aura components are analyzed in depth. Each bundle is read for the
  Apex methods it calls, the fields it imports (`@salesforce/schema/...`), its labels and the
  components it embeds. A changed field lists the components that use it
  (`field-used-by-lightning`); a changed Apex class lists the components that call it
  (`apex-called-from-lightning`); a changed component follows the records it saves through the
  Apex it calls into the usual save-order cascade and is checked for fields and classes the
  project does not have (`lightning-missing-reference`); deleting a class or component that
  others use is `deleted-still-referenced`. The VS Code graph shows Lightning components as their
  own node kind.
- Coverage: every Salesforce metadata type (512 file suffixes, from Salesforce's metadata
  registry) is now recognized instead of silently ignored. Changed layouts, Lightning components,
  flexipages, labels, custom metadata and the rest appear in the changed components with their
  metadata type, raise an info finding (`metadata-not-analyzed`, can be turned off), and the
  report says "Analyzed in depth: N of M changed components" and lists the project files that
  mention each one. The JSON result has a new `coverage` field. Types without their own analysis
  are still reported by name only.
- Parallel parsing: when 150 or more Apex files need parsing (a first run, or after the object
  list changes), they are parsed on worker threads, one per CPU (at most 8). Set `PREFLIGHT_JOBS=1`
  to parse on one thread. Output is identical. Gain depends on the machine: on a 2-core test
  machine NPSP's first run went from 27 s to 23 s, because each thread warms up the parser's lookup
  tables itself.
- Parse cache: Apex parse results are cached on disk (`~/.cache/sf-preflight`, or
  `PREFLIGHT_CACHE_DIR`), keyed by each file's content, so only changed classes are parsed again.
  On NPSP (1,044 classes) an analysis drops from about 28 s to 1.4 s, and a 2,700-class project
  from 54 s to 4 s, with identical output. The first run is as slow as before. The cache holds
  analysis facts (method names, field references), not source, is readable only by you, and is
  dropped when the analyzer changes or the project's objects change. Turn it off with
  `PREFLIGHT_NO_CACHE=1`.
- The VS Code extension (`vscode/`, released separately as `extension-vX.Y.Z`): findings in the
  Problems panel, the blast-radius view, analysis on change, test generation, save order, the
  agent skill and the MCP tools for agent mode. See [vscode/README.md](vscode/README.md).
- Extension 0.2.0: the blast radius graph, with the change at the centre and what it sets off
  around it by distance, coloured by risk, with recursion drawn; click a node to open its file.

### Changed

- A git-based analysis only counts changes inside the project's package directories (from
  `sfdx-project.json`): files elsewhere in the project, such as generated tests in
  `preflight-tests/`, aren't deployed, so they're listed as ignored instead. Files named with
  `--files` are analyzed as before.
- `preflight skill install` refuses to copy through a symbolic link in `.agents` or `.claude`,
  so a committed link can't redirect it outside the project.

## [0.7.0] - 2026-10-06

sf-preflight for AI coding agents of any kind: an agent skill in the open Agent Skills format,
`preflight skill install`, and a Claude Code plugin.

### Added

- The `sf-preflight` agent skill (open [Agent Skills](https://agentskills.io) format): tells any
  AI coding agent when to check a Salesforce change, how to act on findings, how to generate
  tests and handle production errors, and the rules it must keep (never deploy, never pass
  `--allow-production`, no credentials). Works with Codex, GitHub Copilot, Cursor, Gemini CLI,
  Claude and other Agent Skills clients. It ships in the npm package; `preflight skill install`
  copies it to `.agents/skills/` and `.claude/skills/` (`--global`, `--dir`, `--force`).
- A Claude Code plugin and marketplace in the repository: the skill, the MCP server, and a hook
  that analyzes each Salesforce metadata edit and tells Claude about high and medium findings.
- [docs/AI_AGENTS.md](docs/AI_AGENTS.md): setup for each agent (skill locations, MCP
  configuration for Claude Code, Codex, Copilot/VS Code, Cursor, Gemini CLI and others) and an
  `AGENTS.md` snippet for agents without skills.

## [0.6.0] - 2026-10-06

The production feedback loop (M7): trace production errors to the change that caused them and
plan a partial rollback. Also runs the Agentforce Testing Center tests that cover a change.

### Added

- `preflight incidents` (M7): reads production errors from an org, read-only (failed flow
  interviews, unhandled Apex exceptions from the event log, failed asynchronous Apex, and
  Agentforce action errors from Data 360 session tracing in beta), or imports them from a JSON
  file, and traces each one to the merged change most likely to have caused it. Evidence: the
  change touched the failing component or its call stack, the error is the message of a
  validation rule it added or changed or names a field it changed, the failing component is in
  its blast radius, or preflight's findings predicted the failure; weighed by when the change was
  merged and when its components changed in the org, claiming a start time only when the errors
  clearly began inside the data read. Messages are reduced to metadata and never stored.
- `preflight rollback <commit>` and MCP `plan_rollback`: a partial rollback of the components you
  name, restoring all their files as they were before the change, deactivating what the change
  added or renamed (validation rules, triggers, and flows through a FlowDefinition), pointing to
  Setup's Deleted Fields for deleted fields, bringing along what keeps it consistent, and warning
  about later commits it would undo. `--restore` applies it to the working tree, unstaged, for a
  rollback pull request.
- `preflight agent-tests` runs the Agentforce Testing Center tests that cover a change (tests of
  affected agents that expect an affected action or its topic; `--all` or `--test` to choose), in
  an org the change is deployed to, and reports each test case and the expectation that didn't
  match. Testing Center and Agentforce Studio tests both work. Production orgs are refused unless
  `--allow-production`. Reports show expected and actual topics and actions, never the agent's
  responses, which can contain record data.
- Quality gate setting `requireAgentTestsPassed` with `--agent-tests-result <file>`: the Testing
  Center tests covering the change must have run and passed. The result records a fingerprint of
  the change it was run for, so a result from another change, or one that leaves out a covering
  test, fails the check.
- The evidence pack records Testing Center runs (`tests.agentTests`).

### Changed

- `--wait` options take a whole number of minutes and reject values such as `5.9` or `10m`
  instead of truncating them.
- The npm package now includes a `NOTICE` file, as the Apache License 2.0 expects.

### Security

- The GitHub Action pins every action it uses to a full commit SHA, so a moved tag upstream
  can't change what runs in your workflow.

## [0.5.0] - 2026-10-06

Quality gates, an evidence pack per change, and pipeline integration (GitHub, GitLab, Azure
DevOps, Jenkins, Bitbucket, DevOps Center).

### Added

- **Policy file:** `.preflight.json` (in the project or at the repository root) changes rule
  severities, turns rules off and ignores paths. Unknown settings are errors. A JSON schema is
  published for editor support. `--config-ref <ref>` reads it from git at a ref (for example the
  pull request's base), so a change can't loosen the policy it's checked against. See
  [docs/CONFIG.md](docs/CONFIG.md).
- **Quality gate:** `preflight analyze --gate` evaluates findings against a severity threshold,
  approvals for AI-assisted changes (`--approvals`), Testing Center coverage of affected agent
  actions, and generated tests that passed in an org (`--tests-result`); exit code 2 when it
  fails. The report starts with the gate's checks, and the MCP tool `analyze_change` includes it.
- **Evidence pack:** `preflight evidence` and `analyze --evidence-out` write a JSON record of the
  change (base/head SHAs, the pull request, file digests, human/AI authorship), findings,
  affected agent actions, tests and their results, approvals, the gate decision and the policy
  used, with a SHA-256 digest over its canonical JSON that detects accidental changes;
  `preflight evidence --verify` checks it. See [docs/EVIDENCE.md](docs/EVIDENCE.md).
- **JUnit output** (`--format junit`, `--junit-out`) for GitLab, Azure DevOps, Jenkins, Bitbucket
  and other CI systems, and [docs/PIPELINES.md](docs/PIPELINES.md) with setups for them and for
  DevOps Center.
- **GitHub Action:** evaluates the quality gate with the pull request's approvals (also on
  `pull_request_review` events, and for pushes from the merged pull request). An approval counts
  when it's from someone who can write to the repository and didn't write the change, and
  approves the latest commit. On pull requests the policy is read from the base branch
  (`policy-from-base`). Uploads the evidence pack as an artifact (`evidence`, `artifact-name`),
  and can sign it with a GitHub artifact attestation (`attest`; skipped with a warning on fork
  pull requests). New inputs `config`, `policy-from-base`; new outputs `gate`, `evidence`,
  `evidence-digest`, `attestation-url`.

### Changed

- GitHub Action: the check fails when the quality gate fails. Without a `.preflight.json` the
  gate fails on high findings, as before. `fail-on` now defaults to the policy file's
  `gate.failOn` (else `high`).

## [0.4.0] - 2026-10-06

Agentforce action verification: which agent actions a change reaches, whether Testing Center
covers them, and whether the agent's user can run them.

### Added

- **Agentforce action verification:** preflight reads agents from source, both Agent Builder
  metadata (bots, planner bundles, topics, actions) and Agent Script (`.agent` files), plus
  Testing Center test definitions. Every analysis reports the agent actions a change reaches,
  through the Apex class or flow they call and the save procedures that follow, in new findings
  (`agent-action-affected`, `agent-action-untested`, `agent-action-no-confirmation`,
  `agent-action-target-missing`) and an "Agent actions" table. Changing agent metadata roots the
  cascade at what its actions save. Deleting a class or flow an action calls is reported as
  `deleted-still-referenced`. See [docs/AGENTS.md](docs/AGENTS.md).
- Runtime-user access: each affected action lists the access its user needs (flows run as the
  user; Apex needs class access, and object access only in user mode). With `--org`, the agent's
  runtime user is checked for missing access, inactivity and broad permissions
  (`agent-runtime-access`, `agent-runtime-overprivileged`). The user is never named in reports.
- `preflight agents [agent]` lists agents or explains one; MCP tool `explain_agent` does the same
  for coding agents.
- Suggested tests include `sf agent test run` commands for Testing Center tests that cover
  affected actions, test cases to add, and a runtime-user permission test.

### Changed

- `agent-metadata-changed` (info) is now only reported for agent metadata that no agent action in
  the project uses.

## [0.3.0] - 2026-10-05

Generated Apex tests for every change, and a way to run them in a sandbox. Verified against a
real Developer Edition org with Person Accounts.

### Added

- **Test generation:** `preflight tests` writes Apex tests for what a change touches: bulk saves
  of 200 records for each affected object and event, recursion along cross-object automation
  cycles, idempotency of after-save flows that update their own record and create related
  records, and invocable actions surfacing (not swallowing) validation errors. Tests use a
  generated, describe-driven data factory (`PreflightDataFactory`) that fills required fields at
  run time; the values a test needs are solved from flow entry criteria and validation-rule
  formulas. Anything not generated is listed with the reason, and the summary prints the
  check-only `sf project deploy validate` command to run them. See
  [docs/TESTS.md](docs/TESTS.md).
- `preflight tests --validate --org <alias>` runs the generated tests in a sandbox, scratch org or
  Developer Edition org with a check-only deployment (nothing is saved) and reports each test's
  outcome, compile errors and coverage problems; exit code 2 when anything fails. Production orgs
  are refused unless `--allow-production` is passed.
- MCP tool `generate_tests` returns the same tests as code for coding agents (read-only; nothing
  is written to disk).
- `runTests()`, `generateTests()`, `validateTests()` and the Markdown renderers in the library
  API.
- Flow parsing now keeps start-condition values, filter logic, formulas and "only when updated to
  meet the criteria"; the field a flow uses to link records it creates or updates to the
  triggering record; Apex method parameter types and `static`; and custom field `required` and
  default values.

### Fixed

- Email addresses in org error messages are redacted with a linear-time scan instead of a
  regular expression that could backtrack on unusual input.
- The sample project's permission set grants Contact access alongside Account access, as orgs
  with Person Accounts require.

## [0.2.0] - 2026-10-05

Accurate Apex analysis on a real parse tree, and read-only org context (beta).
**Requires Node.js 22.13 or newer.**

### Changed

- Apex is now analyzed on a real parse tree using
  [@apexdevtools/apex-parser](https://github.com/apex-dev-tools/apex-parser) instead of regular
  expressions. DML targets resolve through parameters, for-each variables, class fields and
  properties, casts and same-class method return types. Files with syntax errors fall back to
  the previous heuristics and are listed in the warnings.
- Field references in Apex are matched precisely by object, including standard fields and SOQL
  relationship paths, so `find_field_references` and the "deleted but still referenced" check
  have fewer false positives.
- Requires Node.js 22.13 or newer (required by the Apex parser).

### Added

- DML and SOQL inside helper methods called from a loop are now found, across classes (for
  example a trigger handler loop calling `AccountRepo.touch()` which runs a query). The finding
  names the method that does the work.
- `EventBus.publish` is treated as an insert of the platform event, so event-triggered
  automation joins the cascade.
- **Org context (beta):** `preflight analyze --org <alias>` adds read-only context from an
  org authorized with the Salesforce CLI. It reports record volumes for impacted objects
  (used in bulk test suggestions), active flows/triggers/validation rules that exist in the
  org but not in the project (new `org-only-automation` rule), how many active users hold
  changed permission sets and profiles, and installed packages. Each org-only finding says
  how the change reaches that automation and gives the `sf project retrieve start` command to
  pull it in; automation that never fires for the events reached is left out. Reports contain
  only counts and metadata names: a username passed to `--org` is shown as the org's alias
  (or "target org"). Also available as the MCP `org` argument and the action's
  `sfdx-auth-url` / `org` inputs. See [docs/ORG_CONTEXT.md](docs/ORG_CONTEXT.md).

### Fixed

- Piping output into a command that exits early (for example `preflight analyze | head`) no
  longer crashes with an `EPIPE` error.

## [0.1.0] - 2026-10-05

First public release: offline analysis, CLI, MCP server for coding agents, GitHub Action
and SARIF output.

### Added

- Offline analysis of SFDX source projects, driven by a git diff (`--base`/`--head`) or an
  explicit file list (`--files`).
- Parsers for custom fields (roll-up summaries, formulas), validation rules, record-triggered
  flows (`$Record`, typed variables, Get Records outputs, loops, subflows, Apex actions), Apex
  triggers and classes (heuristic DML/SOQL analysis) and permission sets/profiles.
- Simplified Salesforce order of execution per object and DML event.
- Cascade analysis across objects with cycle (re-entry) detection and a configurable depth.
- Findings: recursion cycles, validation-rule collisions with automated writes, fields used by
  validation rules, new validation rules vs existing automation, after-save self-updates,
  automation density, multiple triggers per object, DML/SOQL in loops, permission escalations
  (diffed against the git base), and deleted components that are still referenced.
- Suggested test plan per change (bulk, recursion, validation-collision, idempotency, boundary,
  permission-negative).
- Markdown (PR-comment ready) and JSON reports; `--fail-on` exit codes for CI.
- `preflight explain <Object>` to print an object's save procedure.
- Sample SFDX org fixture reproducing common failure modes.
- `preflight mcp`: read-only MCP server for coding agents with `analyze_change`,
  `explain_save_order` and `find_field_references` tools, scoped to a root directory.
- GitHub Action (`uses: visparashar/sf-preflight@v0`): PR comment that updates in place, job
  summary, optional SARIF upload to code scanning, `fail-on` threshold and outputs.
- SARIF 2.1.0 output (`--format sarif`) with rule metadata and repo-relative locations.
- `--md-out`, `--json-out` and `--sarif-out` to write several report formats in one run.
- AI-assisted commit detection from co-author trailers, tool markers and bot authors, shown in
  reports and exposed as an action output.
- Rule catalog and generated [rules reference](docs/RULES.md); findings carry line numbers
  where known, and cycle findings list the automations involved.

### Security

- Git refs from the CLI, MCP and the action are validated so they can't be parsed as git
  options.

[Unreleased]: https://github.com/visparashar/sf-preflight/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/visparashar/sf-preflight/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/visparashar/sf-preflight/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/visparashar/sf-preflight/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/visparashar/sf-preflight/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/visparashar/sf-preflight/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/visparashar/sf-preflight/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/visparashar/sf-preflight/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/visparashar/sf-preflight/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/visparashar/sf-preflight/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/visparashar/sf-preflight/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/visparashar/sf-preflight/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/visparashar/sf-preflight/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/visparashar/sf-preflight/releases/tag/v0.1.0
