// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cacheDir } from "./core/parseCache.js";
import { dueForCheck, noticeFor, RELEASES_URL, readUpdateState, writeUpdateState } from "./core/updateCheck.js";

/**
 * The command line's "a newer version is available" banner.
 *
 * Shown on stderr when the command ends, at most once a day, and only to a person at a terminal:
 * never in CI, in git hooks, to an agent (the MCP server and the agent hook speak JSON), or when
 * stderr is redirected. The registry is asked at most once a day by a detached process, so the
 * command never waits on the network; its answer is shown from the next run on.
 * `PREFLIGHT_NO_UPDATE_CHECK=1` (or `NO_UPDATE_NOTIFIER=1`) turns it off.
 */

/** Commands whose output is read by a program, or that run unattended. */
const QUIET_COMMANDS = new Set(["mcp", "agent-hook", "hook", "notify", "monitor"]);

export interface NoticeEnv {
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
}

export function updateCheckEnabled(command: string | undefined, { env, isTTY }: NoticeEnv): boolean {
  if (!isTTY) return false;
  if (command && QUIET_COMMANDS.has(command)) return false;
  for (const v of ["PREFLIGHT_NO_UPDATE_CHECK", "NO_UPDATE_NOTIFIER", "CI"])
    if (env[v] && env[v] !== "0" && env[v] !== "false") return false;
  return true;
}

/** How this copy was started, for the update command to suggest. */
export function installHint(scriptPath: string, cwd: string): string {
  const p = scriptPath.split(path.sep).join("/");
  if (p.includes("/_npx/")) return "npx sf-preflight@latest";
  const local = `${cwd.split(path.sep).join("/")}/node_modules/`;
  if (p.startsWith(local)) return "npm install --save-dev sf-preflight@latest";
  return "npm install -g sf-preflight@latest";
}

/** The banner, boxed; colored unless NO_COLOR is set. */
export function banner(latest: string, current: string, hint: string, color: boolean): string {
  const lines = [
    `sf-preflight ${latest} is available (you have ${current})`,
    `Update: ${hint}`,
    `What's new: ${RELEASES_URL}`,
  ];
  const width = Math.max(...lines.map((l) => l.length));
  const y = (s: string) => (color ? `\x1b[33m${s}\x1b[0m` : s);
  const b = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s);
  return [
    y(`╭${"─".repeat(width + 4)}╮`),
    ...lines.map((l, i) => `${y("│")}  ${i === 0 ? b(l) : l}${" ".repeat(width - l.length)}  ${y("│")}`),
    y(`╰${"─".repeat(width + 4)}╯`),
  ].join("\n");
}

/**
 * Start the check for a command that is about to run: ask the registry if due, and print the banner
 * when the process ends. Returns without doing anything when the check is off for this run.
 */
export function startUpdateCheck(opts: {
  command: string | undefined;
  version: string;
  scriptPath: string;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  file?: string;
  /** Starts the background request (replaced in tests). */
  refresh?: (file: string) => void;
}): void {
  const env = opts.env ?? process.env;
  if (!updateCheckEnabled(opts.command, { env, isTTY: opts.isTTY ?? !!process.stderr.isTTY })) return;
  const file = opts.file ?? path.join(cacheDir(), "update-check.json");
  const state = readUpdateState(file);
  if (dueForCheck(state, Date.now())) {
    // Recorded as checked now, so a slow or failed request isn't retried on every run.
    writeUpdateState(file, { ...state, checkedAt: Date.now() });
    (opts.refresh ?? refreshInBackground)(file);
  }
  process.once("exit", () => {
    const now = Date.now();
    // Read again: the background request may have recorded a newer answer meanwhile.
    const current = readUpdateState(file);
    const latest = noticeFor(current, opts.version, now);
    if (!latest) return;
    writeUpdateState(file, { ...current, notifiedAt: now });
    const color = !env.NO_COLOR;
    process.stderr.write(`\n${banner(latest, opts.version, installHint(opts.scriptPath, process.cwd()), color)}\n`);
  });
}

/** Ask the registry from a detached process that outlives this one. */
function refreshInBackground(file: string): void {
  try {
    const worker = fileURLToPath(new URL("./updateCheckWorker.js", import.meta.url));
    spawn(process.execPath, [worker, file], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // no check this time
  }
}
