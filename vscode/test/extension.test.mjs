// SPDX-License-Identifier: Apache-2.0
// Activates the built extension (dist/extension.js) against a fake `vscode` module and a real git
// repository, and checks what it publishes: problems, the blast-radius tree, the status bar and the
// MCP server definition. Run after `npm run build`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const vscode = require("./fake-vscode.cjs");

// Resolve `vscode` to the fake for the bundle.
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return path.join(here, "fake-vscode.cjs");
  return resolve.call(this, request, ...rest);
};

const fixture = path.resolve(ext, "..", "fixtures", "sample-org");
const SRC = "force-app/main/default";
let repo;
let extension;
const git = (...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "pipe" }).toString();

async function until(check, what, ms = 60_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms)
      throw new Error(`Timed out waiting for ${what}. Log: ${(vscode.__state.log ?? []).join("\n")}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  assert.ok(existsSync(path.join(ext, "dist", "extension.js")), "run `npm run build` first");
  repo = mkdtempSync(path.join(tmpdir(), "sf-preflight-vscode-"));
  cpSync(fixture, repo, { recursive: true });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  // An uncommitted change, as while editing: the trigger handler.
  const handler = path.join(repo, SRC, "classes", "ContactTriggerHandler.cls");
  writeFileSync(handler, `${readFileSync(handler, "utf8")}\n// edited\n`);
  vscode.__state.root = repo;
  extension = require(path.join(ext, "dist", "extension.js"));
  const stored = new Map();
  await extension.activate({
    subscriptions: [],
    workspaceState: {
      get: (k) => stored.get(k),
      update: async (k, v) => void stored.set(k, v),
      keys: () => [...stored.keys()],
    },
    extensionPath: ext,
    extensionUri: vscode.Uri.file(ext),
    extension: { packageJSON: { version: "9.9.9" } },
  });
  await until(() => vscode.__state.diagnostics.size > 0, "problems");
});

after(() => {
  extension?.deactivate();
  if (repo) rmSync(repo, { recursive: true, force: true });
});

test("finds the project and registers its commands", () => {
  assert.equal(vscode.__state.context["sfPreflight.hasProject"], true);
  for (const id of [
    "sfPreflight.analyze",
    "sfPreflight.chooseBase",
    "sfPreflight.showReport",
    "sfPreflight.explainSaveOrder",
    "sfPreflight.generateTests",
    "sfPreflight.installSkill",
  ]) {
    assert.ok(vscode.__state.commands.has(id), id);
  }
});

test("puts findings in the Problems panel, on their files and lines", () => {
  const at = (rel) => vscode.__state.diagnostics.get(path.join(repo, SRC, rel)) ?? [];
  // The changed class: DML inside a loop, at its line (7, 0-based 6).
  const loop = at("classes/ContactTriggerHandler.cls").find((d) => d.code.value === "dml-or-soql-in-loop");
  assert.ok(loop, "DML in a loop on the handler");
  assert.equal(loop.severity, vscode.DiagnosticSeverity.Error);
  assert.equal(loop.range.start.line, 6);
  assert.equal(loop.source, "sf-preflight");
  assert.match(loop.code.target.toString(), /RULES\.md#dml-or-soql-in-loop$/);
  // The cycle it sets off, on the trigger and the flow involved, each pointing at the other.
  const cycle = at("triggers/ContactTrigger.trigger").find((d) => d.code.value === "recursion-cycle");
  assert.ok(cycle, "the recursion cycle on the trigger");
  assert.ok(at("flows/Account_Sync_Tier_To_Contacts.flow-meta.xml").some((d) => d.code.value === "recursion-cycle"));
  assert.equal(cycle.relatedInformation.length, 1);
  // No remote here, so it compares with the local default branch from where HEAD left it.
  assert.ok((vscode.__state.log ?? []).some((l) => l.endsWith("vs main")));
});

test("shows the blast radius and the status", () => {
  const tree = vscode.__state.trees.get("sfPreflight.blastRadius");
  const top = tree.getChildren();
  assert.match(top[0].label, /^Risk: high/);
  const labels = top.map((n) => n.label);
  assert.ok(labels.includes("Findings"));
  assert.ok(labels.includes("What runs"));
  const findings = top.find((n) => n.label === "Findings");
  const item = tree.getTreeItem(findings.children[0]);
  assert.equal(item.command.command, "vscode.open");
  assert.match(vscode.__state.status.text, /Preflight: [1-9]\d* high/);
});

test("shows the blast-radius graph, and opens only the project's files from it", async () => {
  // The tree's risk item opens the graph.
  const tree = vscode.__state.trees.get("sfPreflight.blastRadius");
  assert.equal(tree.getTreeItem(tree.getChildren()[0]).command.command, "sfPreflight.showGraph");

  await vscode.__state.commands.get("sfPreflight.showGraph")();
  const panel = vscode.__state.panels.at(-1);
  assert.equal(panel.viewType, "sfPreflight.graph");
  // Scripts only from the extension's media folder, with a nonce; no inline code.
  const html = panel.webview.html;
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(html, /<script nonce="[^"]+" src="vscode-webview:\/\/[^"]+media\/graph\.js">/);
  assert.equal(panel.options.localResourceRoots[0].fsPath, path.join(ext, "media"));

  // Nothing is sent until the page says it's ready; then the graph, without file paths.
  assert.equal(panel.posted.length, 0);
  await panel.receive({ type: "ready" });
  const msg = panel.posted.at(-1);
  assert.equal(msg.type, "graph");
  assert.equal(msg.meta.risk, "high");
  assert.match(msg.meta.summary, /1 changed/);
  const nodes = msg.graph.nodes;
  assert.equal(msg.graph.center, `f:${SRC}/classes/ContactTriggerHandler.cls`);
  assert.ok(nodes.length > 3);
  assert.ok(nodes.every((n) => !("file" in n) && typeof n.openable === "boolean"));
  assert.ok(!JSON.stringify(msg).includes(repo), "no local paths reach the webview");

  // Opening a node by id opens its file; unknown ids and anything outside the project don't.
  const trigger = nodes.find((n) => n.label === "ContactTrigger");
  vscode.__state.opened = [];
  await panel.receive({ type: "open", id: trigger.id });
  assert.deepEqual(vscode.__state.opened, [path.join(repo, SRC, "triggers", "ContactTrigger.trigger")]);
  for (const bad of [{ type: "open", id: "f:../../etc/passwd" }, { type: "open", id: 42 }, { type: "open" }, null, "x"])
    await panel.receive(bad);
  assert.equal(vscode.__state.opened.length, 1);

  // Showing it again reuses the panel.
  await vscode.__state.commands.get("sfPreflight.showGraph")();
  assert.equal(vscode.__state.panels.at(-1), panel);
});

test("shows the risk dashboard, and opens only the project's files from it", async () => {
  // The status bar opens it.
  assert.equal(vscode.__state.status.command, "sfPreflight.showDashboard");
  await vscode.__state.commands.get("sfPreflight.showDashboard")();
  const panel = vscode.__state.panels.at(-1);
  assert.equal(panel.viewType, "sfPreflight.dashboard");
  const html = panel.webview.html;
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(html, /<script nonce="[^"]+" src="vscode-webview:\/\/[^"]+media\/dashboard\.js">/);

  // Nothing is sent until the page is ready; then the model, with project-relative paths only.
  assert.equal(panel.posted.length, 0);
  await panel.receive({ type: "ready" });
  const msg = panel.posted.at(-1);
  assert.equal(msg.type, "dashboard");
  assert.equal(msg.model.risk, "high");
  assert.ok(
    msg.model.factors.some((f) => f.id === "load" && f.count > 0),
    "the loop in the trigger handler",
  );
  assert.equal(msg.meta.branch, "main");
  assert.ok(msg.history.length >= 1, "the analysis is in the branch's history");
  assert.ok(!JSON.stringify(msg).includes(repo), "no local paths reach the webview");

  // A finding opens by key; unknown keys and malformed messages do nothing.
  const finding = msg.model.factors.flatMap((f) => f.findings).find((f) => f.file);
  vscode.__state.opened = [];
  await panel.receive({ type: "open", key: finding.key });
  assert.equal(vscode.__state.opened.length, 1);
  assert.ok(vscode.__state.opened[0].startsWith(repo));
  for (const bad of [{ type: "open", key: 9999 }, { type: "open", key: "0" }, { type: "open", key: -1 }, null, "x"])
    await panel.receive(bad);
  assert.equal(vscode.__state.opened.length, 1);

  // Buttons run only the dashboard's own commands.
  vscode.__state.executed = [];
  await panel.receive({ type: "run", action: "graph" });
  await panel.receive({ type: "run", action: "workbench.action.terminal.new" });
  await panel.receive({ type: "run", action: "__proto__" });
  assert.deepEqual(vscode.__state.executed, [["sfPreflight.showGraph"]]);

  // Showing it again reuses the panel.
  await vscode.__state.commands.get("sfPreflight.showDashboard")();
  assert.equal(vscode.__state.panels.at(-1), panel);
});

test("packages every file the webviews load", () => {
  const ignore = readFileSync(path.join(ext, ".vscodeignore"), "utf8").split("\n");
  const html = vscode.__state.panels.map((p) => p.webview.html).join("\n");
  const loaded = [...html.matchAll(/media\/([\w.-]+\.(?:js|css))/g)].map((m) => m[1]);
  assert.ok(loaded.includes("graph.js") && loaded.includes("dashboard.js"));
  for (const f of new Set(loaded)) assert.ok(ignore.includes(`!media/${f}`), `media/${f} is left out of the package`);
});

test("saves the report and opens the web viewer", async () => {
  const target = path.join(repo, "preflight.json");
  vscode.__state.saveTo = () => vscode.Uri.file(target);
  vscode.__state.external = [];
  await vscode.__state.commands.get("sfPreflight.openInViewer")();
  const report = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.summary.risk, "high");
  assert.deepEqual(vscode.__state.external, ["https://sf-preflight-web.vercel.app/"]);
  // Cancelling the save dialog opens nothing.
  vscode.__state.saveTo = () => undefined;
  await vscode.__state.commands.get("sfPreflight.openInViewer")();
  assert.equal(vscode.__state.external.length, 1);
  rmSync(target);
});

test("offers the bundled MCP server to agent mode", () => {
  const provider = vscode.__state.mcpProviders.get("sfPreflight.mcp");
  const [def] = provider.provideMcpServerDefinitions();
  assert.equal(def.label, "sf-preflight");
  assert.equal(def.command, process.execPath);
  assert.ok(existsSync(def.args[0]) && def.args[0].endsWith(path.join("dist", "mcp-server.js")));
  assert.deepEqual(def.args.slice(1), ["--root", repo]);
  assert.equal(def.env.ELECTRON_RUN_AS_NODE, "1");
  // The extension's own version, so an update refreshes the editor's cached tool list.
  assert.equal(def.version, "9.9.9");
});

test("installs the agent skill from the copy it bundles", async () => {
  await vscode.__state.commands.get("sfPreflight.installSkill")();
  for (const dir of [".agents", ".claude"]) {
    assert.ok(existsSync(path.join(repo, dir, "skills", "sf-preflight", "SKILL.md")), dir);
  }
});

const runs = () => (vscode.__state.log ?? []).filter((l) => / risk \w+,/.test(l)).length;

test("runs one analysis at a time, and once more for changes made meanwhile", async () => {
  const before = runs();
  const analyze = vscode.__state.commands.get("sfPreflight.analyze");
  await Promise.all([analyze(), analyze(), analyze()]);
  // The first run, plus one more for the requests that came while it ran: never three.
  assert.ok(runs() - before >= 1 && runs() - before <= 2, `${runs() - before} runs`);
});

test("analyzes again when metadata changes outside the editor", async () => {
  const before = runs();
  const watcher = vscode.__state.watchers.find((w) => w.pattern.includes("cls"));
  watcher.change.fire(vscode.Uri.file(path.join(repo, SRC, "classes", "ContactTriggerHandler.cls")));
  // Not for files that aren't metadata.
  watcher.change.fire(vscode.Uri.file(path.join(repo, "README.json")));
  await until(() => runs() > before, "a run after the change", 20_000);
  const head = vscode.__state.watchers.find((w) => w.pattern.includes(".git/HEAD"));
  const afterChange = runs();
  head.change.fire(vscode.Uri.file(path.join(repo, ".git", "HEAD")));
  await until(() => runs() > afterChange, "a run after a checkout", 20_000);
});

test("analyzes unsaved edits after a pause in typing, underlining what they affect", async () => {
  const file = path.join(repo, SRC, "objects", "Opportunity", "fields", "Contract_Signed_Date__c.field-meta.xml");
  const text = readFileSync(file, "utf8").replace("<type>Date</type>", "<type>DateTime</type>");
  const doc = { uri: vscode.Uri.file(file), isDirty: true, getText: () => text, version: 2 };
  vscode.__state.textDocuments = [doc];
  const before = runs();
  vscode.__state.onTextChange({ document: doc, contentChanges: [{ text: "x" }] });
  await until(() => runs() > before, "a run after typing", 20_000);
  // The unsaved field change is part of the change: its findings are on the field.
  await until(
    () => (vscode.__state.diagnostics.get(file) ?? []).some((d) => d.code.value === "field-used-by-validation-rule"),
    "a finding on the unsaved field",
    20_000,
  );
  assert.equal(readFileSync(file, "utf8").includes("DateTime"), false, "the file on disk is untouched");
  // Underlined on the field's name, not on the first line.
  const used = vscode.__state.diagnostics.get(file).find((d) => d.code.value === "field-used-by-validation-rule");
  assert.deepEqual([used.range.start.line, used.range.start.character, used.range.end.character], [2, 14, 37]);
  vscode.__state.textDocuments = [];
});

test("shows who uses a file and what runs, above it", async () => {
  const file = path.join(repo, SRC, "objects", "Opportunity", "fields", "Contract_Signed_Date__c.field-meta.xml");
  const lenses = await vscode.__state.codeLens.provideCodeLenses({ uri: vscode.Uri.file(file) });
  assert.equal(lenses.length, 1);
  assert.match(lenses[0].command.title, /^sf-preflight: Used by 1 validation rule/);
  assert.equal(lenses[0].command.command, "sfPreflight.showInsight");
});

test("offers quick fixes, and accepts a known issue into the baseline", async () => {
  const file = path.join(repo, SRC, "classes", "ContactTriggerHandler.cls");
  const diags = vscode.__state.diagnostics.get(file) ?? [];
  const loop = diags.find((d) => d.code.value === "dml-or-soql-in-loop");
  assert.ok(loop, "the DML-in-loop problem");
  const actions = vscode.__state.codeActions.provideCodeActions({ uri: vscode.Uri.file(file) }, loop.range, {
    diagnostics: [loop],
  });
  const titles = actions.map((a) => a.title);
  assert.ok(titles.includes("Generate Apex tests for this change"));
  const accept = actions.find((a) => a.title.startsWith("Accept as a known issue"));
  assert.ok(accept);
  await vscode.__state.commands.get(accept.command.command)(...accept.command.arguments);
  const policy = JSON.parse(readFileSync(path.join(repo, ".preflight.json"), "utf8"));
  assert.equal(policy.baseline, ".preflight-baseline.json");
  const baseline = JSON.parse(readFileSync(path.join(repo, ".preflight-baseline.json"), "utf8"));
  assert.deepEqual(
    baseline.findings.map((f) => f.rule),
    ["dml-or-soql-in-loop"],
  );
  // The next analysis hides it.
  const before = runs();
  await until(() => runs() > before, "an analysis after accepting", 20_000);
  await until(
    () => !(vscode.__state.diagnostics.get(file) ?? []).some((d) => d.code.value === "dml-or-soql-in-loop"),
    "the accepted problem to go away",
    20_000,
  );
  rmSync(path.join(repo, ".preflight-baseline.json"));
  rmSync(path.join(repo, ".preflight.json"));
});

test("generates tests that don't count as part of the change", async () => {
  vscode.__state.answer = (_msg, _opts, ...items) => items.find((i) => i === "Generate");
  await vscode.__state.commands.get("sfPreflight.generateTests")();
  vscode.__state.answer = undefined;
  assert.ok((vscode.__state.opened ?? []).some((f) => f.endsWith("PreflightChangeTest.cls")));
  const before = runs();
  await vscode.__state.commands.get("sfPreflight.analyze")();
  await until(() => runs() > before, "a run after generating");
  const tree = vscode.__state.trees.get("sfPreflight.blastRadius");
  const changed = tree.getChildren().find((n) => n.label === "Changed components");
  assert.deepEqual(
    changed.children.map((c) => c.label),
    ["ContactTriggerHandler"],
  );
});
