---
name: sf-preflight
description: Checks Salesforce metadata changes before they ship and traces production errors back to the change that caused them. Use whenever you create, edit, rename or delete Salesforce DX metadata (Apex classes and triggers, flows, validation rules, fields, objects, permission sets, Agentforce agents and actions), before committing or opening a pull request for such a change, when asked what a change will set off in the org, to generate Apex tests for a change, or when production errors, failed flows or Apex exceptions appear after a deployment and a rollback may be needed.
license: Apache-2.0
compatibility: Needs Node.js 22.13+ and git in a Salesforce DX project; the sf-preflight MCP server or a shell that can run npx. Org commands need the Salesforce CLI (sf) logged in.
metadata:
  homepage: https://github.com/visparashar/sf-preflight
  version: "0.13.0"
---

# sf-preflight

sf-preflight follows a Salesforce change through the org's automation (order of execution,
flows, triggers, validation rules, roll-ups, permissions, Agentforce actions) and reports what it
will set off, the risks, and the tests that matter. It's deterministic: every finding names the
metadata that produced it.

## How to call it

Use whichever your environment has:

- **MCP tools** (preferred when present): `analyze_change`, `suggest_fixes`, `check_fix`, `generate_tests`,
  `explain_save_order`, `find_field_references`, `explain_agent`, `plan_rollback`.
- **Shell**: `npx -y sf-preflight <command>` from the SFDX project root (the folder with
  `sfdx-project.json`). Add `--format json` when you need to read the result yourself.

Command details and options: [references/commands.md](references/commands.md).

## Workflow: a change you're making

1. **Before adding automation to an object**, see what already runs when it's saved:
   `explain_save_order` / `npx -y sf-preflight explain <Object> --event update`.
2. **Before renaming, retyping or deleting a field**, find what uses it:
   `find_field_references` (MCP only; in a shell, search the project for the field name).
3. **Before changing anything an Agentforce action calls**, read the agent:
   `explain_agent` / `npx -y sf-preflight agents <Agent>`.
4. **After editing**, analyze everything changed so far (working tree against `HEAD`):
   `analyze_change` / `npx -y sf-preflight analyze --base HEAD --format json`.
   Use `--base origin/main` (or the PR's base branch) to check a whole branch.
5. **Act on the findings**, highest severity first:
   - **High** findings and a failed quality gate are blockers. Fix them, or tell the user
     plainly why one is acceptable. Don't silence a rule or edit `.preflight.json` to pass.
   - **Medium** findings: fix when the fix is small and clearly right; otherwise explain.
   - What each rule means and the usual fix: [references/findings.md](references/findings.md).
   - **Checked fixes**: `suggest_fixes` / `npx -y sf-preflight fix --base HEAD` returns diffs that
     sf-preflight has already verified (the finding goes away, nothing new appears). Apply the
     `safe` ones; an `undo` fix reverses part of what was asked for, so confirm it with the user
     first; read a `review` fix before applying it.
   - **Your own fix**: for a finding with no checked fix, write the fix, then pass the new file
     contents to `check_fix` (with `finding` set to the fix id or rule id) before writing them. Only
     write it if the verdict is `accepted`; `rejected` says what is still reported or newly broken.
6. **Generate tests** for what the change sets off (bulk, recursion, idempotency, validation
   errors surfacing): `generate_tests` returns the Apex, which you write into the project;
   `npx -y sf-preflight tests --base HEAD` writes the classes itself (to `preflight-tests/`, or
   `--out <dir>`). Read their `NOTE`
   comments and fill in any data the generator couldn't infer.
7. **Analyze again** before committing, and summarise for the user: risk level, what the change
   sets off, findings fixed, findings left with the reason, tests added.

## Workflow: production errors

When something broke in production after a deployment, see
[references/production.md](references/production.md): `incidents` traces the errors to the
change that most likely caused them, and `rollback` plans a partial rollback that ships as a
pull request.

## Rules for working with an org

- Everything except the commands below only reads the org, so it's safe on production.
- `tests --validate` deploys check-only and `agent-tests` runs Agentforce actions for real. Both
  refuse production orgs. **Never pass `--allow-production`** unless the user explicitly asks.
- Never deploy, and never run `sf project deploy start` yourself. `rollback --restore` only
  edits local files: the user ships them through a pull request.
- Don't ask the user to paste org credentials, auth URLs or tokens. Use an org alias they've
  already logged in to with `sf org login`.
- Reports contain no record data or user names; keep it that way in what you write back.
