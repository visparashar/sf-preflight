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
  if (!repoRoot) throw new Error(`Not a git repository: ${projectDir}`);
  const range = opts.head ? [`${opts.base}...${opts.head}`] : [opts.base];
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
  if (!repoRoot) throw new Error(`Not a git repository: ${dir}`);
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
