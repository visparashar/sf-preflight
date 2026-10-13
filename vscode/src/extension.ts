// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { acceptIntoBaseline, CONDITION_RULES } from "../../src/core/baseline.js";
import type { FailOn } from "../../src/core/config.js";
import type { Insight } from "../../src/core/insight.js";
import { installSkill } from "../../src/core/skill.js";
import type { AnalysisResult, SaveEvent, SaveProcedure, Severity } from "../../src/core/types.js";
import { fetchLatestVersion, OPEN_VSX_URL, RELEASES_URL } from "../../src/core/updateCheck.js";
import { addToHistory, type HistoryEntry, historyEntryOf, readHistory } from "./dashboard.js";
import { DashboardPanel, type DashboardSource } from "./dashboard-panel.js";
import { GraphPanel, type GraphSource } from "./graph-panel.js";
import { isMetadataFile, locate, problemsOf, RULES_URL, type Span, statusOf, type TreeNode, treeOf } from "./model.js";
import { checkForExtensionUpdate } from "./updateCheck.js";
import type { WorkerRequest } from "./worker.js";
import { WorkerPool } from "./workerPool.js";

/** The parts of VS Code's MCP API (1.101+) the extension uses; absent in older editors. */
interface McpApi {
  lm?: {
    registerMcpServerDefinitionProvider?: (
      id: string,
      provider: {
        onDidChangeMcpServerDefinitions?: vscode.Event<void>;
        provideMcpServerDefinitions: () => unknown[];
      },
    ) => vscode.Disposable;
  };
  McpStdioServerDefinition: new (
    label: string,
    command: string,
    args: string[],
    env: Record<string, string>,
    version: string,
  ) => unknown;
}

interface ProjectState {
  dir: string;
  /** Workspace folder name, shown when there are several projects. */
  label: string;
  result?: AnalysisResult;
  markdown?: string;
  /** The gate's threshold from .preflight.json. */
  failOn?: FailOn;
  /** The branch checked out at the last analysis, for the dashboard's history. */
  branch?: string;
  error?: string;
  /** The analysis in progress; changes while it runs ask for one more run afterwards. */
  inflight?: Promise<void>;
  again?: boolean;
}

const SEVERITY: Record<Severity, vscode.DiagnosticSeverity> = {
  high: vscode.DiagnosticSeverity.Error,
  medium: vscode.DiagnosticSeverity.Warning,
  low: vscode.DiagnosticSeverity.Information,
  // Hints don't appear in the Problems panel, so info findings are shown as information too.
  info: vscode.DiagnosticSeverity.Information,
};
const SEVERITIES: Severity[] = ["high", "medium", "low", "info"];

/** Settings for a project: `baseRef` can differ per workspace folder. */
const config = (dir?: string) =>
  vscode.workspace.getConfiguration("sfPreflight", dir ? vscode.Uri.file(dir) : undefined);

/** The hosted report viewer; `sfPreflight.viewerUrl` points elsewhere (a self-hosted copy). */
const VIEWER_URL = "https://sf-preflight-web.vercel.app/";

function viewerUrl(): string {
  const configured = String(config().get("viewerUrl") ?? "").trim();
  try {
    const url = new URL(configured || VIEWER_URL);
    return url.protocol === "https:" ? url.href : VIEWER_URL;
  } catch {
    return VIEWER_URL;
  }
}

/** Pause after the last keystroke before analyzing unsaved edits. */
const TYPING_DELAY_MS = 1200;

/** Projects analyzed at the same time, so a monorepo doesn't load every project at once. */
const MAX_PARALLEL = 2;
/** Projects looked for in the workspace. */
const MAX_PROJECTS = 50;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("git", args, { cwd, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))),
  );
}

/**
 * The commit to compare with: where the current branch left the base branch, so changes merged
 * into the base since then don't show up as this branch's changes. `HEAD` means uncommitted work.
 */
async function resolveBase(dir: string): Promise<{ base: string; label: string }> {
  const configured = String(config(dir).get("baseRef") ?? "").trim();
  if (configured === "HEAD") return { base: "HEAD", label: "HEAD (uncommitted changes)" };
  const candidates = configured
    ? [configured]
    : [
        await git(dir, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).catch(() => ""),
        "origin/main",
        "origin/master",
        "main",
        "master",
      ].filter(Boolean);
  for (const ref of candidates) {
    try {
      const sha = await git(dir, ["merge-base", ref, "HEAD"]);
      if (/^[0-9a-f]{40,64}$/.test(sha)) return { base: sha, label: ref };
    } catch {
      // try the next one
    }
  }
  if (configured) throw new Error(`Can't compare with "${configured}": no such branch or commit in this repository.`);
  return { base: "HEAD", label: "HEAD (uncommitted changes)" };
}

/** A limit on how many jobs run at once. */
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await job();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

let pool: WorkerPool | undefined;

const EXTENSION_ID = "visparashar.sf-preflight-vscode";

/** A little after start-up, tell the user about a newer release (see updateCheck.ts). */
function scheduleUpdateCheck(context: vscode.ExtensionContext, current: string): void {
  // Not in tests or while developing the extension, and only with somewhere to remember the answer.
  if (!context.globalState || context.extensionMode !== vscode.ExtensionMode.Production) return;
  if (process.env.PREFLIGHT_NO_UPDATE_CHECK) return;
  if (vscode.workspace.getConfiguration("sfPreflight").get<boolean>("checkForUpdates") === false) return;
  const timer = setTimeout(() => {
    void checkForExtensionUpdate({
      current,
      now: Date.now(),
      state: context.globalState,
      fetchLatest: () => fetchLatestVersion(OPEN_VSX_URL),
      show: (message, ...items) => vscode.window.showInformationMessage(message, ...items),
      openExtension: () => void vscode.commands.executeCommand("extension.open", EXTENSION_ID),
      openReleaseNotes: () => void vscode.env.openExternal(vscode.Uri.parse(RELEASES_URL)),
    }).catch(() => undefined);
  }, 15_000);
  timer.unref?.();
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}

function runWorker<T>(context: vscode.ExtensionContext, req: WorkerRequest): Promise<T> {
  pool ??= new WorkerPool(path.join(context.extensionPath, "dist", "worker.js"), {
    size: MAX_PARALLEL,
    idleMs: 5 * 60_000,
    timeoutMs: 120_000,
    timeoutMessage: "sf-preflight took longer than 2 minutes and was stopped.",
  });
  return pool.run<T>(req);
}

/** Is `file` inside `dir`? (Not on another drive, not a sibling with a longer name.) */
function inside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

class BlastRadiusProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(private readonly projects: () => ProjectState[]) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.children?.length
        ? node.expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.description = node.description;
    item.tooltip = node.tooltip;
    if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
    if (node.command) item.command = { command: node.command, title: node.label };
    if (node.file && existsSync(node.file)) {
      const line = node.line ?? 0;
      item.command = {
        command: "vscode.open",
        title: "Open",
        arguments: [vscode.Uri.file(node.file), { selection: new vscode.Range(line, 0, line, 0) }],
      };
    }
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (node) return node.children ?? [];
    const projects = this.projects();
    const nodesOf = (p: ProjectState): TreeNode[] =>
      p.inflight && !p.result
        ? [{ label: "Analyzing…", icon: "loading~spin" }]
        : p.error
          ? [{ label: "Couldn't analyze", description: p.error, tooltip: p.error, icon: "error" }]
          : p.result
            ? treeOf(p.result, p.result.base ? `vs ${p.result.base.slice(0, 12)}` : undefined)
            : [];
    if (projects.length === 1) return nodesOf(projects[0]!);
    return projects.map((p) => ({
      label: p.label,
      description: p.result ? `risk ${p.result.summary.risk}` : undefined,
      icon: "folder",
      expanded: true,
      children: nodesOf(p),
    }));
  }
}

/** Text of a file as the editor shows it: the open document's (unsaved edits included), else from disk. */
function openText(file: string): string | undefined {
  const doc = vscode.workspace.textDocuments.find((d) => (d.uri.scheme ?? "file") === "file" && d.uri.fsPath === file);
  if (doc) return doc.getText();
  // One open file for the size check and the read.
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    return fstatSync(fd).size > 2_000_000 ? undefined : readFileSync(fd, "utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Unsaved metadata edits in a project, by absolute path. */
function unsavedIn(dir: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const d of vscode.workspace.textDocuments) {
    if (d.isDirty && (d.uri.scheme ?? "file") === "file" && isMetadataFile(d.uri.fsPath) && inside(dir, d.uri.fsPath))
      out[d.uri.fsPath] = d.getText();
  }
  return Object.keys(out).length ? out : undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const projects = new Map<string, ProjectState>();
  /** Bumped after every analysis; cached CodeLens insights from an older one are recomputed. */
  let generation = 0;
  const lensChanged = new vscode.EventEmitter<void>();
  const diagnostics = vscode.languages.createDiagnosticCollection("sf-preflight");
  const tree = new BlastRadiusProvider(() => [...projects.values()]);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "sfPreflight.showDashboard";
  const output = vscode.window.createOutputChannel("sf-preflight");
  const slot = limiter(MAX_PARALLEL);
  const extensionVersion = String((context.extension?.packageJSON as { version?: string } | undefined)?.version ?? "0");
  scheduleUpdateCheck(context, extensionVersion);
  context.subscriptions.push(
    diagnostics,
    status,
    output,
    vscode.window.registerTreeDataProvider("sfPreflight.blastRadius", tree),
  );

  function render(): void {
    diagnostics.clear();
    const configured = config().get<string>("minSeverity") as Severity;
    const minSeverity = SEVERITIES.includes(configured) ? configured : "low";
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const texts = new Map<string, string | undefined>();
    const textOf = (file: string): string | undefined => {
      if (!texts.has(file)) texts.set(file, openText(file));
      return texts.get(file);
    };
    for (const p of projects.values()) {
      if (!p.result) continue;
      for (const prob of problemsOf(p.result, minSeverity)) {
        // Underline the element the finding is about, not the whole first line.
        const text = textOf(prob.file);
        const at: Span = text === undefined ? { line: prob.line, start: 0, end: 1000 } : locate(text, prob);
        const d = new vscode.Diagnostic(
          new vscode.Range(at.line, at.start, at.line, at.end),
          prob.message,
          SEVERITY[prob.severity],
        );
        d.source = "sf-preflight";
        d.code = { value: prob.rule, target: vscode.Uri.parse(`${RULES_URL}#${prob.rule}`) };
        d.relatedInformation = prob.related.map(
          (f) =>
            new vscode.DiagnosticRelatedInformation(
              new vscode.Location(vscode.Uri.file(f), new vscode.Position(0, 0)),
              "Also involved",
            ),
        );
        const list = byFile.get(prob.file) ?? [];
        list.push(d);
        byFile.set(prob.file, list);
      }
    }
    for (const [file, list] of byFile) diagnostics.set(vscode.Uri.file(file), list);
    const s = statusOf([...projects.values()].flatMap((p) => (p.result ? [p.result] : [])));
    status.text = [...projects.values()].some((p) => p.inflight) ? "$(sync~spin) Preflight" : s.text;
    status.tooltip = s.tooltip;
    status.backgroundColor =
      s.level === "error"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : s.level === "warning"
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
    status.show();
    tree.refresh();
    GraphPanel.refresh();
    DashboardPanel.refresh();
  }

  // The dashboard's trend: recent analyses per project and branch, kept in VS Code's storage for
  // this workspace on this computer.
  const historyKey = (p: ProjectState) => `sfPreflight.history:${p.dir}:${p.branch ?? "HEAD"}`;
  const historyOf = (p: ProjectState): HistoryEntry[] => readHistory(context.workspaceState?.get(historyKey(p)));
  function record(p: ProjectState): void {
    if (!p.result || !context.workspaceState) return;
    void context.workspaceState.update(historyKey(p), addToHistory(historyOf(p), historyEntryOf(p.result)));
  }

  async function analyzeOnce(p: ProjectState): Promise<void> {
    try {
      const { base, label } = await resolveBase(p.dir);
      p.branch = (await git(p.dir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")) || undefined;
      const value = await slot(() =>
        runWorker<{ result: AnalysisResult; markdown: string; failOn: FailOn }>(context, {
          kind: "analyze",
          projectDir: p.dir,
          base,
          depth: config(p.dir).get<number>("depth") ?? 4,
          overlay: unsavedIn(p.dir),
        }),
      );
      value.result.base = label;
      p.result = value.result;
      p.markdown = value.markdown;
      p.failOn = value.failOn;
      p.error = undefined;
      record(p);
      output.appendLine(
        `${new Date().toISOString()} ${p.dir}: risk ${p.result.summary.risk}, ${p.result.findings.length} finding(s) vs ${label}`,
      );
    } catch (err) {
      p.error = (err as Error).message;
      output.appendLine(`${new Date().toISOString()} ${p.dir}: ${p.error}`);
    }
  }

  /**
   * One analysis per project at a time. A request while one runs asks for a single further run
   * once it ends, so the result shown is never older than the last change.
   */
  function analyze(p: ProjectState): Promise<void> {
    if (p.inflight) {
      p.again = true;
      return p.inflight;
    }
    p.inflight = (async () => {
      do {
        p.again = false;
        await analyzeOnce(p);
        render();
      } while (p.again && projects.get(p.dir) === p);
    })().finally(() => {
      p.inflight = undefined;
      generation++;
      lensChanged.fire();
      render();
    });
    render();
    return p.inflight;
  }

  async function discover(): Promise<void> {
    // Undefined excludes apply the user's files.exclude; dependency and tool folders are dropped too.
    const files = await vscode.workspace.findFiles("**/sfdx-project.json", undefined, MAX_PROJECTS);
    const dirs = [
      ...new Set(
        files
          .filter((f) => (f.scheme ?? "file") === "file")
          .map((f) => path.dirname(f.fsPath))
          .filter((d) => !d.split(path.sep).some((part) => ["node_modules", ".sf", ".sfdx"].includes(part))),
      ),
    ].sort();
    for (const dir of [...projects.keys()]) if (!dirs.includes(dir)) projects.delete(dir);
    for (const dir of dirs) {
      if (!projects.has(dir)) {
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(dir));
        const rel = folder ? path.relative(folder.uri.fsPath, dir) : "";
        projects.set(dir, { dir, label: [folder?.name, rel].filter(Boolean).join("/") || path.basename(dir) });
      }
    }
    await vscode.commands.executeCommand("setContext", "sfPreflight.hasProject", projects.size > 0);
  }

  /** Projects appeared or went away: forget the gone ones' results and analyze the new ones. */
  async function rediscover(): Promise<void> {
    await discover();
    render();
    for (const p of projects.values()) if (!p.result && !p.inflight) void analyze(p);
  }

  const projectOf = (file: string) =>
    [...projects.values()].filter((p) => inside(p.dir, file)).sort((a, b) => b.dir.length - a.dir.length)[0];

  async function pickProject(): Promise<ProjectState | undefined> {
    const all = [...projects.values()];
    if (all.length <= 1) return all[0];
    // The project of the file being edited first.
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    const preferred = active ? projectOf(active) : undefined;
    const ordered = preferred ? [preferred, ...all.filter((p) => p !== preferred)] : all;
    const pick = await vscode.window.showQuickPick(
      ordered.map((p) => ({ label: p.label, description: p.dir, p })),
      { placeHolder: "Salesforce DX project" },
    );
    return pick?.p;
  }

  // Re-analyze shortly after metadata changes, whoever made them (the editor, a terminal, git,
  // sf project retrieve); several changes in a row trigger one run.
  const timers = new Map<string, NodeJS.Timeout>();
  const typingTimers = new Map<string, NodeJS.Timeout>();
  function scheduleProject(p: ProjectState): void {
    if (!config(p.dir).get<boolean>("analyzeOnSave", true)) return;
    clearTimeout(timers.get(p.dir));
    timers.set(
      p.dir,
      setTimeout(() => {
        timers.delete(p.dir);
        void analyze(p);
      }, 1500),
    );
  }
  function schedule(file: string): void {
    if (!isMetadataFile(file)) return;
    const p = projectOf(file);
    if (p) scheduleProject(p);
  }

  const metadataWatcher = vscode.workspace.createFileSystemWatcher(
    "**/*.{cls,trigger,agent,xml,genAiPlannerBundle,json}",
  );
  const projectWatcher = vscode.workspace.createFileSystemWatcher("**/sfdx-project.json");
  const headWatcher = vscode.workspace.createFileSystemWatcher("**/.git/HEAD");
  const onMetadata = (uri: vscode.Uri) => schedule(uri.fsPath);
  const onCheckout = (uri: vscode.Uri) => {
    // A branch switch or pull: every project in that repository may have changed.
    const repo = path.dirname(path.dirname(uri.fsPath));
    for (const p of projects.values()) if (inside(repo, p.dir)) scheduleProject(p);
  };

  context.subscriptions.push(
    metadataWatcher,
    projectWatcher,
    headWatcher,
    metadataWatcher.onDidChange(onMetadata),
    metadataWatcher.onDidCreate(onMetadata),
    metadataWatcher.onDidDelete(onMetadata),
    projectWatcher.onDidCreate(() => void rediscover()),
    projectWatcher.onDidDelete(() => void rediscover()),
    headWatcher.onDidChange(onCheckout),
    headWatcher.onDidCreate(onCheckout),
    vscode.workspace.onDidSaveTextDocument((doc) => schedule(doc.uri.fsPath)),
    // As you type: unsaved edits are analyzed after a short pause (the editor's text, not the disk's).
    vscode.workspace.onDidChangeTextDocument((e) => {
      const file = e.document.uri.fsPath;
      if ((e.document.uri.scheme ?? "file") !== "file" || !e.contentChanges.length || !isMetadataFile(file)) return;
      const p = projectOf(file);
      if (!p || !config(p.dir).get<boolean>("analyzeOnType", true)) return;
      clearTimeout(typingTimers.get(p.dir));
      typingTimers.set(
        p.dir,
        setTimeout(() => {
          typingTimers.delete(p.dir);
          void analyze(p);
        }, TYPING_DELAY_MS),
      );
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      for (const p of projects.values()) {
        const uri = vscode.Uri.file(p.dir);
        if (e.affectsConfiguration("sfPreflight.baseRef", uri) || e.affectsConfiguration("sfPreflight.depth", uri)) {
          void analyze(p);
        }
      }
      if (e.affectsConfiguration("sfPreflight.minSeverity")) render();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void rediscover()),
    {
      dispose: () => {
        for (const t of timers.values()) clearTimeout(t);
        for (const t of typingTimers.values()) clearTimeout(t);
      },
    },
  );

  async function showMarkdown(content: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content });
    await vscode.commands.executeCommand("markdown.showPreview", doc.uri);
  }

  // Above each metadata file: who uses it and what runs around it, before anything is changed.
  // Computed once per analysis (the project may have changed), on a worker.
  const insights = new Map<string, { generation: number; value: Promise<Insight> }>();
  const insightOf = (p: ProjectState, file: string): Promise<Insight> => {
    const cached = insights.get(file);
    if (cached && cached.generation === generation) return cached.value;
    const value = slot(() =>
      runWorker<Insight>(context, { kind: "insight", projectDir: p.dir, file, overlay: unsavedIn(p.dir) }),
    );
    insights.set(file, { generation, value });
    return value;
  };
  context.subscriptions.push(
    lensChanged,
    vscode.languages.registerCodeLensProvider([{ scheme: "file", pattern: "**/*.{cls,trigger,xml}" }], {
      onDidChangeCodeLenses: lensChanged.event,
      provideCodeLenses: async (doc) => {
        const file = doc.uri.fsPath;
        const p = projectOf(file);
        if (!p || !isMetadataFile(file) || !config(p.dir).get<boolean>("codeLens", true)) return [];
        try {
          const insight = await insightOf(p, file);
          if (!insight.summary) return [];
          return [
            new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
              title: `sf-preflight: ${insight.summary}`,
              tooltip: insight.details.slice(0, 15).join("\n") || insight.summary,
              command: "sfPreflight.showInsight",
              arguments: [file, insight],
            }),
          ];
        } catch {
          return [];
        }
      },
    }),
    vscode.commands.registerCommand("sfPreflight.showInsight", async (file: string, insight: Insight) => {
      const lines = [`# ${path.basename(file)}`, "", insight.summary, ""];
      for (const d of insight.details) lines.push(`- ${d}`);
      await showMarkdown(lines.join("\n"));
    }),
  );

  // Quick fixes on sf-preflight's problems: open the other files involved, generate the tests that
  // exercise the change, or accept a finding about the org's state as known (the baseline).
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [{ scheme: "file", pattern: "**/*.{cls,trigger,xml,js,html,cmp,page,component,agent}" }],
      {
        provideCodeActions: (doc, _range, ctx) => {
          const actions: vscode.CodeAction[] = [];
          for (const d of ctx.diagnostics) {
            if (d.source !== "sf-preflight") continue;
            const rule = typeof d.code === "object" && d.code ? String(d.code.value) : String(d.code ?? "");
            const title = d.message.split("\n")[0] ?? "";
            for (const r of (d.relatedInformation ?? []).slice(0, 3)) {
              const a = new vscode.CodeAction(
                `Open ${path.basename(r.location.uri.fsPath)} (also involved)`,
                vscode.CodeActionKind.QuickFix,
              );
              a.command = { command: "vscode.open", title: "Open", arguments: [r.location.uri] };
              a.diagnostics = [d];
              actions.push(a);
            }
            if (["recursion-cycle", "automated-write-vs-validation-rule", "dml-or-soql-in-loop"].includes(rule)) {
              const a = new vscode.CodeAction("Generate Apex tests for this change", vscode.CodeActionKind.QuickFix);
              a.command = { command: "sfPreflight.generateTests", title: "Generate tests" };
              a.diagnostics = [d];
              actions.push(a);
            }
            if (CONDITION_RULES.has(rule)) {
              const a = new vscode.CodeAction(
                "Accept as a known issue (add to the baseline)",
                vscode.CodeActionKind.QuickFix,
              );
              a.command = {
                command: "sfPreflight.acceptFinding",
                title: "Accept as known",
                arguments: [doc.uri.fsPath, rule, title],
              };
              a.diagnostics = [d];
              actions.push(a);
            }
          }
          return actions;
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    vscode.commands.registerCommand("sfPreflight.acceptFinding", async (file: string, rule: string, title: string) => {
      const p = projectOf(file);
      const finding = p?.result?.findings.find((f) => f.rule === rule && f.title === title);
      if (!p || !finding) return;
      try {
        const r = acceptIntoBaseline(p.dir, finding);
        if (r.status === "base") {
          void vscode.window.showInformationMessage(
            'sf-preflight: the policy uses "baseline": "base", which already hides findings that were there before the change.',
          );
          return;
        }
        if (r.status === "not-a-condition") return;
        void vscode.window.showInformationMessage(
          `sf-preflight: ${r.status === "added" ? "added to" : "already in"} ${r.baselineFile}${r.policyUpdated ? ', and set "baseline" in .preflight.json' : ""}. Commit both so CI and the hook agree.`,
        );
        void analyze(p);
      } catch (err) {
        void vscode.window.showErrorMessage(`sf-preflight: ${(err as Error).message}`);
      }
    }),
  );

  /** Run a command, showing a failure as an error message rather than VS Code's generic one. */
  const guarded = (fn: () => Promise<void>) => async (): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      void vscode.window.showErrorMessage(`sf-preflight: ${(err as Error).message}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sfPreflight.analyze",
      guarded(async () => {
        await discover();
        if (!projects.size) {
          void vscode.window.showInformationMessage("sf-preflight: no sfdx-project.json in this workspace.");
          return;
        }
        await Promise.all([...projects.values()].map((p) => analyze(p)));
      }),
    ),

    vscode.commands.registerCommand(
      "sfPreflight.chooseBase",
      guarded(async () => {
        const p = await pickProject();
        if (!p) return;
        const refs = (
          await git(p.dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"]).catch(() => "")
        )
          .split("\n")
          .filter((r) => r && !r.endsWith("/HEAD"));
        const pick = await vscode.window.showQuickPick(
          [
            { label: "Default branch", description: "origin/HEAD, origin/main, main…", value: "" },
            { label: "HEAD", description: "only uncommitted changes", value: "HEAD" },
            ...refs.map((r) => ({ label: r, description: "", value: r })),
          ],
          { placeHolder: `Compare ${p.label} with` },
        );
        if (!pick) return;
        // Per workspace folder when there are several: each repository has its own branches.
        const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
        await config(p.dir).update(
          "baseRef",
          pick.value,
          multiRoot ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace,
        );
      }),
    ),

    vscode.commands.registerCommand(
      "sfPreflight.showReport",
      guarded(async () => {
        const p = await pickProject();
        if (!p) return;
        if (!p.markdown) await analyze(p);
        if (p.markdown) await showMarkdown(p.markdown);
        else if (p.error) throw new Error(p.error);
      }),
    ),

    vscode.commands.registerCommand(
      "sfPreflight.showGraph",
      guarded(async () => {
        const p = await pickProject();
        if (!p) {
          void vscode.window.showInformationMessage("sf-preflight: no sfdx-project.json in this workspace.");
          return;
        }
        const dir = p.dir;
        const source = (): GraphSource | undefined => {
          const q = projects.get(dir);
          return q && { dir, label: q.label, result: q.result, error: q.error, busy: Boolean(q.inflight) };
        };
        GraphPanel.show(
          context.extensionUri,
          source,
          () => projects.size > 1,
          (d) => {
            const md = projects.get(d)?.markdown;
            if (md) void showMarkdown(md);
          },
        );
        if (!p.result && !p.inflight) await analyze(p);
      }),
    ),

    vscode.commands.registerCommand(
      "sfPreflight.showDashboard",
      guarded(async () => {
        const p = await pickProject();
        if (!p) {
          void vscode.window.showInformationMessage("sf-preflight: no sfdx-project.json in this workspace.");
          return;
        }
        const dir = p.dir;
        const source = (): DashboardSource | undefined => {
          const q = projects.get(dir);
          return (
            q && {
              dir,
              label: q.label,
              result: q.result,
              failOn: q.failOn,
              branch: q.branch,
              history: historyOf(q),
              error: q.error,
              busy: Boolean(q.inflight),
            }
          );
        };
        DashboardPanel.show(context.extensionUri, source, () => projects.size > 1);
        if (!p.result && !p.inflight) await analyze(p);
      }),
    ),

    vscode.commands.registerCommand(
      "sfPreflight.openInViewer",
      guarded(async () => {
        const p = await pickProject();
        if (!p) return;
        if (!p.result) await analyze(p);
        if (!p.result) throw new Error(p.error ?? "There's no analysis to open yet.");
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(p.dir, "preflight.json")),
          filters: { JSON: ["json"] },
          saveLabel: "Save report",
          title: "Save the report for the web viewer",
        });
        if (!target) return;
        writeFileSync(target.fsPath, `${JSON.stringify(p.result, null, 2)}\n`);
        await vscode.env.openExternal(vscode.Uri.parse(viewerUrl()));
        const reveal = await vscode.window.showInformationMessage(
          `Saved ${path.basename(target.fsPath)}. Drop it into the report viewer that opened in your browser; it's read there and never uploaded.`,
          "Reveal file",
        );
        if (reveal === "Reveal file") await vscode.commands.executeCommand("revealFileInOS", target);
      }),
    ),

    vscode.commands.registerCommand(
      "sfPreflight.explainSaveOrder",
      guarded(async () => {
        const p = await pickProject();
        if (!p) return;
        const { objects } = await runWorker<{ objects: string[] }>(context, { kind: "objects", projectDir: p.dir });
        const object = await vscode.window.showQuickPick(objects, { placeHolder: "Object" });
        if (!object) return;
        const event = (await vscode.window.showQuickPick(["insert", "update", "delete", "undelete"], {
          placeHolder: "When records are…",
        })) as SaveEvent | undefined;
        if (!event) return;
        const { procedure } = await runWorker<{ procedure: SaveProcedure }>(context, {
          kind: "explain",
          projectDir: p.dir,
          object,
          event,
        });
        const lines = [`# What runs when ${object} records are ${event === "insert" ? "inserted" : `${event}d`}`, ""];
        if (!procedure.steps.length) lines.push("No automation in the project runs on this event.");
        for (const s of procedure.steps) {
          const writes = s.writes.length ? ` → writes ${s.writes.map((w) => `${w.object} (${w.op})`).join(", ")}` : "";
          lines.push(
            `${s.order}. **${s.phaseLabel}**: \`${s.automation.name}\`${writes}${s.notes.length ? `  \n   _${s.notes.join("; ")}_` : ""}`,
          );
        }
        lines.push("", "_Order of execution as modelled by sf-preflight, from the project's metadata._");
        await showMarkdown(lines.join("\n"));
      }),
    ),

    vscode.commands.registerCommand(
      "sfPreflight.generateTests",
      guarded(async () => {
        const p = await pickProject();
        if (!p) return;
        const outDir = path.join(p.dir, "preflight-tests");
        const ok = await vscode.window.showInformationMessage(
          `Generate Apex tests for this change into ${path.relative(p.dir, outDir)}/? Existing generated classes are overwritten.`,
          { modal: true },
          "Generate",
        );
        if (ok !== "Generate") return;
        const { base } = await resolveBase(p.dir);
        const value = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "sf-preflight: generating tests…" },
          () =>
            runWorker<{ written: string[]; markdown: string }>(context, {
              kind: "tests",
              projectDir: p.dir,
              base,
              depth: config(p.dir).get<number>("depth") ?? 4,
              outDir,
            }),
        );
        await showMarkdown(value.markdown);
        const cls =
          value.written.find((f) => f.endsWith("ChangeTest.cls")) ?? value.written.find((f) => f.endsWith(".cls"));
        if (cls)
          await vscode.window.showTextDocument(vscode.Uri.file(cls), {
            preview: false,
            viewColumn: vscode.ViewColumn.One,
          });
      }),
    ),

    vscode.commands.registerCommand(
      "sfPreflight.installSkill",
      guarded(async () => {
        const p = await pickProject();
        if (!p) return;
        const source = path.join(context.extensionPath, "dist", "skills", "sf-preflight");
        let written: string[];
        try {
          written = installSkill({ projectDir: p.dir, source });
        } catch (err) {
          if (!/--force/.test((err as Error).message)) throw err;
          const update = await vscode.window.showInformationMessage(
            "The sf-preflight agent skill is already in this project. Update it?",
            "Update",
          );
          if (update !== "Update") return;
          written = installSkill({ projectDir: p.dir, source, force: true });
        }
        void vscode.window.showInformationMessage(
          `Installed the sf-preflight agent skill in ${written.map((w) => path.relative(p.dir, w)).join(" and ")}. Copilot, Claude, Codex, Cursor and Gemini agents read it.`,
        );
      }),
    ),
  );

  // The MCP server, so agent mode (Copilot and other agents in the editor) can call sf-preflight.
  // The API arrived in VS Code 1.101; editors without it simply don't get the server.
  const mcp = vscode as unknown as McpApi;
  if (
    typeof mcp.lm?.registerMcpServerDefinitionProvider === "function" &&
    typeof mcp.McpStdioServerDefinition === "function"
  ) {
    const mcpChanged = new vscode.EventEmitter<void>();
    context.subscriptions.push(
      mcpChanged,
      mcp.lm.registerMcpServerDefinitionProvider("sfPreflight.mcp", {
        onDidChangeMcpServerDefinitions: mcpChanged.event,
        provideMcpServerDefinitions: () => {
          if (!config().get<boolean>("mcp.enabled", true)) return [];
          const server = path.join(context.extensionPath, "dist", "mcp-server.js");
          // Local folders only: the server reads files and runs git.
          const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => (f.uri.scheme ?? "file") === "file");
          return folders.map(
            (f) =>
              new mcp.McpStdioServerDefinition(
                folders.length > 1 ? `sf-preflight (${f.name})` : "sf-preflight",
                process.execPath,
                [server, "--root", f.uri.fsPath],
                { ELECTRON_RUN_AS_NODE: "1" },
                // The extension's version, so an update refreshes the editor's cached tool list.
                extensionVersion,
              ),
          );
        },
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("sfPreflight.mcp.enabled")) mcpChanged.fire();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => mcpChanged.fire()),
    );
  }

  await discover();
  render();
  for (const p of projects.values()) void analyze(p);
}

export function deactivate(): void {
  // Disposables are cleaned up through the extension context; the analysis workers are ours to end.
  pool?.dispose();
  pool = undefined;
}
