# GitHub Action

> `@v0` always points at the latest 0.x release. Pin an exact tag such as `@v0.1.0` if you
> prefer fully reproducible runs.

Run sf-preflight on every pull request. The action posts the report as a PR comment (updating
the same comment on each push), adds it to the job summary, evaluates the
[quality gate](CONFIG.md#quality-gate) and fails the check when it doesn't pass, uploads the
change's [evidence pack](EVIDENCE.md) as an artifact (optionally signed), and can upload
findings to GitHub code scanning.

## Quick start

`npx sf-preflight init` writes this workflow (and a starter `.preflight.json`) for you, with your
default branch and project folder filled in. Or add it by hand:

```yaml
# .github/workflows/preflight.yml
name: Preflight

on:
  pull_request:
  # Re-evaluate the gate when someone approves (or dismisses an approval).
  pull_request_review:
    types: [submitted, dismissed]
  # Evidence for the merged change (sign it here, see "Signed evidence").
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: write # PR comment, and reading reviews for the gate

jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # needed to diff against the base branch and read commit history
      - uses: visparashar/sf-preflight@v0
```

The gate's policy comes from `.preflight.json` (see [CONFIG.md](CONFIG.md)); without one, the
gate fails on high findings, as `fail-on: high` did before. On pull requests the policy is read
from the base branch, so a pull request can't loosen its own gate; set `policy-from-base: false`
to use the pull request's copy.

To block merges (and DevOps Center promotions) on the gate, make the `preflight` check required
in your branch protection rules: see [PIPELINES.md](PIPELINES.md#devops-center). Don't add a
`paths:` filter to the `pull_request` trigger of a required check: pull requests that don't match
never report the check and stay blocked. (On a run with nothing to analyze, the gate passes.)

> **Never** run this workflow on `pull_request_target` with a checkout of the pull request's code.
> That gives the pull request's code a write token and your secrets.

## With code scanning

Findings show up as annotations on the changed files and in the repository's Security tab.

```yaml
permissions:
  contents: read
  pull-requests: write
  security-events: write # SARIF upload

steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0
  - uses: visparashar/sf-preflight@v0
    with:
      sarif: "true"
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `project` | `.` | SFDX project directory, relative to the repository root |
| `base` | PR base branch, or `HEAD~1` on push | Git base ref to compare against |
| `fail-on` | from `.preflight.json`, else `high` | Severity that fails the gate: `low`, `medium`, `high`, or `none` |
| `config` | `.preflight.json` | Policy file: rule overrides, ignores, gate settings ([CONFIG.md](CONFIG.md)) |
| `policy-from-base` | `true` | On pull requests, read the policy from the base branch so the pull request can't loosen it |
| `evidence` | `true` | Write the evidence pack and upload it as a workflow artifact |
| `artifact-name` | `sf-preflight-evidence` | Evidence artifact name (unique per workflow run) |
| `attest` | `false` | Sign the evidence with a GitHub artifact attestation (see below) |
| `comment` | `true` | Post and update a PR comment (needs `pull-requests: write`) |
| `suggest-fixes` | `false` | Post checked fixes as one-click suggested changes on the pull request (needs `pull-requests: write`). Only fixes that edit lines the pull request changed, and that touch one file, are suggested; each is posted once |
| `suggest-fix-kinds` | `safe,undo` | Which kinds of fix to suggest: `safe`, `undo`, `review` |
| `sarif` | `false` | Upload findings to code scanning (needs `security-events: write`) |
| `depth` | `4` | Maximum cascade depth |
| `sfdx-auth-url` | — | Beta: SFDX auth URL (from a secret) of a read-only integration user; adds org context |
| `org` | — | Beta: alias of an org already authorized earlier in the job; adds org context |
| `version` | matches the action ref | sf-preflight npm version to run; `local` builds from the action's source |
| `node-version` | `22` | Node.js version to set up; empty string uses the runner's Node |
| `notify-webhook` | — | Slack, Teams or generic webhook URL (use a secret). Sends a short alert when risk reaches `notify-on` ([details](#risk-alerts)) |
| `notify-on` | `high` | Alert threshold: `low`, `medium`, `high`, `gate-fail` or `always` |
| `notify-on-update` | `false` | Also alert on every push to an open pull request (otherwise: opened, reopened, ready for review, and pushes to other branches) |
| `github-token` | `github.token` | Token for the PR comment and for reading reviews |

## Risk alerts

Set `notify-webhook` to get a short message in Slack or Teams when a change is risky:

```yaml
- uses: visparashar/sf-preflight@v0
  with:
    notify-webhook: ${{ secrets.PREFLIGHT_WEBHOOK }}
    notify-on: high
```

- **Slack**: create an [incoming webhook](https://api.slack.com/messaging/webhooks) and store its URL as a secret.
- **Teams**: in a channel, add a Workflows template, "Post to a channel when a webhook request is received", and use its URL.
- Anything else receives a generic JSON body.

The message holds the risk level, counts, the top findings, affected components and a link to the pull request. It never includes the PR title or branch name, and text from the repository is cleaned before it is sent. Webhook URLs must be `https` and are refused for local or private addresses. A failed send never fails the check. Pull requests from forks get no secrets, so they send no alert. The same thing is available in any pipeline with `PREFLIGHT_WEBHOOK_URL=... preflight notify --result report.json --on high`.

## Outputs

| Output | Description |
|---|---|
| `risk` | `low`, `medium` or `high` |
| `high`, `medium` | Number of findings at that severity |
| `ai-assisted-commits` | AI-assisted commits detected in the PR (from co-author trailers and tool markers) |
| `report-markdown`, `report-json`, `report-sarif` | Paths to the generated reports |
| `gate` | `pass` or `fail` |
| `evidence`, `evidence-digest` | Path to the evidence pack and its SHA-256 digest |
| `attestation-url` | Link to the signed attestation, with `attest: true` |

## Approvals

The action reads the pull request's reviews. An approval counts when:

- it's the reviewer's latest decision (a later dismissal or "request changes" replaces it),
- it approves the pull request's **latest commit** (pushing new commits, AI-assisted or not,
  needs a fresh approval),
- the reviewer can write to the repository (write or admin permission) and isn't a bot,
- the reviewer didn't write the change: the pull request's author and every commit author are
  excluded.

On a push (for example after merging), it uses the pull request the commit came from. Approvals
feed the gate's `aiAssistedApprovals` setting and are recorded in the evidence pack. Add the
`pull_request_review` trigger shown above so the check re-runs when someone approves.

## Signed evidence

With `attest: true`, the evidence pack is signed with a
[GitHub artifact attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations)
(Sigstore). Anyone with access to the repository can then check that a given evidence file was
produced by your workflow on your main branch and not changed since. Sign the evidence of the
merged change, on pushes to the main branch; pull requests from forks can't sign (the step is
skipped with a warning):

```yaml
permissions:
  contents: read
  pull-requests: write
  id-token: write
  attestations: write
  artifact-metadata: write

steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0
  - uses: visparashar/sf-preflight@v0
    with:
      attest: ${{ github.event_name == 'push' && 'true' || 'false' }}
```

Verify against the workflow file and the branch, so a pack signed by an edited workflow on some
other branch doesn't pass:

```bash
gh attestation verify evidence.json --repo <owner>/<repo> \
  --signer-workflow <owner>/<repo>/.github/workflows/preflight.yml \
  --source-ref refs/heads/main \
  --predicate-type https://github.com/visparashar/sf-preflight/evidence/v1
```

Artifact attestations are available for public repositories, and for private ones on GitHub
Enterprise Cloud.

To require a reviewer for AI-assisted changes, use the gate rather than workflow logic:

```json
{ "gate": { "aiAssistedApprovals": 1 } }
```

## Org context (beta)

With org access, the report also shows record volumes for the impacted objects, automation
that runs in the org but isn't in the repo, and how many users hold changed permission sets.
See [ORG_CONTEXT.md](ORG_CONTEXT.md) for exactly what is queried.

1. Create a read-only integration user (ideally in a sandbox that mirrors production) and log
   in as it with the Salesforce CLI.
2. Get its auth URL: `sf org display --target-org <alias> --verbose --json` and copy
   `result.sfdxAuthUrl`. **It grants API access as that user, so treat it like a password.**
3. Save it as a repository secret, for example `PREFLIGHT_SFDX_AUTH_URL`.
4. Pass it to the action:

```yaml
- uses: visparashar/sf-preflight@v0
  with:
    sfdx-auth-url: ${{ secrets.PREFLIGHT_SFDX_AUTH_URL }}
```

The action installs the Salesforce CLI if needed, reads the URL from stdin (never from the
command line), and logs out at the end of the job. Pull requests from forks don't receive
secrets, so they get the offline analysis only.

## Notes

- **Fork PRs** get a read-only token, so the comment step is skipped with a warning; the job
  summary, approvals and the pass/fail result still work.
- **Several projects in one workflow** need a different `artifact-name` for each run of the
  action.
- The action runs `npx sf-preflight@<version>`. Pin the action to a release tag (for example
  `@v0.1.0`) for fully reproducible runs.
- The checkout must include the base branch history (`fetch-depth: 0`).
