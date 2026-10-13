# Pre-commit hook

Catch a risky change on your machine, before it is committed, instead of in the pull request.

```bash
npx sf-preflight hook install        # in your SFDX project
```

From then on, every `git commit` checks the **staged** Salesforce metadata against `HEAD`, prints a short
summary, and blocks the commit when a finding is at or above the threshold:

```
sf-preflight: HIGH risk in 1 staged component
  ✗ high    Automation cycle: Opportunity → Opportunity  (…/Contract_Signed_Date__c.field-meta.xml)
  ! medium  Automated writes to Opportunity must pass 1 validation rule(s)  (…)

Commit blocked: 1 finding(s) at or above "high".
See them all with `preflight analyze --staged`. Fix them, or skip this check once with `git commit --no-verify`.
```

Commits that stage no Salesforce metadata are not slowed down and print nothing.

By default the hook reports only what the staged change **introduces**: findings that were already there at
`HEAD` (an old recursion cycle, DML in a loop in a legacy class) are hidden and counted, so a commit isn't
blocked for problems it didn't cause. `preflight hook run --all` shows everything; a `baseline` in
`.preflight.json` takes precedence ([baseline](CONFIG.md#baseline-only-new-findings)).

## Options

| Command | What it does |
|---|---|
| `preflight hook install [-p <dir>] [--fail-on <level>]` | Write `.git/hooks/pre-commit` (or the `core.hooksPath` folder). The threshold defaults to the policy's `gate.failOn` in `.preflight.json`, else `high`; `none` reports without blocking. |
| `preflight hook install --force` | Replace a pre-commit hook that isn't sf-preflight's. Without it, an existing hook is left alone and you get the line to add to it. |
| `preflight hook uninstall` | Remove the hook (only if it is sf-preflight's). |
| `preflight hook run` | What the hook calls; run it yourself to try it. |
| `preflight analyze --staged` | The full report for what is staged. |

Skip the check once with `git commit --no-verify`, or with `PREFLIGHT_SKIP=1 git commit ...`.

The hook uses, in order: `$PREFLIGHT_BIN`, the project's `node_modules/.bin/preflight`, `preflight` on the
PATH, then `npx sf-preflight@<the version that installed it>`.

Only the findings threshold applies on commit. Gate checks that need a pull request (approvals, Testing Center
results) belong in CI, where the [GitHub Action](GITHUB_ACTION.md) runs the full gate.

A file staged and then edited again is checked as it is in the working tree; the summary says so.

## With a hook manager

Husky (`.husky/pre-commit`):

```sh
npx --no-install preflight hook run
```

lefthook (`lefthook.yml`):

```yaml
pre-commit:
  commands:
    sf-preflight:
      run: npx --no-install preflight hook run
```

[pre-commit](https://pre-commit.com) (`.pre-commit-config.yaml`):

```yaml
repos:
  - repo: local
    hooks:
      - id: sf-preflight
        name: sf-preflight
        entry: npx --yes sf-preflight hook run
        language: system
        pass_filenames: false
```
