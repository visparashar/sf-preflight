// SPDX-License-Identifier: Apache-2.0
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git, gitRoot } from "./changes.js";
import type { AnalysisResult, Finding, Severity } from "./types.js";
import { toPosix } from "./util.js";

/**
 * A git pre-commit hook that checks the staged Salesforce metadata before each commit, so a risky
 * change is caught on the developer's machine instead of in the pull request.
 *
 * The hook is a small shell script. It finds the CLI in this order: `$PREFLIGHT_BIN`, the
 * project's own `node_modules/.bin/preflight`, `preflight` on the PATH, then `npx` with the version
 * that installed the hook. `git commit --no-verify` or `PREFLIGHT_SKIP=1` skips it.
 */

export const HOOK_MARKER = "# sf-preflight pre-commit hook";

/** Where git looks for hooks (respects `core.hooksPath`). */
export function hooksDir(repoRoot: string): string {
  const p = git(repoRoot, ["rev-parse", "--git-path", "hooks"]).trim();
  return path.resolve(repoRoot, p);
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function hookScript(projectRel: string, version: string, failOn?: string): string {
  const args = [`-p ${shQuote(projectRel || ".")}`, failOn ? `--fail-on ${shQuote(failOn)}` : ""]
    .filter(Boolean)
    .join(" ");
  return `#!/bin/sh
${HOOK_MARKER} (installed by \`preflight hook install\`; remove with \`preflight hook uninstall\`).
# Checks the staged Salesforce metadata. Skip once with \`git commit --no-verify\` or PREFLIGHT_SKIP=1.
[ "\${PREFLIGHT_SKIP:-}" = "1" ] && exit 0
root="$(git rev-parse --show-toplevel)" || exit 0
cd "$root" || exit 0
if [ -n "\${PREFLIGHT_BIN:-}" ]; then
  set -- $PREFLIGHT_BIN
elif [ -x node_modules/.bin/preflight ]; then
  set -- node_modules/.bin/preflight
elif command -v preflight >/dev/null 2>&1; then
  set -- preflight
else
  set -- npx --yes sf-preflight@${version}
fi
exec "$@" hook run ${args}
`;
}

export interface InstallResult {
  file: string;
  status: "installed" | "updated" | "exists-other";
}

/** Install the hook for the project in `projectDir`. An existing hook that isn't ours is left alone. */
export function installHook(
  projectDir: string,
  opts: { version: string; failOn?: string; force?: boolean },
): InstallResult {
  const dir = path.resolve(projectDir);
  const root = gitRoot(dir);
  if (!root) throw new Error(`Not a git repository: ${dir}`);
  const hooks = hooksDir(root);
  const file = path.join(hooks, "pre-commit");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (existing !== undefined && !existing.includes(HOOK_MARKER) && !opts.force) return { file, status: "exists-other" };
  mkdirSync(hooks, { recursive: true });
  writeFileSync(file, hookScript(toPosix(path.relative(root, dir)), opts.version, opts.failOn));
  chmodSync(file, 0o755);
  return { file, status: existing === undefined ? "installed" : "updated" };
}

/** Remove the hook, only when it is ours. */
export function uninstallHook(projectDir: string): { file: string; removed: boolean } {
  const root = gitRoot(path.resolve(projectDir));
  if (!root) throw new Error(`Not a git repository: ${path.resolve(projectDir)}`);
  const file = path.join(hooksDir(root), "pre-commit");
  if (!existsSync(file) || !readFileSync(file, "utf8").includes(HOOK_MARKER)) return { file, removed: false };
  rmSync(file);
  return { file, removed: true };
}

const RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3 };
const MARK: Record<Severity, string> = { high: "✗ high  ", medium: "! medium", low: "· low   ", info: "· info  " };

/** Findings that block the commit: at or above the threshold. */
export const blocking = (result: AnalysisResult, failOn: Severity | "none"): Finding[] =>
  failOn === "none" ? [] : result.findings.filter((f) => RANK[f.severity] >= RANK[failOn]);

/** The short summary printed when committing. */
export function hookSummary(result: AnalysisResult, failOn: Severity | "none", max = 8): string {
  const shown = result.findings.filter((f) => RANK[f.severity] >= RANK.medium);
  const block = blocking(result, failOn);
  const n = result.changes.length;
  const lines = [
    `sf-preflight: ${result.summary.risk.toUpperCase()} risk in ${n} staged component${n === 1 ? "" : "s"}`,
  ];
  for (const f of shown.slice(0, max))
    lines.push(`  ${MARK[f.severity]}  ${f.title}${f.files[0] ? `  (${f.files[0]})` : ""}`);
  if (shown.length > max) lines.push(`  ... and ${shown.length - max} more`);
  for (const w of result.warnings) lines.push(`  note: ${w}`);
  if (block.length) {
    lines.push(
      "",
      `Commit blocked: ${block.length} finding(s) at or above "${failOn}".`,
      "See them all with `preflight analyze --staged`. Fix them, or skip this check once with `git commit --no-verify`.",
    );
  }
  return lines.join("\n");
}
