// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultBaseRef, git, gitRoot } from "./changes.js";
import { toPosix } from "./util.js";

const SCHEMA_URL = "https://raw.githubusercontent.com/visparashar/sf-preflight/main/schema/preflight.schema.json";

export interface InitOptions {
  projectDir: string;
  /** Replace files that already exist. */
  force?: boolean;
  /** Say what would be written without writing anything. */
  dryRun?: boolean;
  /** Write the GitHub Actions workflow: true, false, or undefined to decide from the git remote. */
  workflow?: boolean;
}

export type InitStatus = "created" | "replaced" | "exists" | "would create" | "would replace";

export interface InitFile {
  /** Path relative to the project. */
  file: string;
  what: string;
  status: InitStatus;
}

export interface InitResult {
  files: InitFile[];
  /** The branch pull requests are compared with, as detected (without `origin/`). */
  baseBranch: string;
  /** Why the workflow wasn't written, when it wasn't. */
  workflowSkipped?: string;
  gitRoot?: string;
}

/** The starter policy: fail on high findings, and only on findings the change introduces. */
export function starterPolicy(): string {
  return `${JSON.stringify(
    {
      $schema: SCHEMA_URL,
      // Existing findings don't fail pull requests; only what each change introduces does.
      baseline: "base",
      gate: { failOn: "high" },
    },
    null,
    2,
  )}\n`;
}

/** The pull request workflow from docs/GITHUB_ACTION.md, for this repository's layout. */
export function starterWorkflow(baseBranch: string, projectInRepo: string): string {
  const project = projectInRepo && projectInRepo !== "." ? `\n        with:\n          project: ${projectInRepo}` : "";
  return `# sf-preflight: what each pull request's Salesforce changes set off.
# Docs: https://github.com/visparashar/sf-preflight/blob/main/docs/GITHUB_ACTION.md
name: Preflight

on:
  pull_request:
  # Re-evaluate the gate when someone approves (or dismisses an approval).
  pull_request_review:
    types: [submitted, dismissed]
  # Evidence for the merged change.
  push:
    branches: [${baseBranch}]

permissions:
  contents: read
  pull-requests: write # PR comment, and reading reviews for the gate

jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # needed to diff against the base branch and read commit history
      - uses: visparashar/sf-preflight@v0${project}
`;
}

function isGitHub(root: string): boolean {
  if (existsSync(path.join(root, ".github"))) return true;
  try {
    return /github\.com[:/]/i.test(git(root, ["remote", "get-url", "origin"]));
  } catch {
    return false;
  }
}

/**
 * Set a project up for sf-preflight: a starter `.preflight.json` and, on GitHub, the pull request
 * workflow. Files that exist are left alone unless `force` is set.
 */
export function initProject(opts: InitOptions): InitResult {
  const projectDir = path.resolve(opts.projectDir);
  const root = gitRoot(projectDir);
  const detected = defaultBaseRef(projectDir);
  const baseBranch = detected ? detected.replace(/^origin\//, "") : "main";
  const files: InitFile[] = [];

  const put = (abs: string, what: string, content: string) => {
    const exists = existsSync(abs);
    const file = toPosix(path.relative(projectDir, abs));
    if (exists && !opts.force) {
      files.push({ file, what, status: "exists" });
      return;
    }
    if (opts.dryRun) {
      files.push({ file, what, status: exists ? "would replace" : "would create" });
      return;
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    files.push({ file, what, status: exists ? "replaced" : "created" });
  };

  put(path.join(projectDir, ".preflight.json"), "policy: gate on high findings the change introduces", starterPolicy());

  let workflowSkipped: string | undefined;
  if (!root) workflowSkipped = "not a git repository";
  else if (opts.workflow === false) workflowSkipped = "--no-workflow";
  else if (opts.workflow === undefined && !isGitHub(root)) workflowSkipped = "the repository isn't on GitHub";
  else {
    const inRepo = toPosix(path.relative(root, projectDir)) || ".";
    put(
      path.join(root, ".github", "workflows", "preflight.yml"),
      "GitHub Actions: report and gate on every pull request",
      starterWorkflow(baseBranch, inRepo),
    );
  }
  return { files, baseBranch, workflowSkipped, gitRoot: root };
}
