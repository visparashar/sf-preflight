# Changelog

## [0.11.0]

- Same version as the CLI: `--staged` and `--baseline` work through `sf preflight analyze`; the pre-commit and agent hooks are CLI commands (`preflight hook`, `preflight agent-hook`).

## [0.10.1]

- Same version as the CLI. The plugin's commands are unchanged.

## [0.10.0]

- Same version as the CLI; the new checks come through `sf preflight analyze` and the other commands.

## [0.9.1]

- Same as 0.9.0, which was never published.

## [0.9.0]

- Adds `sf preflight monitor`.

## [0.8.0]

- First release (the plugin shares the CLI version): `sf preflight analyze | tests | agents | agent-tests | incidents | rollback | explain | evidence`, passing `--target-org` and `--json` through to the sf-preflight CLI.
