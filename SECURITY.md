# Security Policy

## Supported versions

sf-preflight is pre-1.0. Security fixes are made on the latest released minor version.

| Version | Supported |
|---|---|
| 0.x (latest) | ✅ |
| older | ❌ |

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, discussions or pull requests.**

Report them privately through GitHub's
[private vulnerability reporting](https://github.com/visparashar/sf-preflight/security/advisories/new)
("Report a vulnerability" on the repository's **Security** tab). If you can't use it, email
[vis.parashar@gmail.com](mailto:vis.parashar@gmail.com) with `[sf-preflight security]` in the
subject.

Please include:

- a description of the issue and its impact,
- steps or a minimal SFDX project / input that reproduces it,
- the version (`preflight --version`) and Node.js version you used.

You can expect an acknowledgement within **5 business days**. We will keep you informed while we
investigate, agree a disclosure date with you, and credit you in the advisory unless you prefer
otherwise.

We follow coordinated disclosure: we aim to release a fix within 90 days of the report (sooner
for severe issues), then publish a
[GitHub security advisory](https://github.com/visparashar/sf-preflight/security/advisories)
and request a CVE where one applies. Please keep the details private until the advisory is
published.

## Scope

sf-preflight reads Salesforce metadata from a local SFDX project and runs `git` locally. Only
when you pass `--org` (or the action's `sfdx-auth-url`/`org` inputs) does it contact a
Salesforce org, through the Salesforce CLI and read-only queries listed in
[docs/ORG_CONTEXT.md](docs/ORG_CONTEXT.md). The exceptions are the commands you run explicitly to
test in an org (`preflight tests --validate`, a check-only deployment, and `preflight agent-tests`,
which runs Testing Center tests); both refuse production orgs by default. It never contacts any other external service.
Issues of particular interest include:

- code execution or command injection via crafted metadata files, paths or git refs,
- path traversal outside the project directory,
- denial of service from crafted metadata (e.g. pathological XML or Apex input),
- leaking sensitive metadata, record data or credentials into reports or logs,
- any way to make `--org` write to an org or run commands other than the documented ones,
- any way to make `tests --validate` or `agent-tests` run in a production org without
  `--allow-production`,
- any way for `incidents` to write to an org, or to put error message text, record data or user
  names into its report,
- any way for `rollback --restore` to write outside the project's tracked files or over
  uncommitted changes.

## Verifying releases

Every release on GitHub carries the package (the npm tarball, or the VS Code extension's `.vsix`) and a
signed build provenance bundle (`*.sigstore.json`), produced by the release workflow. Check that a file was
built by this repository's workflow:

```bash
gh attestation verify sf-preflight-0.10.1.tgz --repo visparashar/sf-preflight
```

npm packages are also published with npm provenance (shown on npmjs.com).
