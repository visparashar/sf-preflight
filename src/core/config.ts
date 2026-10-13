// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { summarizeFindings } from "./analyze.js";
import { gitRoot, gitShow } from "./changes.js";
import { RULES } from "./rules.js";
import type { AnalysisResult, Severity } from "./types.js";

/**
 * `.preflight.json`: project settings for rules and the quality gate.
 *
 * {
 *   "rules": { "dml-or-soql-in-loop": "high", "legacy-workflow": "off" },
 *   "ignore": { "paths": ["force-app/main/default/classes/Legacy*"] },
 *   "gate": { "failOn": "high", "aiAssistedApprovals": 1, "requireAgentTests": true, "requireTestsPassed": false }
 * }
 */

export type FailOn = "none" | "low" | "medium" | "high";

export interface GateConfig {
  /** Fail when any finding is at or above this severity (default "high"). */
  failOn?: FailOn;
  /** Changes with AI-assisted commits need at least this many approvals (default 0: not required). */
  aiAssistedApprovals?: number;
  /** Agent actions the change affects must be covered by a Testing Center test. */
  requireAgentTests?: boolean;
  /** The generated tests must have run in an org (`preflight tests --validate`) and passed. */
  requireTestsPassed?: boolean;
  /** Testing Center tests for the affected agents must have run (`preflight agent-tests`) and passed. */
  requireAgentTestsPassed?: boolean;
}

export interface PreflightConfig {
  /** Rule id → severity override, or "off" to drop the rule's findings. */
  rules?: Record<string, Severity | "off">;
  ignore?: {
    /** Glob patterns (project-relative; `*`, `**`, `?`): findings whose files all match are dropped. */
    paths?: string[];
  };
  gate?: GateConfig;
  /**
   * Report only findings the change introduces: "base" compares with the base ref, or a path
   * (relative to the project) to a baseline file written by `preflight baseline`.
   */
  baseline?: string;
}

export const CONFIG_FILE = ".preflight.json";

const SEVERITIES = new Set(["high", "medium", "low", "info", "off"]);
const FAIL_ON = new Set(["none", "low", "medium", "high"]);

function fail(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}

/** Validate parsed JSON as a PreflightConfig; unknown keys are errors so typos don't go unnoticed. */
export function parseConfig(json: unknown, file = CONFIG_FILE): PreflightConfig {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(json)) fail(file, "expected a JSON object");
  const known = (obj: Record<string, unknown>, keys: string[], where: string) => {
    for (const k of Object.keys(obj)) {
      if (k === "$schema") continue;
      if (!keys.includes(k)) fail(file, `unknown setting "${where}${k}" (expected one of: ${keys.join(", ")})`);
    }
  };
  known(json, ["rules", "ignore", "gate", "baseline"], "");
  const config: PreflightConfig = {};

  if (json.baseline !== undefined) {
    const b = json.baseline;
    if (typeof b !== "string" || !b || path.isAbsolute(b) || b.split(/[\\/]/).includes(".."))
      fail(file, `"baseline" must be "base" or a path inside the project`);
    config.baseline = b;
  }

  if (json.rules !== undefined) {
    if (!isObject(json.rules)) fail(file, `"rules" must be an object of rule id → severity`);
    const ids = new Set(RULES.map((r) => r.id));
    config.rules = {};
    for (const [id, value] of Object.entries(json.rules)) {
      if (!ids.has(id)) fail(file, `unknown rule "${id}" in "rules" (see docs/RULES.md)`);
      if (typeof value !== "string" || !SEVERITIES.has(value)) {
        fail(file, `"rules.${id}" must be one of high, medium, low, info or off`);
      }
      config.rules[id] = value as Severity | "off";
    }
  }

  if (json.ignore !== undefined) {
    if (!isObject(json.ignore)) fail(file, `"ignore" must be an object`);
    known(json.ignore, ["paths"], "ignore.");
    const paths = json.ignore.paths;
    if (paths !== undefined && (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && p.length))) {
      fail(file, `"ignore.paths" must be a list of glob patterns`);
    }
    config.ignore = { paths: paths as string[] | undefined };
  }

  if (json.gate !== undefined) {
    if (!isObject(json.gate)) fail(file, `"gate" must be an object`);
    const g = json.gate;
    known(
      g,
      ["failOn", "aiAssistedApprovals", "requireAgentTests", "requireTestsPassed", "requireAgentTestsPassed"],
      "gate.",
    );
    if (g.failOn !== undefined && (typeof g.failOn !== "string" || !FAIL_ON.has(g.failOn))) {
      fail(file, `"gate.failOn" must be one of none, low, medium or high`);
    }
    if (
      g.aiAssistedApprovals !== undefined &&
      (typeof g.aiAssistedApprovals !== "number" ||
        !Number.isInteger(g.aiAssistedApprovals) ||
        g.aiAssistedApprovals < 0)
    ) {
      fail(file, `"gate.aiAssistedApprovals" must be a whole number of approvals`);
    }
    for (const k of ["requireAgentTests", "requireTestsPassed", "requireAgentTestsPassed"] as const) {
      if (g[k] !== undefined && typeof g[k] !== "boolean") fail(file, `"gate.${k}" must be true or false`);
    }
    config.gate = {
      failOn: g.failOn as FailOn | undefined,
      aiAssistedApprovals: g.aiAssistedApprovals as number | undefined,
      requireAgentTests: g.requireAgentTests as boolean | undefined,
      requireTestsPassed: g.requireTestsPassed as boolean | undefined,
      requireAgentTestsPassed: g.requireAgentTestsPassed as boolean | undefined,
    };
  }
  return config;
}

const configCandidates = (projectDir: string, explicit?: string) =>
  explicit
    ? [path.resolve(explicit)]
    : [
        path.join(projectDir, CONFIG_FILE),
        ...(() => {
          const root = gitRoot(projectDir);
          return root && path.resolve(root) !== path.resolve(projectDir) ? [path.join(root, CONFIG_FILE)] : [];
        })(),
      ];

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export interface LoadedPolicy {
  config: PreflightConfig;
  /** The policy file, relative to the project, e.g. ".preflight.json" or "../.preflight.json". */
  file?: string;
  /** The git ref it was read from, when not the checkout. */
  ref?: string;
  sha256?: string;
  /** Set when the policy was read from a git ref and the checked-out copy differs. */
  warning?: string;
}

/**
 * Load the policy. With `ref`, it's read from git at that ref (for example the pull request's
 * base branch), so a change can't loosen the policy it's checked against.
 */
export function loadPolicy(projectDir: string, opts: { explicit?: string; ref?: string } = {}): LoadedPolicy {
  const root = gitRoot(projectDir);
  const explicitAbs = opts.explicit ? path.resolve(opts.explicit) : undefined;
  // A policy file outside the repository isn't part of the change: read it from disk.
  const outsideRepo =
    !!explicitAbs &&
    (!root || path.relative(root, explicitAbs).startsWith("..") || path.isAbsolute(path.relative(root, explicitAbs)));
  if (!opts.ref || outsideRepo) {
    const { config, file } = loadConfig(projectDir, opts.explicit);
    if (!file) return { config };
    const rel = path.relative(projectDir, file).split(path.sep).join("/") || CONFIG_FILE;
    return { config, file: rel, sha256: sha256(readFileSync(file)) };
  }
  // The first candidate that exists at the ref is the policy; files only in the checkout (added by
  // the change) can't shadow it.
  const notes: string[] = [];
  for (const abs of configCandidates(projectDir, opts.explicit)) {
    const rel = path.relative(projectDir, abs).split(path.sep).join("/");
    const content = gitShow(projectDir, opts.ref, rel);
    const local = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    if (content === undefined) {
      if (local !== undefined) notes.push(`This change adds ${rel}; it takes effect once merged.`);
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch (err) {
      throw new Error(`${rel} at ${opts.ref}: invalid JSON (${(err as Error).message})`);
    }
    if (local !== content) {
      notes.push(
        local === undefined
          ? `This change removes ${rel}; this run used the version at ${opts.ref}.`
          : `This change edits ${rel}; this run used the version at ${opts.ref}.`,
      );
    }
    return {
      config: parseConfig(json, `${rel} at ${opts.ref}`),
      file: rel,
      ref: opts.ref,
      sha256: sha256(content),
      ...(notes.length ? { warning: notes.join(" ") } : {}),
    };
  }
  if (opts.explicit) throw new Error(`Config file not found at ${opts.ref}: ${opts.explicit}`);
  return {
    config: {},
    ...(notes.length ? { warning: `${notes.join(" ")} This run used the default policy, as at ${opts.ref}.` } : {}),
  };
}

/**
 * Load `.preflight.json` from an explicit path, else the project directory, else the git root.
 * Returns an empty config when there is none.
 */
export function loadConfig(projectDir: string, explicit?: string): { config: PreflightConfig; file?: string } {
  const candidates = configCandidates(projectDir, explicit);
  for (const file of candidates) {
    if (!existsSync(file)) {
      if (explicit) throw new Error(`Config file not found: ${explicit}`);
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`${file}: invalid JSON (${(err as Error).message})`);
    }
    return { config: parseConfig(json, file), file };
  }
  return { config: {} };
}

/**
 * Match a project-relative path against a glob: `**` matches across folders, `*` within one,
 * `?` one character. Dynamic programming, so the time is bounded by pattern × path length.
 */
export function globMatch(pattern: string, file: string): boolean {
  const p = pattern.replace(/^\.\//, "");
  const f = file.replace(/^\.\//, "");
  const memo = new Map<number, boolean>();
  const match = (i: number, j: number): boolean => {
    const k = i * (f.length + 1) + j;
    const cached = memo.get(k);
    if (cached !== undefined) return cached;
    let r: boolean;
    if (i === p.length) r = j === f.length;
    else if (p.startsWith("**/", i)) {
      // "**/" matches zero or more whole folders: skip it, or consume the folder that starts at j.
      const slash = f.indexOf("/", j);
      r = match(i + 3, j) || (slash >= 0 && match(i, slash + 1));
    } else if (p.startsWith("**", i)) {
      // A "**" that isn't followed by "/" matches anything, across folders.
      r = match(i + 2, j) || (j < f.length && match(i, j + 1));
    } else if (p[i] === "*") r = match(i + 1, j) || (j < f.length && f[j] !== "/" && match(i, j + 1));
    else if (p[i] === "?") r = j < f.length && f[j] !== "/" && match(i + 1, j + 1);
    else r = j < f.length && p[i] === f[j] && match(i + 1, j + 1);
    memo.set(k, r);
    return r;
  };
  return match(0, 0);
}

/** Apply rule overrides and ignores to a result (returns a new result with re-counted findings). */
export function applyConfig(result: AnalysisResult, config: PreflightConfig): AnalysisResult {
  const rules = config.rules ?? {};
  const ignored = config.ignore?.paths ?? [];
  const findings = result.findings
    .filter((f) => rules[f.rule] !== "off")
    .filter(
      (f) => !(ignored.length && f.files.length && f.files.every((file) => ignored.some((g) => globMatch(g, file)))),
    )
    .map((f) => {
      const override = rules[f.rule];
      return override && override !== "off" ? { ...f, severity: override } : f;
    });
  const summary = summarizeFindings(findings);
  return {
    ...result,
    findings: summary.findings,
    summary: { ...result.summary, risk: summary.risk, findingsBySeverity: summary.findingsBySeverity },
  };
}
