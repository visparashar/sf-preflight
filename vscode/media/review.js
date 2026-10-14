// SPDX-License-Identifier: Apache-2.0
// The Review tab webview: findings on the left, the selected finding with its checked fix in the
// middle, and the save order of its object on the right. Data arrives from the extension by
// postMessage; actions go back by finding key (the webview never handles file paths).
(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const SEVERITIES = ["high", "medium", "low", "info"];
  const LABEL = { high: "High", medium: "Medium", low: "Low", info: "Info" };
  const EVENTS = ["insert", "update", "delete", "undelete"];
  const KIND = {
    safe: "Safe fix",
    undo: "Undoes part of the change",
    review: "Review the change first",
  };

  let state = { model: undefined, meta: {} };
  const ui = {
    selected: undefined, // "rule|title" of the selected finding
    event: "update",
    severities: new Set(SEVERITIES),
    onlyFixable: false,
    factor: "",
    search: "",
  };
  // Save orders already asked for, by "key|event". Cleared when a new analysis arrives.
  let orders = new Map();
  let resultId = "";

  const el = (tag, attrs = {}, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) e.append(c);
    return e;
  };
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const run = (action) => vscode.postMessage({ type: "run", action });
  const send = (type, key, extra = {}) => vscode.postMessage({ type, key, ...extra });
  const sevMark = (s) => el("span", { class: `sq ${s}`, "aria-hidden": "true" });
  const idOf = (f) => `${f.rule}|${f.title}`;
  const btn = (label, onclick, cls = "") => el("button", { type: "button", class: cls, onclick }, label);

  // ------------------------------------------------------------ state helpers

  function visible(model) {
    const q = ui.search.trim().toLowerCase();
    return model.findings
      .filter(
        (f) =>
          ui.severities.has(f.severity) &&
          (!ui.onlyFixable || f.fix) &&
          (!ui.factor || f.factor === ui.factor) &&
          (!q || `${f.title} ${f.rule} ${f.object ?? ""} ${f.files[0] ?? ""}`.toLowerCase().includes(q)),
      )
      .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.key - b.key);
  }

  function current(model) {
    return model.findings.find((f) => idOf(f) === ui.selected);
  }

  function askOrder(f) {
    if (!f?.object) return;
    const id = `${f.key}|${ui.event}`;
    if (orders.has(id)) return;
    orders.set(id, "pending");
    send("saveOrder", f.key, { event: ui.event });
  }

  // ------------------------------------------------------------ sections

  function header(model, meta) {
    const where = [
      meta.project,
      meta.branch ? `on ${meta.branch}` : undefined,
      meta.busy ? "analyzing…" : undefined,
    ].filter(Boolean);
    const fixable = model.safeFixes;
    return el(
      "header",
      { class: "bar" },
      el(
        "div",
        { class: "headline" },
        el("h1", { class: `risk ${model.risk}` }, `${LABEL[model.risk]} risk`),
        el(
          "span",
          { class: "counts" },
          SEVERITIES.map((s) =>
            el("span", { class: model.counts[s] ? "" : "zero" }, sevMark(s), ` ${model.counts[s]} ${s}`),
          ),
        ),
        el(
          "span",
          { class: `gate ${model.gate.status}` },
          model.gate.status === "pass" ? "✓ Gate passes" : "✕ Gate fails",
          el("span", { class: "muted" }, ` (${model.gate.label.toLowerCase()})`),
        ),
        where.length ? el("span", { class: "muted" }, where.join(" · ")) : null,
      ),
      el(
        "div",
        { class: "actions" },
        model.fixesPending
          ? el("span", { class: "muted" }, "Checking fixes…")
          : fixable
            ? btn(
                `Apply ${plural(fixable, "safe fix", "safe fixes")}`,
                () => vscode.postMessage({ type: "applyAll" }),
                "primary",
              )
            : null,
        btn("Analyze", () => run("analyze")),
        btn("Graph", () => run("graph")),
        btn("Dashboard", () => run("dashboard")),
        btn("Generate tests", () => run("tests")),
        btn("Maximize", () => run("maximize")),
      ),
    );
  }

  function filters(model) {
    return el(
      "div",
      { class: "filters" },
      el("input", {
        type: "search",
        placeholder: "Filter findings",
        "aria-label": "Filter findings",
        value: ui.search,
        oninput: (e) => {
          ui.search = e.target.value;
          renderList();
        },
      }),
      el(
        "div",
        { class: "chips", role: "group", "aria-label": "Severity" },
        SEVERITIES.map((s) =>
          el(
            "button",
            {
              type: "button",
              class: `chip${ui.severities.has(s) ? " on" : ""}`,
              "aria-pressed": ui.severities.has(s) ? "true" : "false",
              onclick: () => {
                if (ui.severities.has(s)) ui.severities.delete(s);
                else ui.severities.add(s);
                render();
              },
            },
            sevMark(s),
            ` ${LABEL[s]}`,
          ),
        ),
        el(
          "button",
          {
            type: "button",
            class: `chip${ui.onlyFixable ? " on" : ""}`,
            "aria-pressed": ui.onlyFixable ? "true" : "false",
            onclick: () => {
              ui.onlyFixable = !ui.onlyFixable;
              render();
            },
          },
          "Has a fix",
        ),
      ),
      el(
        "select",
        {
          "aria-label": "Risk factor",
          onchange: (e) => {
            ui.factor = e.target.value;
            render();
          },
        },
        el("option", { value: "" }, "All risk factors"),
        model.factors.map((f) => el("option", { value: f.id, selected: ui.factor === f.id }, f.label)),
      ),
    );
  }

  function row(f) {
    const on = idOf(f) === ui.selected;
    return el(
      "li",
      {},
      el(
        "button",
        {
          type: "button",
          class: `row${on ? " on" : ""}`,
          "aria-current": on ? "true" : "false",
          "data-id": idOf(f),
          onclick: () => {
            ui.selected = idOf(f);
            render();
          },
        },
        sevMark(f.severity),
        el(
          "span",
          { class: "row-text" },
          el("span", { class: "row-title" }, f.title),
          el(
            "span",
            { class: "row-sub" },
            [f.object, f.files[0]?.split("/").pop()].filter(Boolean).join(" · ") || f.rule,
          ),
        ),
        f.fix ? el("span", { class: `badge ${f.fix.kind}`, title: KIND[f.fix.kind] }, "fix") : null,
      ),
    );
  }

  function renderList() {
    const host = document.getElementById("list");
    if (!host || !state.model) return;
    const rows = visible(state.model);
    host.replaceChildren(
      rows.length
        ? el("ul", { class: "rows" }, rows.map(row))
        : el("p", { class: "muted pad" }, "No findings match the filters."),
    );
    const count = document.getElementById("count");
    if (count) count.textContent = `${rows.length} of ${state.model.findings.length}`;
  }

  function diffView(diff) {
    const box = el("pre", { class: "diff", tabindex: "0", "aria-label": "Changes the fix makes" });
    for (const line of diff.split("\n")) {
      const cls =
        line.startsWith("+++") || line.startsWith("---")
          ? "file"
          : line.startsWith("@@")
            ? "hunk"
            : line.startsWith("+")
              ? "add"
              : line.startsWith("-")
                ? "del"
                : "";
      box.append(el("span", { class: `dl ${cls}` }, line || " "), "\n");
    }
    return box;
  }

  function detail(model) {
    const f = current(model);
    if (!f) {
      return el(
        "section",
        { class: "detail empty" },
        el(
          "p",
          { class: "muted pad" },
          model.findings.length ? "Select a finding to see why it matters and how to fix it." : "No findings.",
        ),
      );
    }
    const fix = f.fix;
    return el(
      "section",
      { class: "detail", "aria-label": "Selected finding" },
      el("h2", {}, sevMark(f.severity), ` ${f.title}`),
      el("p", { class: "meta" }, `${LABEL[f.severity]} · ${f.rule}${f.object ? ` · ${f.object}` : ""}`),
      el("p", { class: "text" }, f.detail),
      f.files.length
        ? el(
            "p",
            { class: "files" },
            el("span", { class: "muted" }, "Files: "),
            f.files.slice(0, 6).join(", "),
            f.files.length > 6 ? ` and ${f.files.length - 6} more` : "",
          )
        : null,
      el(
        "div",
        { class: "actions" },
        f.files.length ? btn("Open file", () => send("open", f.key)) : null,
        f.canAccept ? btn("Accept as known issue", () => send("accept", f.key)) : null,
        f.canTest ? btn("Generate tests", () => run("tests")) : null,
      ),
      fix
        ? el(
            "div",
            { class: "fix" },
            el("h3", {}, "Checked fix"),
            el("p", {}, el("b", {}, fix.label), el("span", { class: `badge ${fix.kind}` }, KIND[fix.kind])),
            el(
              "p",
              { class: "muted" },
              "Analyzing again with this fix applied removes the finding and adds no new high or medium one.",
            ),
            fix.note ? el("p", { class: "note" }, fix.note) : null,
            fix.alsoReports.length ? el("p", { class: "muted" }, `Also reports: ${fix.alsoReports.join("; ")}`) : null,
            diffView(fix.diff),
            el(
              "div",
              { class: "actions" },
              btn(
                fix.kind === "safe" ? "Apply fix" : "Apply fix (preview first)",
                () => send("applyFix", f.key),
                "primary",
              ),
            ),
          )
        : model.fixesPending
          ? el("p", { class: "muted" }, "Checking for a fix…")
          : el("p", { class: "muted" }, "No automatic fix for this finding."),
    );
  }

  function orderPane(model) {
    const f = current(model);
    const pane = el("aside", { class: "order", "aria-label": "Save order" });
    pane.append(el("h2", {}, "What runs on save"));
    if (!f?.object) {
      pane.append(el("p", { class: "muted" }, f ? "This finding isn't about one object's save." : "Select a finding."));
      return pane;
    }
    pane.append(
      el("p", { class: "muted" }, `When ${f.object} records are…`),
      el(
        "div",
        { class: "chips", role: "tablist" },
        EVENTS.map((e) =>
          el(
            "button",
            {
              type: "button",
              role: "tab",
              class: `chip${ui.event === e ? " on" : ""}`,
              "aria-selected": ui.event === e ? "true" : "false",
              onclick: () => {
                ui.event = e;
                render();
              },
            },
            e === "insert" ? "inserted" : `${e}d`,
          ),
        ),
      ),
    );
    const got = orders.get(`${f.key}|${ui.event}`);
    if (!got || got === "pending") {
      pane.append(el("p", { class: "muted" }, "Reading the project…"));
    } else if (got.error) {
      pane.append(el("p", { class: "muted" }, got.error));
    } else if (!got.steps.length) {
      pane.append(el("p", { class: "muted" }, "No automation in the project runs on this event."));
    } else {
      const list = el("ol", { class: "steps" });
      for (const s of got.steps) {
        list.append(
          el(
            "li",
            { class: s.hit ? "hit" : "" },
            el("span", { class: "phase" }, s.phase),
            el("span", { class: "name" }, s.name, el("span", { class: "muted" }, ` ${s.kind}`)),
            s.writes.length ? el("span", { class: "writes" }, `writes ${s.writes.join(", ")}`) : null,
            s.notes.length ? el("span", { class: "muted" }, s.notes.join("; ")) : null,
            s.hit ? el("span", { class: "here" }, "this finding") : null,
          ),
        );
      }
      pane.append(list, el("p", { class: "muted small" }, "Order of execution as modelled by sf-preflight."));
    }
    return pane;
  }

  // ------------------------------------------------------------ render

  function render() {
    const { model, meta } = state;
    const focus = document.activeElement?.getAttribute?.("data-id");
    const typing = document.activeElement instanceof HTMLInputElement && document.activeElement.type === "search";
    if (!model) {
      app.replaceChildren(
        el(
          "p",
          { class: "muted pad" },
          meta.error ? `Analysis failed: ${meta.error}` : meta.busy ? "Analyzing…" : "No analysis yet.",
        ),
        meta.error ? btn("Analyze again", () => run("analyze")) : null,
      );
      return;
    }
    if (!model.changed && !model.findings.length) {
      app.replaceChildren(
        header(model, meta),
        el(
          "p",
          { class: "empty-state pad" },
          "Nothing to check yet. Change Salesforce metadata, or compare with another branch. ",
          btn("Compare with branch…", () => run("base"), "link"),
        ),
      );
      return;
    }
    if (!current(model) || !visible(model).some((f) => idOf(f) === ui.selected)) {
      const first = visible(model)[0];
      ui.selected = first ? idOf(first) : undefined;
    }
    const f = current(model);
    askOrder(f);
    app.replaceChildren(
      header(model, meta),
      el(
        "main",
        { class: "cols" },
        el(
          "nav",
          { class: "findings", "aria-label": "Findings" },
          filters(model),
          el("p", { class: "muted small pad-x", id: "count" }),
          el("div", { id: "list" }),
        ),
        detail(model),
        orderPane(model),
      ),
    );
    renderList();
    if (focus) document.querySelector(`[data-id="${CSS.escape(focus)}"]`)?.focus();
    if (typing) {
      const input = document.querySelector('input[type="search"]');
      input?.focus();
      input?.setSelectionRange(ui.search.length, ui.search.length);
    }
    document.querySelector(".row.on")?.scrollIntoView({ block: "nearest" });
    document.querySelector(".steps .hit")?.scrollIntoView({ block: "nearest" });
  }

  // Up and down move through the list.
  document.addEventListener("keydown", (e) => {
    if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || !state.model) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const rows = visible(state.model);
    const i = rows.findIndex((f) => idOf(f) === ui.selected);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next || idOf(next) === ui.selected) return;
    e.preventDefault();
    ui.selected = idOf(next);
    render();
    document.querySelector(`[data-id="${CSS.escape(idOf(next))}"]`)?.focus();
  });

  window.addEventListener("message", (event) => {
    const trustedOrigin = window.location.origin;
    if (event.origin !== trustedOrigin) return;

    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "review") {
      const id = msg.model ? JSON.stringify(msg.model.findings.map((f) => [f.rule, f.title])) : "";
      if (id !== resultId) {
        orders = new Map();
        resultId = id;
      }
      state = { model: msg.model, meta: msg.meta ?? {} };
      render();
    } else if (msg.type === "saveOrder" && Number.isInteger(msg.key)) {
      // Keyed by the finding's key and the event asked for (the answer carries its own event).
      const o = msg.order;
      orders.set(`${msg.key}|${o?.event ?? ui.event}`, o ?? { error: "No answer." });
      render();
    }
  });

  vscode.postMessage({ type: "ready" });
})();
