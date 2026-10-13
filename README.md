<h1 align="center">
  <img alt="sf-preflight: preflight checks for Salesforce changes" src="https://raw.githubusercontent.com/visparashar/sf-preflight/main/docs/assets/sf-preflight-banner.png">
</h1>

[![CI](https://github.com/visparashar/sf-preflight/actions/workflows/ci.yml/badge.svg)](https://github.com/visparashar/sf-preflight/actions/workflows/ci.yml)
[![CodeQL](https://github.com/visparashar/sf-preflight/actions/workflows/codeql.yml/badge.svg)](https://github.com/visparashar/sf-preflight/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/visparashar/sf-preflight/badge)](https://scorecard.dev/viewer/?uri=github.com/visparashar/sf-preflight)
[![npm](https://img.shields.io/npm/v/sf-preflight.svg)](https://www.npmjs.com/package/sf-preflight)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node.js 22.13+](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)
[![Website](https://img.shields.io/badge/website-visparashar.github.io%2Fsf--preflight-52E0A1)](https://visparashar.github.io/sf-preflight/)
[![M8ven Score](https://m8ven.ai/badge/mcp/visparashar-sf-preflight-13zbfy?v=17a47b225ccd7f1293f0a618ea86a19d)](https://m8ven.ai/mcp/visparashar-sf-preflight-13zbfy?s=readme)

**Preflight checks for Salesforce changes: know what a change will set off — before it ships.**

AI coding agents and Headless 360 make Salesforce changes cheap to produce, but verifying them
is still slow and manual. `sf-preflight` reads your SFDX project and a git diff, follows the
change through the org's order of execution — flows, triggers, validation rules, roll-ups,
permissions — and reports the blast radius, the risks and the tests that matter.

It is open source, runs offline on your source code, and needs no org credentials.

> **Status:** early (0.x). The CLI, MCP server, GitHub Action, test generation, Agentforce
> action verification, the quality gate and evidence packs work today; org context is in beta.
> See the [roadmap](docs/ROADMAP.md). Feedback and contributions are very welcome.

**Website:** <https://visparashar.github.io/sf-preflight/> · **Demo videos:** <https://visparashar.github.io/sf-preflight/demos.html>

<p align="center">
  <img alt="Demo: preflight analyze on the sample org finds two automation cycles, an affected agent action and validation-rule collisions" src="https://raw.githubusercontent.com/visparashar/sf-preflight/main/docs/assets/preflight-demo.gif">
</p>

## What it finds

| Finding | Why it matters |
|---|---|
| **Recursion cycles** | `Account → Contact → Account` loops settle at human pace and break at bulk or agent volume |
| **Validation-rule collisions** | An automation or agent action can be *correct* and still fail on a rule it doesn't satisfy |
| **New rules vs existing automation** | A new validation rule silently constrains every flow, trigger and class that writes the object |
| **After-save self-updates** | Re-runs the whole save procedure for the record |
| **Automation density** | Many overlapping automations or multiple triggers on one object hide ordering bugs |
| **DML/SOQL in loops** | In changed Apex and in Apex inside the blast radius |
| **Access and sharing** | New Modify All / View All, delete access and sensitive system permissions; access taken away (and the components that need it); guest user exposure; organization-wide defaults; sharing rules; permission set groups and muting — diffed against the base |
| **Broken references** | Deleted fields, flows or classes that are still used |
| **Lightning components** | Components that use a changed field or call a changed Apex class, what a changed component saves through Apex, and fields or classes it uses that the project lacks |
| **Labels, custom metadata and Visualforce** | Removed labels still in use, who reads a changed custom metadata record, Visualforce pages tied to a changed Apex class or naming a missing one |
| **Picklists and record types** | Removed or deactivated picklist values still offered by record types or written in code; record types that drop values or are deleted while code names them |
| **Save rules and platform events** | Duplicate, assignment, auto-response and escalation rules in the order of execution; automation that a blocking duplicate rule can stop; rules and approval processes switched on, off or re-scoped; platform event publishers and subscribers when an event changes |
| **Integrations** | Named and external credentials that move host, change authentication or use http; remote sites and CSP trusted sites removed while code still calls the host; connected app scopes, callback URLs and committed secrets; outbound messages that send session IDs |
| **Layouts, pages, reports and templates** | Where a changed field or component is shown (layouts, Lightning pages, reports, report types, list views, email templates, quick actions, compact layouts, field sets), fields or components a page names that the project lacks, and what a changed page no longer shows |
| **Everything else that changed** | Every other metadata type (tabs, quick actions, reports, email templates and the rest) is recognized and listed with the files that mention it, and the report says how much of the change was analyzed in depth. When any component is deleted or renamed, including through `destructiveChanges.xml`, the files that still name it are flagged |
| **Affected agent actions** | Agentforce actions the change reaches, their Testing Center coverage and what their runtime user needs |

Every run also produces a **suggested test plan**: bulk, recursion, validation-collision,
idempotency, boundary and permission-negative tests for exactly what the change touches — and
`preflight tests` [generates the Apex](#generate-tests) for them.

## Quick start

Requires Node.js 22.13 or newer. Run it from the root of an SFDX project:

```bash
npx sf-preflight analyze --base origin/main
```

or install the `preflight` command globally:

```bash
npm install -g sf-preflight
preflight analyze --base origin/main
```

To run from source instead, see [CONTRIBUTING.md](CONTRIBUTING.md#development-setup).

### Usage

```bash
# Everything changed since origin/main (committed and uncommitted)
preflight analyze --project path/to/sfdx-project --base origin/main

# Compare two refs
preflight analyze --base origin/main --head HEAD

# Specific files
preflight analyze --files force-app/main/default/objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml

# JSON for machines; exit code 2 when risk is high
preflight analyze --base origin/main --format json --out preflight.json --fail-on high

# Quality gate from .preflight.json, plus JUnit for CI and the evidence pack
preflight analyze --base origin/main --gate --junit-out preflight.xml --evidence-out evidence.json

# What runs, in order, when an object is saved?
preflight explain Opportunity --event update

# What can an Agentforce agent do, and what do its actions save?
preflight agents Sales_Agent

# Run the Testing Center tests that cover the change (after deploying it to a sandbox)
preflight agent-tests --base origin/main --org my-sandbox

# Which recent change broke production? And a partial rollback of just that part
preflight incidents --org prod --since 24h
preflight rollback 9c607ea --component ValidationRule:Opportunity.Require_Close_Reason
```

| Option | Default | Description |
|---|---|---|
| `-p, --project <dir>` | `.` | SFDX project directory (reads `sfdx-project.json`) |
| `-b, --base <ref>` | — | Git base ref |
| `--head <ref>` | working tree | Git head ref |
| `-f, --files <paths...>` | — | Analyze these files instead of a git diff |
| `--format <md\|json\|sarif\|junit>` | `md` | Output format |
| `--md-out`, `--json-out`, `--sarif-out`, `--junit-out <file>` | — | Also write the report in another format |
| `--gate` | — | Evaluate the quality gate from `.preflight.json`; exit with code 2 when it fails ([details](docs/CONFIG.md)) |
| `--config <file>`, `--no-config` | `.preflight.json` | Policy file to use, or none |
| `--approvals <file>`, `--tests-result <file>`, `--agent-tests-result <file>` | — | Approvals, generated test results and Testing Center results for the gate and evidence |
| `--evidence-out <file>` | — | Also write the evidence pack ([details](docs/EVIDENCE.md)) |
| `-o, --out <file>` | stdout | Write the report to a file |
| `--depth <n>` | `4` | Maximum cascade depth |
| `--org <alias>` | — | Beta: add read-only context from an org authorized with `sf org login` ([details](docs/ORG_CONTEXT.md)) |
| `--fail-on <level>` | `none` | Exit with code 2 when risk ≥ `low`, `medium` or `high` |

Let AI coding agents check their own edits: `npx sf-preflight agent-hook install` makes Claude Code see the findings each metadata edit introduces ([details](docs/AI_AGENTS.md#4-check-every-edit-automatically-claude-code-hook)).

Catch risky changes before they are committed: `npx sf-preflight hook install` adds a git pre-commit hook that checks the staged metadata ([details](docs/HOOKS.md)).

Watch production for risky changes made directly in the org (read-only, on a schedule): `preflight monitor --org prod --since 1h --notify-on high` ([details](docs/MONITOR.md)).

Send a Slack, Teams or generic webhook alert from a saved JSON report: `PREFLIGHT_WEBHOOK_URL=<https url> preflight notify --result report.json --on high` (also `--link`, `--source`, `--target`, `--dry-run`, `--strict`; [details](docs/GITHUB_ACTION.md#risk-alerts)).

### Example

A one-field change in the bundled [sample org](fixtures/sample-org):

```
Opportunity (update)   [changed: Opportunity.Contract_Signed_Date__c]
├─ flow Opportunity_Closed_Won_Followup → Opportunity (update)  ⟲ cycle
├─ flow Opportunity_Closed_Won_Followup → Task (insert)
└─ roll-up Account.Total_Won_Amount__c → Account (update)
   └─ flow Account_Sync_Tier_To_Contacts → Contact (update)
      └─ trigger ContactTrigger → Account (update)  ⟲ cycle
```

The full Markdown report adds a findings table, the order of execution for each impacted
object, references to the changed field and a test checklist — ready to paste into a PR.

### Generate tests

```bash
preflight tests --base origin/main
```

Writes Apex tests for exactly what the change touches to `preflight-tests/`: bulk saves of 200
records, recursion along automation cycles, flows that must not apply twice, and invocable
actions that must not swallow validation errors. Test data comes from a schema-aware data
factory, with values chosen to meet your flows' entry criteria and pass your validation rules.
Add `--validate --org my-sandbox` to run them right away: preflight deploys your project and the
tests check-only (Salesforce compiles and runs everything, then rolls it back) and reports each
test's result.

```bash
preflight tests --base origin/main --validate --org my-sandbox
```

See [docs/TESTS.md](docs/TESTS.md) for what is generated and how to read a failure.

### Agentforce agents

```bash
preflight agents Sales_Agent
```

Preflight reads agents from source, both Agent Builder metadata and Agent Script (`.agent`
files), and follows each action to the Apex class or flow it calls and the records that saves.
Every analysis then reports the agent actions a change reaches, whether Testing Center tests
cover them, and the access their runtime user needs. With `--org`, it checks that user's real
permissions, and `preflight agent-tests` runs the Testing Center tests that cover the change. See
[docs/AGENTS.md](docs/AGENTS.md).

### Quality gate and evidence

```json
{ "gate": { "failOn": "high", "aiAssistedApprovals": 1, "requireAgentTests": true } }
```

A `.preflight.json` sets rule severities, ignores and the **quality gate**: no findings at or
above a severity, approvals for AI-assisted changes, Testing Center coverage for affected agent
actions, passing generated tests. `preflight analyze --gate` exits with code 2 when it fails.
Every run can also write an **evidence pack**: what changed (with file digests), who or what
wrote it, findings, tests, approvals and the gate decision, with a tamper-evident digest, ready
for change records and audits.

See [docs/CONFIG.md](docs/CONFIG.md), [docs/EVIDENCE.md](docs/EVIDENCE.md), and
[docs/PIPELINES.md](docs/PIPELINES.md) for DevOps Center, GitLab, Azure DevOps, Jenkins and
Bitbucket (JUnit output included).

### After it ships: production errors and partial rollback

```bash
preflight incidents --org prod
```

Preflight reads recent failed flow interviews, unhandled Apex exceptions, failed async jobs and
Agentforce action errors from the org (read-only), and traces each one back to the merged change
most likely to have caused it, with the evidence: the change touched the failing component, the
error is the message of a rule it added, the failing flow is in its blast radius, and the errors
started right after it was deployed. `preflight rollback` then plans a partial rollback of just
those components (restore, or deactivate what the change added) that stays consistent and ships
as a pull request. Messages are reduced to metadata, never record data. See
[docs/INCIDENTS.md](docs/INCIDENTS.md).

### On pull requests (GitHub Action)

```yaml
permissions:
  contents: read
  pull-requests: write

steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0
  - uses: visparashar/sf-preflight@v0
    with:
      fail-on: high
```

The action comments the report on the PR (and keeps that comment updated), writes it to the job
summary, evaluates the quality gate with the PR's approvals, uploads the evidence pack (optionally
signed with a GitHub artifact attestation), and can upload findings to code scanning as SARIF.
See [docs/GITHUB_ACTION.md](docs/GITHUB_ACTION.md).

### From AI coding agents (any model)

```bash
npx -y sf-preflight skill install   # the agent skill, in .agents/skills and .claude/skills
```

Coding agents get two things. The **agent skill** (open [Agent Skills](https://agentskills.io)
format, read by Codex, GitHub Copilot, Cursor, Gemini CLI, Claude Code and others) tells them
when to check a change and what to do with the findings. The **MCP server** (`preflight mcp`,
read-only) gives them the tools: `analyze_change`, `explain_save_order`,
`find_field_references`, `explain_agent`, `generate_tests` and `plan_rollback`. For Claude Code
there's also a plugin that bundles both and checks each metadata edit as it happens:

```text
/plugin marketplace add visparashar/sf-preflight
/plugin install sf-preflight@sf-preflight
```

Setup for each agent, and an `AGENTS.md` snippet for agents without skills:
[docs/AI_AGENTS.md](docs/AI_AGENTS.md). MCP tools: [docs/MCP.md](docs/MCP.md).

### In the Salesforce CLI

```sh
sf plugins install sf-plugin-preflight
sf preflight analyze --base origin/main --target-org my-sandbox
```

The plugin (`sf-plugin/`) is a thin wrapper: it runs this CLI, mapping `--target-org` to `--org` and
`--json` to `--format json`. See [sf-plugin/README.md](sf-plugin/README.md).

### In VS Code

The [sf-preflight extension](vscode/README.md) shows findings in the Problems panel as you work,
the blast radius (what runs, in order, on every impacted object) beside your code, a graph of
everything the change sets off, and a risk dashboard: the change's risk factors, where the risk sits,
and a trend of findings over the branch's recent analyses. It re-analyzes when metadata changes,
generates tests, explains save order, opens the report in the web viewer for reviewers, and offers
the MCP tools to GitHub Copilot and other agents in the editor. It works in VS Code and
editors built on it (Cursor, Salesforce Code Builder). Install `visparashar.sf-preflight-vscode` from
the VS Code Marketplace or Open VSX.

### In the browser (report viewer)

The [report viewer](https://sf-preflight-web.vercel.app/) ([sample report](https://sf-preflight-web.vercel.app/?sample=report),
[sample evidence pack](https://sf-preflight-web.vercel.app/?sample=evidence)) opens a JSON report (`--format json`) or an evidence pack in the
browser, for reviewers, release managers and auditors who don't run the CLI: the risk, quality
gate, findings, blast-radius graph, order of execution, affected Agentforce actions and tests to
run, or an evidence pack with its digest checked. Drop in the evidence artifact zip from a GitHub
Actions run as it is. Files are read in the browser and never uploaded. It's a static site
([source](web/README.md)), so you can also host your own copy, with ready-made settings for Vercel and Netlify.

### With org context (beta)

```bash
preflight analyze --base origin/main --org my-sandbox
```

Your SFDX source isn't the whole truth: orgs collect automation that never made it into the
repo. With `--org`, preflight asks the org (read-only, through your existing `sf` CLI login)
for record volumes of the impacted objects, active flows, triggers and validation rules that
exist only in the org, how many users hold the permission sets you changed, and installed
packages. The report contains only counts and metadata names. See
[docs/ORG_CONTEXT.md](docs/ORG_CONTEXT.md).

### AI-assisted changes

When analyzing a git range, preflight reads commit trailers and tool markers (Claude, Copilot,
Cursor, Codex, Gemini, Devin and others) and reports how many commits were AI-assisted, so
reviewers know where to look harder. The analysis itself is identical for human and AI changes.

### As a library

```ts
import { run, toMarkdown } from "sf-preflight";

const result = run({ projectDir: ".", base: "origin/main" });
console.log(result.summary.risk, result.findings.length);
console.log(toMarkdown(result));
```

## Performance

Measured on [NPSP](https://github.com/SalesforceFoundation/NPSP) (1,035 Apex classes, 765 fields,
26 triggers), changing one class, on a 2-core Xeon 2.8 GHz with Node 22 (median of 3):

| Scenario | Time | Peak memory |
|---|---:|---:|
| First run, 1 thread | 35.1 s | 1,378 MB |
| First run, 2 threads | 27.6 s | 1,747 MB |
| Repeat run (cached) | 0.9 s | 173 MB |
| Repeat run after editing one class | 1.1 s | 204 MB |

Parsing Apex is nearly all of the cost, so results are cached per file in `~/.cache/sf-preflight`
(set `PREFLIGHT_CACHE_DIR` to move it or `PREFLIGHT_NO_CACHE=1` to turn it off), and a first run
parses on worker threads (`PREFLIGHT_JOBS=1` to turn that off). A cached file whose size and
modification time haven't changed is not read again; one modified in the last two seconds is
always checked by its content. Small projects take about a second either way (apex-recipes, 139
classes: 2 s). The editor extension keeps its analysis worker and cache loaded between runs, so
analyzing again while you type takes about 0.6 s on NPSP. Gains from threads depend on the
machine; on this 2-core box they were modest. Run it on your own project:

```bash
npm run build
node scripts/bench.mjs path/to/your/sfdx-project --runs 3
```

It uses a temporary cache (yours is never touched) and, for the "after editing" row, appends a
comment to one Apex file and puts it back.

## How it works

```
SFDX source ─► parsers ─► org model ─► change mapper ─► order of execution ─► cascade ─► findings ─► Markdown / JSON / SARIF
                                                                                               └─► generated Apex tests
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details and known limitations, and
[docs/RULES.md](docs/RULES.md) for every rule. In short:
Process Builder, legacy workflow, duplicate and assignment rules are not modelled yet, and the
Apex call graph doesn't follow interfaces or dynamic dispatch.

## Contributing and community

Contributions are welcome — especially reports of wrong or missing findings with a small,
anonymised metadata snippet. Read [CONTRIBUTING.md](CONTRIBUTING.md) to get started, and please
follow our [Code of Conduct](CODE_OF_CONDUCT.md).

- **Questions and help:** [SUPPORT.md](SUPPORT.md)
- **Security issues:** report privately, see [SECURITY.md](SECURITY.md)
- **How the project is run:** [GOVERNANCE.md](GOVERNANCE.md) and [MAINTAINERS.md](MAINTAINERS.md)
- **What's next:** [roadmap](docs/ROADMAP.md) and [changelog](CHANGELOG.md)

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.

*Salesforce, Agentforce and related marks are trademarks of Salesforce, Inc. This project is
independent and not affiliated with or endorsed by Salesforce.*
