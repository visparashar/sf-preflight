# Configuration and quality gate

Put a `.preflight.json` in your SFDX project (or at the repository root) to tune rules and define
the quality gate. Every command, the MCP server and the GitHub Action pick it up.

```json
{
  "$schema": "https://raw.githubusercontent.com/visparashar/sf-preflight/main/schema/preflight.schema.json",
  "rules": {
    "dml-or-soql-in-loop": "high",
    "legacy-workflow": "off"
  },
  "ignore": {
    "paths": ["force-app/main/default/classes/Legacy*.cls"]
  },
  "gate": {
    "failOn": "high",
    "aiAssistedApprovals": 1,
    "requireAgentTests": true,
    "requireAgentTestsPassed": false,
    "requireTestsPassed": false
  }
}
```

Unknown settings and rule ids are errors, so a typo can't silently weaken the gate. The
`$schema` line gives editors completion and validation.

## Rules

| Setting | Meaning |
|---|---|
| `rules.<rule-id>` | `high`, `medium`, `low` or `info` to change a rule's severity; `off` to drop its findings. Rule ids are in [RULES.md](RULES.md). |
| `ignore.paths` | Glob patterns relative to the project (`*` within a folder, `**` across folders, `?` one character). A finding is dropped when all of its files match. |

The report notes the policy file it used, and the risk is recalculated after overrides.

## Quality gate

The gate turns a change into one pass/fail decision. Run it with `--gate`:

```bash
preflight analyze --base origin/main --gate
```

It exits with code 2 when the gate fails, and the report starts with the checks:

| Check | Setting | Passes when |
|---|---|---|
| Findings | `failOn` (default `high`; `--fail-on` overrides it) | No finding is at or above that severity. `none` disables the check. |
| AI-assisted approvals | `aiAssistedApprovals` (default 0, off) | The change has no AI-assisted commits, or at least that many people approved it. |
| Agent test coverage | `requireAgentTests` | Every agent action the change affects is covered by a Testing Center test ([AGENTS.md](AGENTS.md)). |
| Generated tests | `requireTestsPassed` | The generated Apex tests ran in an org and passed ([TESTS.md](TESTS.md)). |
| Testing Center tests | `requireAgentTestsPassed` | The Testing Center tests that cover the affected agent actions ran in an org and passed ([AGENTS.md](AGENTS.md#running-testing-center-tests)). |

### Where the policy comes from

The gate is only as strong as the policy, and a pull request could edit `.preflight.json` to
loosen it. `--config-ref <ref>` reads the policy from git at that ref instead of the checkout:

```bash
preflight analyze --base origin/main --config-ref origin/main --gate
```

When the change edits the policy, the report says so and the edit takes effect once it's merged.
The [GitHub Action](GITHUB_ACTION.md) does this on pull requests by default (`policy-from-base`).
Protect `.preflight.json` with a CODEOWNERS entry as well, so policy changes get the right
reviewers.

### Approvals and test results

Approvals and test results come from the pipeline:

- `--approvals <file>`: a JSON list of reviewers, `["alice", "bob"]` or
  `[{ "reviewer": "alice", "submittedAt": "…" }]`. The [GitHub Action](GITHUB_ACTION.md#approvals)
  reads them from the pull request's reviews.
- `--tests-result <file>`: the output of
  `preflight tests --validate --org <sandbox> --format json`.
- `--agent-tests-result <file>`: the output of
  `preflight agent-tests --org <sandbox> --format json`, run after deploying the change.

These record what the caller provides; the gate can't check them itself. A change that generates
no tests passes the "generated tests" check without a result, and a change that affects no agent
actions, or none that tests cover, passes the "Testing Center tests" check. The Testing Center
check fails when the result was run for a different change or leaves out a test that covers this
one. On a shallow clone, the
AI-assisted approvals check fails when it can't see the whole history (use `fetch-depth: 0`).

When a check needs data that wasn't provided (approvals for an AI-assisted change, or test
results), it fails and says what to pass, rather than passing silently.

AI-assisted commits are recognised from co-author trailers and tool markers (Claude, Copilot,
Cursor, Codex, Gemini, Devin and others).

## Baseline: only new findings

An org with years of history has findings that have nothing to do with today's change: a recursion cycle
between two old flows, DML in a loop in a legacy class. A baseline keeps them out of the way, so the report,
the quality gate and the pre-commit hook react to what the change introduces.

```json
{ "baseline": "base" }
```

| Value | Meaning |
|---|---|
| `"base"` | Analyze the changed components as they are at the base ref too (`--base`, `HEAD` for `--staged`), and hide the findings that were already there. Nothing to maintain. |
| a path, e.g. `".preflight-baseline.json"` | A reviewed list of accepted findings, written by `preflight baseline` and committed. New findings outside the list are reported; delete entries as you fix them. |

`--baseline base`, `--baseline <file>` and `--no-baseline` set it for one run. The pre-commit hook uses `"base"`
unless the policy sets a baseline (`preflight hook run --all` shows everything).

Only findings that describe a state the org can already be in can be hidden: cycles, DML or SOQL in loops,
automation density, validation or duplicate rules that automated writes must pass, untested agent actions,
inactive flows, references to fields or classes the project lacks, insecure integrations, broad permissions.
Findings about the change itself (what a changed field is used by, what a deletion breaks, access granted or
removed) are always reported. The report says how many findings the baseline hid.

## Output formats for pipelines

| Format | Use |
|---|---|
| `--format md` | Pull request comments and job summaries |
| `--format json` | Everything, including the gate, for scripts |
| `--format sarif` | GitHub code scanning and other SARIF viewers |
| `--format junit` | Test reports in GitLab, Azure DevOps, Jenkins, Bitbucket and most CI systems: one test case per gate check and per finding |
| `--evidence-out <file>` | The [evidence pack](EVIDENCE.md) for audits |

Each has a matching `--<format>-out <file>` option so one run can write several.
