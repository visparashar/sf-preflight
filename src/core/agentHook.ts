// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gitRoot } from "./changes.js";
import { analyzeChange } from "./index.js";
import { classifyPath } from "./project.js";
import type { AnalysisResult, Severity } from "./types.js";

/**
 * A hook for AI coding agents: right after the agent edits a Salesforce metadata file, check what the
 * edit introduces and hand the findings back to the agent, so it fixes them in the same turn.
 *
 * Built for Claude Code's PostToolUse hook (JSON on stdin with `tool_input.file_path`; a JSON answer
 * with `decision: "block"` and a `reason` goes back to the agent). Other agents can pass `--file`.
 */

const RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3 };

/** The files an agent tool call wrote (Write, Edit, MultiEdit). */
export function editedFiles(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const ti = (input as { tool_input?: Record<string, unknown> }).tool_input;
  const files = [ti?.file_path, ti?.path].filter((f): f is string => typeof f === "string" && f.length > 0);
  return [...new Set(files)];
}

/** The SFDX project a file belongs to: the nearest folder with sfdx-project.json, inside the repository. */
export function projectOf(file: string): string | undefined {
  const stop = gitRoot(path.dirname(file));
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (existsSync(path.join(dir, "sfdx-project.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir || (stop && path.relative(stop, up).startsWith(".."))) return undefined;
    dir = up;
  }
}

export interface AgentHookResult {
  /** What to print on stdout: Claude Code's hook JSON, or nothing. */
  output?: { decision: "block"; reason: string };
  result?: AnalysisResult;
}

/** Check the edited files. Only findings the edit introduces (compared with HEAD) are reported. */
export function runAgentHook(files: string[], opts: { failOn?: Severity; cwd?: string } = {}): AgentHookResult {
  const failOn = opts.failOn ?? "medium";
  const abs = files.map((f) => path.resolve(opts.cwd ?? process.cwd(), f));
  const metadata = abs.filter((f) => classifyPath(f.split(path.sep).join("/")).type !== "Other");
  const projectDir = metadata.length ? projectOf(metadata[0]!) : undefined;
  if (!projectDir) return {};
  const ours = metadata.filter((f) => projectOf(f) === projectDir);
  const inGit = !!gitRoot(projectDir);
  const { result } = analyzeChange({
    projectDir,
    files: ours,
    base: inGit ? "HEAD" : undefined,
    baseline: inGit ? "base" : undefined,
  });
  const relevant = result.findings.filter((f) => RANK[f.severity] >= RANK[failOn]);
  if (!relevant.length) return { result };
  const rel = (f: string) => path.relative(projectDir, f).split(path.sep).join("/");
  const lines = [
    `sf-preflight checked ${ours.map(rel).join(", ")}: ${relevant.length} finding(s) this edit introduces (${result.summary.risk} risk).`,
    ...relevant
      .slice(0, 8)
      .map((f) => `- [${f.severity}] ${f.title}: ${f.detail}${f.files[0] ? ` (${f.files[0]})` : ""}`),
    relevant.length > 8 ? `- … and ${relevant.length - 8} more (run \`preflight analyze --base HEAD\`).` : "",
    "Fix these in your change, or explain to the user why they are acceptable.",
  ].filter(Boolean);
  return { output: { decision: "block", reason: lines.join("\n") }, result };
}

// ---- Installing into Claude Code -------------------------------------------------------------

const MATCHER = "Write|Edit|MultiEdit";

/**
 * Add the hook to `.claude/settings.json` at the repository root (Claude Code's project settings).
 * Other settings and hooks are kept; running it twice changes nothing.
 */
export function installAgentHook(
  projectDir: string,
  command: string,
): { file: string; status: "installed" | "present" } {
  const root = gitRoot(projectDir) ?? path.resolve(projectDir);
  const file = path.join(root, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`Cannot read ${file}: ${(err as Error).message}`);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error(`${file} is not a JSON object.`);
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const post = Array.isArray(hooks.PostToolUse)
    ? (hooks.PostToolUse as { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] }[])
    : [];
  if (post.some((g) => g.hooks?.some((h) => typeof h.command === "string" && h.command.includes("agent-hook"))))
    return { file, status: "present" };
  post.push({ matcher: MATCHER, hooks: [{ type: "command", command, timeout: 120 }] });
  settings.hooks = { ...hooks, PostToolUse: post };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { file, status: "installed" };
}
