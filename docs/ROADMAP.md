# Roadmap

sf-preflight aims to answer one question for every Salesforce change — human- or
AI-authored — before it ships:

> **If this change ships, what will it set off in this org, and how do we prove it's safe?**

## Principles

1. **Offline first.** The core runs on SFDX source in a git repo with no org credentials.
   Connecting to an org adds precision; it is never required.
2. **Execution-layer semantics.** Model the order of execution, cross-object cascades,
   roll-ups and permissions — not UI clicks.
3. **One engine, many surfaces.** The same core library powers the CLI, an MCP server for
   coding agents, a GitHub Action and pipeline integrations.
4. **Deterministic and explainable.** Every finding cites the metadata and the path that
   produced it. No LLM in the core analysis loop.
5. **Tool-neutral.** Works alongside DevOps Center, open-source CI and commercial DevOps tools.

## Milestones

| | Milestone | Outcome | Status |
|---|---|---|---|
| **M0** | Foundation | TypeScript project, tests, CI, open-source governance | ✅ done |
| **M1** | Offline preflight analyzer | `preflight analyze` on any SFDX repo → Markdown/JSON report with changed components, cascade, order of execution, findings and suggested tests | ✅ 0.1.0 |
| **M2** | Agent & PR surfaces | MCP server (`analyze_change`, `explain_save_order`, `find_field_references`) for Claude Code, Cursor, VS Code agents and other MCP clients; GitHub Action that comments on PRs; SARIF output for code scanning; AI-assisted commit detection | ✅ 0.1.0 |
| **M3** | Accuracy & live-org enrichment | Full Apex parser with cross-class call graph; optional `--org` enrichment via the `sf` CLI: permission assignments, record volumes, org-only automation, managed packages (beta) | ✅ 0.2.0 |
| **M4** | Test generation | `preflight tests` generates Apex tests from the blast radius — bulk, recursion, idempotency and validation errors surfacing from invocable actions — with a schema-aware data factory and values solved from flow entry criteria and validation rules — and runs them in a sandbox with a check-only deployment (`--validate --org`) | ✅ 0.3.0 |
| **M5** | Agentforce action verification | Agent Builder metadata and Agent Script parsed into agents → topics → actions → targets; the agent actions each change reaches, with Testing Center coverage; runtime-user access needs, checked against the org with `--org`; `preflight agents` and MCP `explain_agent`. Since then: `preflight agent-tests` runs the Testing Center tests that cover a change, with results in the gate and evidence | ✅ 0.4.0 |
| **M6** | Evidence & pipeline integration | `.preflight.json` policy (rule severities, ignores) and a quality gate (severity threshold, approvals for AI-assisted changes, agent test coverage, passing generated tests); evidence pack per change with file digests, authorship, findings, tests, approvals and a digest, signed with GitHub artifact attestations in the Action; the policy is read from the base branch so a change can't loosen its own gate; JUnit output and guides for DevOps Center, GitLab, Azure DevOps, Jenkins and Bitbucket. Next: a native DevOps Center test provider once Salesforce opens provider integrations | ✅ 0.5.0 |
| **M7** | Production feedback loop | `preflight incidents` reads failed flow interviews, unhandled Apex exceptions, failed async Apex and Agentforce action errors (beta) from an org, read-only, and traces each to the merged change most likely to have caused it (direct, message, blast-radius and finding evidence, weighed by timing in git and in the org); `preflight rollback` and MCP `plan_rollback` plan a partial rollback that stays consistent, shipped as a pull request. Messages are reduced to metadata, never record data | ✅ 0.6.0 |
| **M8** | Agents and editors | The `sf-preflight` agent skill (open Agent Skills format) for Codex, Copilot, Cursor, Gemini CLI, Claude and others, `preflight skill install`, and a Claude Code plugin with an edit hook; a VS Code extension with findings in the Problems panel, a blast-radius view, analysis on change and the MCP tools for agent mode | ✅ 0.7.0 · extension 0.1.0 |
| **M9** | Metadata coverage and speed | Every Salesforce metadata type recognized, with a report of how much of a change was analyzed in depth; in-depth analysis of Lightning Web Components and Aura, layouts and Lightning pages, picklist values and record types, custom labels, custom metadata and Visualforce; a parse cache and parallel parsing for large projects; the `sf` CLI plugin (`sf preflight …`) | ✅ 0.8.0 |

## Next up (M1 follow-ups)

- [ ] Process Builder and legacy workflow rule parsing
- [ ] Record-triggered flow trigger order (`triggerOrder`) within a phase
- [ ] Before-save flow field assignments as field-level writes
- [x] Apex: `Trigger.newMap` handlers and platform events (`EventBus.publish`)
- [x] Apex: detect ignored `Database.SaveResult` / `allOrNone=false` failures
- [ ] Master-detail cascade delete edges
- [x] Configurable rule severities and ignores (`.preflight.json`)
- [x] Performance pass on large orgs (parse cache, parallel parsing; see the README's Performance section)

## Out of scope (for now)

- Deploying metadata or replacing a CI/CD pipeline
- UI test automation
- Data backup and restore

Have an idea? Open a [feature request](https://github.com/visparashar/sf-preflight/issues/new/choose).
