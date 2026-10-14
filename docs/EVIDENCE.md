# Evidence pack

Every change can produce an **evidence pack**: one JSON document that records what changed, who
or what wrote it, what preflight found, which tests ran and how they did, who approved it, and
the quality-gate decision. It's meant for change records, audits and release sign-off, especially
when part of the change was written by an AI tool.

```bash
preflight evidence --base origin/main --head HEAD --out evidence.json
```

This prints a summary and writes the JSON. `preflight analyze --evidence-out evidence.json`
writes the same file as part of a normal run, and the [GitHub Action](GITHUB_ACTION.md) uploads
it as a workflow artifact on every run.

```
## Change evidence

| | |
|---|---|
| Change | `origin/main` (4e1c2d9) → `HEAD` (9b7a310) |
| Components | 2 changed |
| Authorship | 3 commit(s), 1 AI-assisted (Claude) |
| Risk | high (2 high, 4 medium) |
| Quality gate | ❌ failed (1 of 3 checks) |
| Tests | 5 generated; 3 passed, 2 failed in my-sandbox |
| Approvals | alice |
| Policy | `.preflight.json` |
| Tool | sf-preflight 0.13.0 |
| Digest | `sha256:…` |
```

## Contents

| Field | What it records |
|---|---|
| `change.base`, `change.head` | Refs and commit SHAs; `uncommitted: true` when the working tree had uncommitted changes |
| `change.pullRequest` | Pull request number, head commit and URL (`--pr-number`, `--pr-head-sha`, `--pr-url`; the Action fills them in). In CI, `change.head` can be a temporary merge commit, so this records the commit that was reviewed |
| `change.components` | Each changed component with its type, file and the SHA-256 of the file's bytes at the head (what `sha256sum` prints) |
| `change.authorship` | Commits in the range, which are AI-assisted and which tools, with author names (not emails); `complete: false` when a shallow clone may hide earlier commits |
| `analysis` | Risk, every finding (rule, severity, title, files), impacted objects, cycles, affected agent actions |
| `tests` | Suggested tests, the generated tests and their results in an org (with `--tests-result`), and Testing Center runs per test (with `--agent-tests-result`) |
| `approvals` | Reviewers who approved (with `--approvals`, or from the pull request in the Action) |
| `gate` | The gate decision and each check |
| `config` | The policy file used (relative to the repository), the git ref it was read from (for example the base branch), and its SHA-256 |
| `repository` | Remote URL (credentials removed) and the project's path in it |
| `tool` | sf-preflight version |
| `digest` | SHA-256 over the canonical JSON of everything else |

Pass the inputs the gate and the record need:

```bash
preflight tests --base origin/main --validate --org my-sandbox --format json > tests.json
preflight agent-tests --base origin/main --org my-sandbox --format json > agent-tests.json
preflight evidence --base origin/main --head HEAD --tests-result tests.json \
  --agent-tests-result agent-tests.json --approvals approvals.json --out evidence.json
```

## What the evidence proves

- **The digest detects accidental changes** (a corrupted or truncated file, an edit by mistake).
  Anyone who can edit the file can also recompute the digest, so on its own it doesn't prove the
  file is genuine.

  ```bash
  preflight evidence --verify evidence.json
  # evidence.json: digest matches (sha256:…). This shows the file is intact; …
  ```

  The [report viewer](https://sf-preflight-web.vercel.app/) runs the same check in the browser and shows the whole pack; drop in
  `evidence.json` or the artifact zip from the Actions run.

- **A signature proves who produced it.** Let the GitHub Action sign the pack of the merged
  change (`attest: true` on pushes to the main branch) with a
  [GitHub artifact attestation](GITHUB_ACTION.md#signed-evidence), and verify it against the
  workflow and branch that should have produced it, so a pack signed by an edited workflow on
  another branch doesn't pass:

  ```bash
  gh attestation verify evidence.json --repo acme/sf-app \
    --signer-workflow acme/sf-app/.github/workflows/preflight.yml --source-ref refs/heads/main
  ```

  Keeping the digest somewhere the change's author can't write (a change record, a ticket) works
  too.

- **Inputs are as trustworthy as their source.** `--approvals`, `--tests-result` and `--agent-tests-result` record what
  the person running the command provides. In the GitHub Action, approvals come from the pull
  request's reviews, with the rules in [GITHUB_ACTION.md](GITHUB_ACTION.md#approvals).

## Privacy

The evidence pack contains metadata names, file paths and digests, commit subjects and author
names, reviewer logins and org aliases. It never contains record data, Salesforce usernames,
email addresses (they are removed from commit subjects too) or credentials (user names,
passwords and tokens are removed from the remote URL).
