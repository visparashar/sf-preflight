// SPDX-License-Identifier: Apache-2.0
/**
 * The risk dashboard panel: a webview beside the editor with one project's risk factors, where
 * the risk sits, and the trend over the branch's recent analyses, updated after every analysis.
 * Like the graph panel, the webview gets findings by key, never file paths; opening one looks its
 * file up here and only opens files inside the project.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { FailOn } from "../../src/core/config.js";
import type { AnalysisResult } from "../../src/core/types.js";
import { type DashboardModel, dashboardOf, type HistoryEntry } from "./dashboard.js";

export interface DashboardSource {
  dir: string;
  label: string;
  result?: AnalysisResult;
  failOn?: FailOn;
  /** The current branch, for the trend's caption. */
  branch?: string;
  history: HistoryEntry[];
  error?: string;
  busy: boolean;
}

/** Actions the dashboard's buttons run, as commands of the extension. */
export const DASHBOARD_ACTIONS = {
  analyze: "sfPreflight.analyze",
  review: "sfPreflight.showReview",
  graph: "sfPreflight.showGraph",
  report: "sfPreflight.showReport",
  tests: "sfPreflight.generateTests",
  viewer: "sfPreflight.openInViewer",
  base: "sfPreflight.chooseBase",
} as const;

/** What the webview is sent: the model (project-relative paths only) and the header text. */
export function dashboardMessage(src: DashboardSource, multiProject: boolean) {
  const model: DashboardModel | undefined = src.result ? dashboardOf(src.result, src.failOn) : undefined;
  return {
    type: "dashboard" as const,
    model,
    history: src.history,
    meta: {
      project: multiProject ? src.label : undefined,
      branch: src.branch,
      busy: src.busy,
      error: src.error,
    },
  };
}

export class DashboardPanel {
  private static current: DashboardPanel | undefined;
  private ready = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private source: () => DashboardSource | undefined,
    private readonly multiProject: () => boolean,
  ) {
    panel.webview.html = this.html();
    panel.onDidDispose(() => {
      if (DashboardPanel.current === this) DashboardPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((msg: unknown) => void this.receive(msg));
  }

  /** Open the dashboard for a project, or point the open one at it. */
  static show(
    extensionUri: vscode.Uri,
    source: () => DashboardSource | undefined,
    multiProject: () => boolean,
  ): DashboardPanel {
    if (DashboardPanel.current) {
      DashboardPanel.current.source = source;
      DashboardPanel.current.panel.reveal(undefined, true);
      DashboardPanel.current.update();
      return DashboardPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "sfPreflight.dashboard",
      "Risk dashboard",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "activity.svg");
    DashboardPanel.current = new DashboardPanel(panel, extensionUri, source, multiProject);
    return DashboardPanel.current;
  }

  /** Re-send the dashboard, when the panel is open (after each analysis). */
  static refresh(): void {
    DashboardPanel.current?.update();
  }

  update(): void {
    const src = this.source();
    if (!src || !this.ready) return;
    void this.panel.webview.postMessage(dashboardMessage(src, this.multiProject()));
  }

  private async receive(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    const { type, key, action } = msg as { type?: unknown; key?: unknown; action?: unknown };
    if (type === "ready") {
      this.ready = true;
      this.update();
    } else if (type === "run" && typeof action === "string" && Object.hasOwn(DASHBOARD_ACTIONS, action)) {
      await vscode.commands.executeCommand(DASHBOARD_ACTIONS[action as keyof typeof DASHBOARD_ACTIONS]);
    } else if (type === "open" && Number.isInteger(key)) {
      const src = this.source();
      const finding = src?.result?.findings[key as number];
      const rel = finding?.files[0];
      if (!src || !finding || !rel) return;
      const file = path.resolve(src.dir, rel);
      const inside = path.relative(src.dir, file);
      if (inside.startsWith("..") || path.isAbsolute(inside) || !existsSync(file)) return;
      const line = finding.line ? Math.max(0, finding.line - 1) : 0;
      await vscode.window.showTextDocument(vscode.Uri.file(file), {
        viewColumn: vscode.ViewColumn.One,
        selection: new vscode.Range(line, 0, line, 0),
        preview: true,
      });
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", f));
    const nonce = randomBytes(16).toString("base64");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media("dashboard.css")}">
<title>Risk dashboard</title>
</head>
<body>
<main id="app" aria-live="polite"><p class="muted">Analyzing…</p></main>
<div id="tip" class="tip" role="tooltip" hidden></div>
<script nonce="${nonce}" src="${media("dashboard.js")}"></script>
</body>
</html>`;
  }
}
