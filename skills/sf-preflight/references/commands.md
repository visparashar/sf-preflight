# sf-preflight commands

Run from the SFDX project root, or pass `--project <dir>`. In a shell, prefix each command with
`npx -y sf-preflight` (or use `preflight` when the package is installed).

## Analyze a change

| Goal | MCP | CLI |
|---|---|---|
| What I've changed so far (new files included) | `analyze_change` (no arguments) | `analyze --base HEAD --format json` |
| A whole branch / pull request | `analyze_change` with `base: "origin/main"` | `analyze --base origin/main --format json` |
| Specific files | `analyze_change` with `files: [...]` | `analyze --files <paths...> --format json` |
| Apply the project's quality gate | included in `analyze_change` | add `--gate` (exit code 2 when it fails) |

Useful JSON fields: `summary.risk` (`low`/`medium`/`high`), `summary.findingsBySeverity`,
`findings[]` (`severity`, `rule`, `title`, `detail`, `files`), `saveProcedures[]` (what runs, in
order, per object and event), `cycles[]`, `agents[]` (affected Agentforce actions),
`suggestedTests[]`, and `gate` (with `--gate`).

`--org <alias>` (beta) adds read-only org context: record volumes, automation that exists only
in the org, permission assignments, an agent runtime user's real access.

## Fix findings

| Goal | MCP | CLI |
|---|---|---|
| Checked fixes as diffs (nothing written) | `suggest_fixes` (same arguments as `analyze_change`, plus `rules`) | `fix --base HEAD` (`--format json` for the diffs as data) |
| Write the safe fixes | apply the diffs yourself | `fix --base HEAD --apply` |
| Write chosen fixes, whatever their kind | apply those diffs | `fix --base HEAD --apply --only <id...>` |

Each fix has `id`, `rule`, `finding` (the finding's title), `label`, `kind` (`safe`, `undo`, `review`),
`note`, `edits[]` (`file`, `before`, `after`) and `diff`. Confirm `undo` fixes with the user: they reverse part
of the change.

## Understand before changing

| Goal | MCP | CLI |
|---|---|---|
| What runs when an object is saved | `explain_save_order` (`object`, `event`) | `explain <Object> --event insert\|update\|delete\|undelete` |
| What uses a field | `find_field_references` (`object`, `field`) | search the project for the field's API name |
| What an agent's actions call, save and need | `explain_agent` (`agent`) | `agents <Agent>`; `agents` lists them |

## Tests

| Goal | MCP | CLI |
|---|---|---|
| Generate Apex tests for a change | `generate_tests` (returns code; write the files) | `tests --base HEAD` (writes the classes to `preflight-tests/`, or `--out <dir>`) |
| Preview without writing | — | `tests --base HEAD --dry-run` |
| Run them in a sandbox, check-only | — | `tests --base HEAD --validate --org <sandbox> --format json` |
| Run the Agentforce Testing Center tests that cover the change | — | `agent-tests --base origin/main --org <sandbox>` (after deploying the change there) |

## Production

| Goal | MCP | CLI |
|---|---|---|
| Trace production errors to changes | — | `incidents --org <alias> --since 24h` |
| Plan a partial rollback | `plan_rollback` (`commit`, `components`) | `rollback <commit> --component Type:Name` |
| Apply the plan to local files | — | `rollback <commit> --component Type:Name --restore` |

## Exit codes

`0` success. `2` the gate failed, risk is at or above `--fail-on`, or tests failed. Anything
else is an error; the message says what to fix (for example a missing `sfdx-project.json` or an
unknown git ref).
