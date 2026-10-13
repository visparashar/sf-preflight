// SPDX-License-Identifier: Apache-2.0
// A small stand-in for the `vscode` module: enough of the API for the extension to activate,
// analyze a project and publish what it found, so the built bundle can be tested without an editor.
const fs = require("node:fs");
const path = require("node:path");

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (fn) => {
      this.listeners.push(fn);
      return { dispose: () => {} };
    };
  }
  fire(v) {
    for (const fn of this.listeners) fn(v);
  }
  dispose() {}
}
class Position {
  constructor(line, character) {
    Object.assign(this, { line, character });
  }
}
class Range {
  constructor(sl, sc, el, ec) {
    this.start = new Position(sl, sc);
    this.end = new Position(el, ec);
  }
}
class Uri {
  constructor(fsPath, raw) {
    this.fsPath = fsPath;
    this.raw = raw;
  }
  static file(p) {
    return new Uri(p);
  }
  static parse(s) {
    return new Uri(undefined, s);
  }
  static joinPath(base, ...parts) {
    return new Uri(path.join(base.fsPath, ...parts));
  }
  toString() {
    return this.raw ?? `file://${this.fsPath}`;
  }
}
class Diagnostic {
  constructor(range, message, severity) {
    Object.assign(this, { range, message, severity });
  }
}
class TreeItem {
  constructor(label, collapsibleState) {
    Object.assign(this, { label, collapsibleState });
  }
}

const state = {
  root: undefined,
  settings: {},
  diagnostics: new Map(),
  commands: new Map(),
  trees: new Map(),
  status: undefined,
  mcpProviders: new Map(),
  context: {},
  /** Commands the extension ran through executeCommand, other than setContext. */
  executed: [],
  /** URLs opened in the browser. */
  external: [],
};

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "sfdx-project.json") out.push(Uri.file(p));
  }
  return out;
}
const noop = () => ({ dispose: () => {} });

const vscode = {
  __state: state,
  EventEmitter,
  Position,
  Range,
  Uri,
  Diagnostic,
  TreeItem,
  Location: class {
    constructor(uri, pos) {
      Object.assign(this, { uri, pos });
    }
  },
  DiagnosticRelatedInformation: class {
    constructor(location, message) {
      Object.assign(this, { location, message });
    }
  },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ProgressLocation: { Notification: 15 },
  ViewColumn: { One: 1, Beside: -2 },
  CodeLens: class {
    constructor(range, command) {
      this.range = range;
      this.command = command;
    }
  },
  languages: {
    registerCodeLensProvider: (selector, provider) => {
      state.codeLens = provider;
      return { dispose() {} };
    },
    createDiagnosticCollection: () => ({
      clear: () => state.diagnostics.clear(),
      set: (uri, list) => state.diagnostics.set(uri.fsPath, list),
      dispose: () => {},
    }),
  },
  window: {
    createStatusBarItem: () => {
      state.status = { show() {}, dispose() {} };
      return state.status;
    },
    createOutputChannel: () => ({ appendLine: (l) => (state.log = [...(state.log ?? []), l]), dispose() {} }),
    registerTreeDataProvider: (id, provider) => {
      state.trees.set(id, provider);
      return { dispose() {} };
    },
    showInformationMessage: async (...args) => state.answer?.(...args),
    withProgress: async (_opts, task) => task(),
    showTextDocument: async (uri) => {
      state.opened = [...(state.opened ?? []), uri.fsPath];
    },
    showErrorMessage: async (msg) => {
      state.errors = [...(state.errors ?? []), msg];
    },
    createWebviewPanel: (viewType, title, _column, options) => {
      const handlers = { message: [], dispose: [] };
      const panel = {
        viewType,
        title,
        options,
        posted: [],
        webview: {
          html: "",
          cspSource: "vscode-webview:",
          asWebviewUri: (uri) => Uri.parse(`vscode-webview://${uri.fsPath}`),
          postMessage: async (m) => {
            panel.posted.push(m);
            return true;
          },
          onDidReceiveMessage: (fn) => {
            handlers.message.push(fn);
            return { dispose() {} };
          },
        },
        /** Simulate a message from the webview. */
        receive: async (m) => {
          for (const fn of handlers.message) await fn(m);
        },
        reveal() {},
        onDidDispose: (fn) => {
          handlers.dispose.push(fn);
          return { dispose() {} };
        },
        dispose: () => {
          for (const fn of handlers.dispose) fn();
        },
      };
      state.panels = [...(state.panels ?? []), panel];
      return panel;
    },
    showQuickPick: async () => undefined,
    showSaveDialog: async (opts) => state.saveTo?.(opts),
    activeTextEditor: undefined,
  },
  workspace: {
    get workspaceFolders() {
      return state.root ? [{ uri: Uri.file(state.root), name: path.basename(state.root), index: 0 }] : [];
    },
    getConfiguration: () => ({
      get: (key, dflt) => (key in state.settings ? state.settings[key] : dflt),
      update: async (key, value) => {
        state.settings[key] = value;
      },
    }),
    findFiles: async () => (state.root ? walk(state.root, []) : []),
    createFileSystemWatcher: (pattern) => {
      const w = { pattern, change: new EventEmitter(), create: new EventEmitter(), delete: new EventEmitter() };
      state.watchers = [...(state.watchers ?? []), w];
      return {
        onDidChange: w.change.event,
        onDidCreate: w.create.event,
        onDidDelete: w.delete.event,
        dispose() {},
      };
    },
    getWorkspaceFolder: () => vscode.workspace.workspaceFolders[0],
    openTextDocument: async ({ content }) => {
      state.documents = [...(state.documents ?? []), content];
      return { uri: Uri.parse("untitled:report") };
    },
    onDidSaveTextDocument: noop,
    onDidChangeTextDocument: (fn) => {
      state.onTextChange = fn;
      return { dispose() {} };
    },
    get textDocuments() {
      return state.textDocuments ?? [];
    },
    onDidCreateFiles: noop,
    onDidDeleteFiles: noop,
    onDidRenameFiles: noop,
    onDidChangeConfiguration: noop,
    onDidChangeWorkspaceFolders: noop,
  },
  commands: {
    registerCommand: (id, fn) => {
      state.commands.set(id, fn);
      return { dispose() {} };
    },
    executeCommand: async (id, ...args) => {
      if (id === "setContext") state.context[args[0]] = args[1];
      else state.executed.push([id, ...args]);
    },
  },
  env: {
    openExternal: async (uri) => {
      state.external.push(uri.raw ?? uri.fsPath);
      return true;
    },
  },
  lm: {
    registerMcpServerDefinitionProvider: (id, provider) => {
      state.mcpProviders.set(id, provider);
      return { dispose() {} };
    },
  },
  McpStdioServerDefinition: class {
    constructor(label, command, args, env, version) {
      Object.assign(this, { label, command, args, env, version });
    }
  },
};

module.exports = vscode;
