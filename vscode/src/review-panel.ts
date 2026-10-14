// SPDX-License-Identifier: Apache-2.0
/**
 * The Review tab: a wide editor-area webview with the change's findings on the left, the selected
 * finding with its checked fix (as a diff) in the middle, and what runs when its object is saved on
 * the right. Like the other panels, the webview gets findings by key, never file paths; the actions
 * it can ask for are listed here and every one is checked against the current analysis.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { FailOn } from "../../src/core/config.js";
import { type Fix, fixId } from "../../src/core/fix.js";
import type { AnalysisResult, SaveEvent, SaveProcedure } from "../../src/core/types.js";
import { independentSafeFixes, reviewOf, saveOrderOf } from "./review.js";

export interface ReviewSource {
  dir: string;
  label: string;
  result?: AnalysisResult;
  failOn?: FailOn;
  branch?: string;
  error?: string;
  busy: boolean;
  /** Checked fixes for `result` (computed once per analysis). */
  fixes: () => Promise<Fix[]>;
  /** What runs when `object` is saved, for the save-order column. */
  procedure: (object: string, event: SaveEvent) => Promise<SaveProcedure>;
}

/** Buttons that run one of these commands and nothing else. */
export const REVIEW_ACTIONS = {
  analyze: "sfPreflight.analyze",
  base: "sfPreflight.chooseBase",
  dashboard: "sfPreflight.showDashboard",
  graph: "sfPreflight.showGraph",
  tests: "sfPreflight.generateTests",
  maximize: "workbench.action.maximizeEditorHideSidebar",
} as const;

const EVENTS: readonly SaveEvent[] = ["insert", "update", "delete", "undelete"];

export class ReviewPanel {
  private static current: ReviewPanel | undefined;
  private ready = false;
  private sent = 0;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private source: () => ReviewSource | undefined,
    private readonly multiProject: () => boolean,
  ) {
    panel.webview.html = this.html();
    panel.onDidDispose(() => {
      if (ReviewPanel.current === this) ReviewPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((msg: unknown) => void this.receive(msg));
  }

  /** Open the Review tab for a project, or point the open one at it. */
  static show(extensionUri: vscode.Uri, source: () => ReviewSource | undefined, multiProject: () => boolean): void {
    if (ReviewPanel.current) {
      ReviewPanel.current.source = source;
      ReviewPanel.current.panel.reveal(undefined, false);
      ReviewPanel.current.update();
      return;
    }
    // In the editor area, in the active group: it gets the full width of the editor.
    const panel = vscode.window.createWebviewPanel(
      "sfPreflight.review",
      "sf-preflight review",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "activity.svg");
    ReviewPanel.current = new ReviewPanel(panel, extensionUri, source, multiProject);
  }

  /** Re-send the findings, when the tab is open (after each analysis). */
  static refresh(): void {
    ReviewPanel.current?.update();
  }

  update(): void {
    const src = this.source();
    if (!src || !this.ready) return;
    const meta = {
      project: this.multiProject() ? src.label : undefined,
      branch: src.branch,
      busy: src.busy,
      error: src.error,
    };
    const result = src.result;
    if (!result) {
      void this.panel.webview.postMessage({ type: "review", model: undefined, meta });
      return;
    }
    // The findings first; the fixes are checked by analyzing again, so they follow when ready.
    const seq = ++this.sent;
    void this.panel.webview.postMessage({ type: "review", model: reviewOf(result, src.failOn, undefined), meta });
    void src
      .fixes()
      .catch(() => [] as Fix[])
      .then((fixes) => {
        if (seq !== this.sent || this.source()?.result !== result) return;
        void this.panel.webview.postMessage({ type: "review", model: reviewOf(result, src.failOn, fixes), meta });
      });
  }

  private async receive(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    const { type, key, action, event } = msg as { type?: unknown; key?: unknown; action?: unknown; event?: unknown };
    if (type === "ready") {
      this.ready = true;
      this.update();
      return;
    }
    const src = this.source();
    if (type === "run") {
      if (typeof action === "string" && Object.hasOwn(REVIEW_ACTIONS, action))
        await vscode.commands.executeCommand(REVIEW_ACTIONS[action as keyof typeof REVIEW_ACTIONS]);
      return;
    }
    if (!src?.result) return;
    if (type === "applyAll") {
      const { apply } = independentSafeFixes(await src.fixes());
      if (apply.length) await vscode.commands.executeCommand("sfPreflight.applyFixes", src.dir, apply);
      return;
    }
    if (!Number.isInteger(key)) return;
    const finding = src.result.findings[key as number];
    if (!finding) return;
    const file = finding.files[0] ? path.resolve(src.dir, finding.files[0]) : undefined;
    const inside = file ? path.relative(src.dir, file) : undefined;
    const safeFile =
      file && inside && !inside.startsWith("..") && !path.isAbsolute(inside) && existsSync(file) ? file : undefined;

    if (type === "open") {
      if (!safeFile) return;
      const line = finding.line ? Math.max(0, finding.line - 1) : 0;
      await vscode.window.showTextDocument(vscode.Uri.file(safeFile), {
        viewColumn: vscode.ViewColumn.Beside,
        selection: new vscode.Range(line, 0, line, 0),
        preview: true,
      });
    } else if (type === "applyFix") {
      const fix = (await src.fixes()).find((f) => f.id === fixId({ rule: finding.rule, title: finding.title }));
      if (fix) await vscode.commands.executeCommand("sfPreflight.applyFix", src.dir, fix);
    } else if (type === "accept") {
      if (safeFile)
        await vscode.commands.executeCommand("sfPreflight.acceptFinding", safeFile, finding.rule, finding.title);
    } else if (type === "saveOrder") {
      if (!finding.object || typeof event !== "string" || !EVENTS.includes(event as SaveEvent)) return;
      let reply: unknown;
      try {
        reply = saveOrderOf(await src.procedure(finding.object, event as SaveEvent), finding);
      } catch (err) {
        reply = { error: (err as Error).message };
      }
      void this.panel.webview.postMessage({ type: "saveOrder", key, order: reply });
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
<link rel="stylesheet" href="${media("review.css")}">
<title>sf-preflight review</title>
</head>
<body>
<div id="app" aria-live="polite"><p class="muted pad">Analyzing…</p></div>
<script nonce="${nonce}" src="${media("review.js")}"></script>
</body>
</html>`;
  }
}
