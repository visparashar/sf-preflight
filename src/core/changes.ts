// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import path from "node:path";
import { classifyPath } from "./project.js";
import type { Change, ChangeType } from "./types.js";
import { toPosix, uniqBy } from "./util.js";

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Reject git refs that could be parsed as options or contain whitespace/control characters.
 * Refs come from CLI flags, MCP tool calls and CI inputs, so treat them as untrusted.
 */
export function assertSafeRef(ref: string, label = "ref"): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (!ref || ref.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(ref) || ref.includes("..")) {
    throw new Error(`Invalid git ${label}: ${JSON.stringify(ref)}`);
  }
  return ref;
}

/** Absolute path of the git work tree containing `dir`, or undefined when it isn't in one. */
export function gitRoot(dir: string): string | undefined {
  try {
    return git(path.resolve(dir), ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return undefined;
  }
}

/** Whether `ref` names a commit in the repository. */
export function refExists(repoRoot: string, ref: string): boolean {
  try {
    git(repoRoot, ["rev-parse", "--verify", "--quiet", `${assertSafeRef(ref)}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The branches a change is usually compared with, in the order they are tried. */
const DEFAULT_BASES = ["origin/main", "origin/master", "main", "master"];

/**
 * The branch to compare with when none is given: the remote's default branch (`origin/HEAD`), else
 * the first of origin/main, origin/master, main and master that exists. The VS Code extension picks
 * its base the same way. Undefined outside a git repository or when none of them exists.
 */
export function defaultBaseRef(dir: string): string | undefined {
  const root = gitRoot(dir);
  if (!root) return undefined;
  let remoteHead = "";
  try {
    remoteHead = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).trim();
  } catch {
    // no origin, or origin/HEAD isn't set (common after `git remote add`)
  }
  for (const ref of [remoteHead, ...DEFAULT_BASES]) if (ref && refExists(root, ref)) return ref;
  return undefined;
}

/**
 * The commit a comparison starts from: where `head` (by default the current branch) left `base`
 * (`git merge-base`). Commits added to the base branch since then belong to other people's work,
 * not to this change, so they are left out. Falls back to `base` itself when there is no common
 * commit (a shallow clone or unrelated histories).
 */
export function comparisonBase(dir: string, base: string, head = "HEAD"): string {
  assertSafeRef(base, "base ref");
  assertSafeRef(head, "head ref");
  const root = gitRoot(dir);
  if (!root) return base;
  try {
    return git(root, ["merge-base", base, head]).trim() || base;
  } catch {
    return base;
  }
}

/** Branches to suggest when a ref can't be found: likely bases first, then the rest. */
function branchSuggestions(repoRoot: string, max = 6): string[] {
  let names: string[] = [];
  try {
    names = git(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"])
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.endsWith("/HEAD") && s !== "origin");
  } catch {
    return [];
  }
  const rank = (n: string) => {
    const i = DEFAULT_BASES.indexOf(n);
    if (i >= 0) return i;
    return /(^|\/)(develop|dev|release|staging|uat)\b/.test(n) ? 10 : 20;
  };
  return [...new Set(names)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, max);
}

function hasRemote(repoRoot: string, name: string): boolean {
  try {
    return git(repoRoot, ["remote"]).split("\n").includes(name);
  } catch {
    return false;
  }
}

/** An error that says which ref is missing and what to try instead. */
export function missingRefError(repoRoot: string, ref: string, label = "base ref"): Error {
  const lines = [`Can't find the git ${label} "${ref}" in this repository.`];
  const suggestions = branchSuggestions(repoRoot);
  if (suggestions.length) lines.push(`Branches you could compare with: ${suggestions.join(", ")}`);
  else lines.push("This repository has no other branches yet; commit your work on a branch first.");
  if (isShallow(repoRoot)) {
    const branch = ref.replace(/^origin\//, "");
    lines.push(
      `This is a shallow clone, so other branches may be missing: run \`git fetch origin ${branch}\` (in GitHub Actions, use actions/checkout with fetch-depth: 0).`,
    );
  } else if (ref.startsWith("origin/") && hasRemote(repoRoot, "origin")) {
    lines.push(`If the branch exists on the remote, fetch it first: git fetch origin ${ref.slice("origin/".length)}`);
  }
  return new Error(lines.join("\n"));
}

/** The error for a folder outside git, with the way to analyze without git. */
export function notGitError(dir: string): Error {
  return new Error(
    `${dir} is not inside a git repository, so there is no change to compare.\nAnalyze specific files instead with --files <paths...>, or run preflight from your project's git checkout.`,
  );
}

export interface GitDiffOptions {
  projectDir: string;
  base: string;
  /** Head ref. When omitted, compares base against the working tree (including untracked files). */
  head?: string;
}

const STATUS: Record<string, ChangeType> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "added",
  T: "modified",
};

/** Changed files between two refs, restricted to the project directory, as project-relative paths. */
export function gitChangedFiles(
  opts: GitDiffOptions,
): { file: string; changeType: ChangeType; previousFile?: string }[] {
  const projectDir = path.resolve(opts.projectDir);
  assertSafeRef(opts.base, "base ref");
  if (opts.head) assertSafeRef(opts.head, "head ref");
  const repoRoot = gitRoot(projectDir);
  if (!repoRoot) throw notGitError(projectDir);
  if (!refExists(repoRoot, opts.base)) throw missingRefError(repoRoot, opts.base);
  if (opts.head && !refExists(repoRoot, opts.head)) throw missingRefError(repoRoot, opts.head, "head ref");
  // Against the working tree, start where this branch left the base (as `base...head` does), so
  // commits merged into the base since then aren't reported as part of this change.
  const range = opts.head ? [`${opts.base}...${opts.head}`] : [comparisonBase(repoRoot, opts.base)];
  const out = git(repoRoot, ["diff", "--name-status", "-M", ...range, "--", projectDir]);

  const toProjectRel = (repoRel: string) => toPosix(path.relative(projectDir, path.join(repoRoot, repoRel)));
  const results: { file: string; changeType: ChangeType; previousFile?: string }[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const code = cols[0]![0]!;
    const changeType = STATUS[code] ?? "modified";
    if (changeType === "renamed" && cols.length >= 3) {
      results.push({ file: toProjectRel(cols[2]!), changeType, previousFile: toProjectRel(cols[1]!) });
    } else if (cols[1]) {
      results.push({ file: toProjectRel(cols[1]), changeType });
    }
  }
  if (!opts.head) {
    const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard", "--", projectDir]);
    for (const f of untracked.split("\n")) {
      if (f.trim()) results.push({ file: toProjectRel(f.trim()), changeType: "added" });
    }
  }
  return results.filter((r) => !r.file.startsWith(".."));
}

/**
 * Files staged for the next commit (`git diff --cached`), as project-relative paths, and which of
 * them also have unstaged edits (the analysis reads the working tree, so those are checked as edited).
 */
export function gitStagedFiles(projectDir: string): {
  files: { file: string; changeType: ChangeType; previousFile?: string }[];
  partlyStaged: string[];
} {
  const dir = path.resolve(projectDir);
  const repoRoot = gitRoot(dir);
  if (!repoRoot) throw notGitError(dir);
  const toProjectRel = (repoRel: string) => toPosix(path.relative(dir, path.join(repoRoot, repoRel)));
  const files: { file: string; changeType: ChangeType; previousFile?: string }[] = [];
  for (const line of git(repoRoot, ["diff", "--cached", "--name-status", "-M", "--", dir]).split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const changeType = STATUS[cols[0]![0]!] ?? "modified";
    if (changeType === "renamed" && cols.length >= 3)
      files.push({ file: toProjectRel(cols[2]!), changeType, previousFile: toProjectRel(cols[1]!) });
    else if (cols[1]) files.push({ file: toProjectRel(cols[1]), changeType });
  }
  const unstaged = new Set(
    git(repoRoot, ["diff", "--name-only", "--", dir]).split("\n").filter(Boolean).map(toProjectRel),
  );
  const inside = files.filter((f) => !f.file.startsWith(".."));
  return { files: inside, partlyStaged: inside.filter((f) => unstaged.has(f.file)).map((f) => f.file) };
}

/** Whether the repository has a commit yet (a first commit has nothing to compare with). */
export function hasHead(projectDir: string): boolean {
  try {
    git(path.resolve(projectDir), ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** Read a file's content at a git ref (used to diff permission sets against the base). */
export function gitShow(projectDir: string, ref: string, projectRelFile: string): string | undefined {
  try {
    assertSafeRef(ref);
    const abs = path.resolve(projectDir, projectRelFile);
    const repoRoot = gitRoot(projectDir);
    if (!repoRoot) return undefined;
    const repoRel = toPosix(path.relative(repoRoot, abs));
    return execFileSync("git", ["show", `${ref}:${repoRel}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/** A file's bytes at a git ref (path relative to the repository root); undefined when absent. */
export function gitBlob(repoRoot: string, ref: string, repoRelFile: string): Buffer | undefined {
  try {
    assertSafeRef(ref);
    return execFileSync("git", ["cat-file", "blob", `${ref}:${toPosix(repoRelFile)}`], {
      cwd: repoRoot,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/** Is the repository a shallow clone (history cut off)? */
export function isShallow(repoRoot: string): boolean {
  try {
    return git(repoRoot, ["rev-parse", "--is-shallow-repository"]).trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Turn changed files into component changes. Companion files (`Foo.cls` + `Foo.cls-meta.xml`)
 * collapse into one change.
 */
export function toChanges(files: { file: string; changeType: ChangeType; previousFile?: string }[]): {
  changes: Change[];
  ignored: string[];
} {
  const changes: Change[] = [];
  const ignored: string[] = [];
  for (const f of files) {
    const component = classifyPath(f.file);
    if (component.type === "Other") {
      ignored.push(f.file);
      continue;
    }
    changes.push({ changeType: f.changeType, component, previousFile: f.previousFile });
  }
  return {
    changes: uniqBy(changes, (c) => `${c.component.type}|${c.component.name.toLowerCase()}`),
    ignored,
  };
}

/** Normalise user-supplied file paths (absolute or relative to cwd) to project-relative paths. */
export function filesFromArgs(projectDir: string, files: string[]): { file: string; changeType: ChangeType }[] {
  const root = path.resolve(projectDir);
  return files.map((f) => {
    const abs = path.resolve(f);
    const rel = abs.startsWith(root) ? path.relative(root, abs) : f;
    return { file: toPosix(rel), changeType: "modified" as ChangeType };
  });
}
