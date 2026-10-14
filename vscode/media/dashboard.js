// SPDX-License-Identifier: Apache-2.0
// The risk dashboard webview: the change's risk, its risk factors, where the risk sits and the trend
// over the branch's recent analyses. Data arrives from the extension by postMessage; clicking a
// finding asks the extension to open it (by key: the webview never handles file paths).
(() => {
  const vscode = acquireVsCodeApi();
  const SVG = "http://www.w3.org/2000/svg";
  const app = document.getElementById("app");
  const tip = document.getElementById("tip");
  const SEVERITIES = ["high", "medium", "low", "info"];
  const LABEL = { high: "High", medium: "Medium", low: "Low", info: "Info" };
  const RISKS = ["high", "medium", "low"];

  let state = { model: undefined, history: [], meta: {} };
  let selected; // the factor whose findings are listed

  // ------------------------------------------------------------ helpers

  const el = (tag, attrs = {}, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false) continue;
      if (k === "class") e.className = v;
      // Through the CSSOM: the page's CSP doesn't allow style attributes.
      else if (k === "style") e.style.cssText = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) e.append(c);
    return e;
  };
  const svgEl = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (parent) parent.appendChild(e);
    return e;
  };
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const run = (action) => vscode.postMessage({ type: "run", action });
  const button = (label, action, cls = "") =>
    el("button", { type: "button", class: cls, onclick: () => run(action) }, label);
  const sevMark = (s) => el("span", { class: `sq ${s}`, "aria-hidden": "true" });
  const when = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  // ------------------------------------------------------------ sections

  function toolbar(meta, model) {
    const where = [
      meta.project,
      model?.base ? `compared with ${model.base}` : undefined,
      meta.branch ? `on ${meta.branch}` : undefined,
    ].filter(Boolean);
    return el(
      "header",
      { class: "bar" },
      el("div", { class: "where" }, where.join(", "), meta.busy ? el("span", { class: "busy" }, "Analyzing…") : null),
      el(
        "div",
        { class: "actions" },
        button("Analyze", "analyze"),
        button("Review & fix", "review"),
        button("Graph", "graph"),
        button("Report", "report"),
        button("Generate tests", "tests"),
        button("Open in web viewer", "viewer"),
      ),
    );
  }

  function verdict(m) {
    const gate = m.gate;
    return el(
      "section",
      { class: "verdict", "aria-label": "Risk" },
      el("h1", { class: `risk ${m.risk}` }, `${LABEL[m.risk]} risk`),
      el("p", { class: "sentence" }, m.sentence),
      el(
        "div",
        { class: "counts" },
        SEVERITIES.map((s) => el("span", { class: m.counts[s] ? "" : "zero" }, sevMark(s), ` ${m.counts[s]} ${s}`)),
      ),
      el(
        "p",
        { class: `gate ${gate.status}` },
        el("span", { class: "gate-mark", "aria-hidden": "true" }, gate.status === "pass" ? "✓" : "✕"),
        el("b", {}, gate.status === "pass" ? "Gate passes on findings" : "Gate fails on findings"),
        el(
          "span",
          { class: "muted" },
          `: ${gate.label.toLowerCase()}. Approvals and test runs are checked in your pipeline.`,
        ),
      ),
    );
  }

  function factors(m) {
    const section = el(
      "section",
      { class: "factors", "aria-labelledby": "factors-h" },
      el("h2", { id: "factors-h" }, "Risk factors"),
    );
    if (!m.changed) {
      section.append(
        el(
          "p",
          { class: "empty" },
          "Nothing to check yet. Change Salesforce metadata, or compare with another branch. ",
          button("Compare with branch…", "base", "link"),
        ),
      );
      return section;
    }
    const tiles = el("div", { class: "tiles", role: "list" });
    for (const f of m.factors) {
      const on = selected === f.id;
      tiles.append(
        el(
          "button",
          {
            type: "button",
            role: "listitem",
            class: `tile${f.count ? "" : " none"}${on ? " on" : ""}`,
            "aria-pressed": on ? "true" : "false",
            disabled: !f.count,
            title: f.meaning,
            onclick: () => {
              selected = on ? undefined : f.id;
              render();
              if (selected) document.getElementById("list")?.scrollIntoView({ block: "nearest" });
            },
          },
          el("span", { class: "count" }, f.count ? String(f.count) : "None"),
          el("span", { class: "label" }, f.label),
          f.worst ? el("span", { class: "worst" }, sevMark(f.worst), ` worst: ${f.worst}`) : null,
          el("span", { class: "meaning" }, f.meaning),
        ),
      );
    }
    section.append(tiles);
    const chosen = m.factors.find((f) => f.id === selected);
    if (chosen) {
      section.append(
        el(
          "div",
          { id: "list", class: "list" },
          el("h3", {}, `${chosen.label}: ${plural(chosen.count, "finding")}`),
          el(
            "ul",
            {},
            chosen.findings.map((f) =>
              el(
                "li",
                {},
                el(
                  "button",
                  {
                    type: "button",
                    class: "finding",
                    disabled: !f.file,
                    title: f.file ? "Open the file" : undefined,
                    onclick: () => vscode.postMessage({ type: "open", key: f.key }),
                  },
                  sevMark(f.severity),
                  el("span", { class: "title" }, f.title),
                  el(
                    "span",
                    { class: "meta" },
                    [f.rule, f.object, f.file ? `${f.file.split("/").pop()}${f.line ? `:${f.line}` : ""}` : undefined]
                      .filter(Boolean)
                      .join("  ·  "),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }
    return section;
  }

  function hotspots(m) {
    const section = el(
      "section",
      { class: "spots", "aria-labelledby": "spots-h" },
      el("h2", { id: "spots-h" }, "Where the risk sits"),
    );
    if (!m.hotspots.length) {
      section.append(el("p", { class: "empty" }, "No impacted objects."));
      return section;
    }
    // The meter shows how much is wrong on each object: its findings plus the cycles it's on.
    const weight = (h) => h.findings + h.cycles;
    const most = Math.max(1, ...m.hotspots.map(weight));
    section.append(
      el(
        "ol",
        {},
        m.hotspots.map((h) =>
          el(
            "li",
            {},
            el("span", { class: "obj" }, h.worst ? sevMark(h.worst) : el("span", { class: "sq none" }), ` ${h.object}`),
            el(
              "span",
              { class: "meter", "aria-hidden": "true" },
              el("span", {
                class: `fill ${h.worst ?? "none"}`,
                style: `width:${Math.round((weight(h) / most) * 100)}%`,
              }),
            ),
            el(
              "span",
              { class: "what" },
              [
                h.findings ? plural(h.findings, "finding") : "no findings",
                h.cycles ? `on ${plural(h.cycles, "recursion cycle")}` : "",
                h.automations ? `${plural(h.automations, "automation")} on save` : "",
              ]
                .filter(Boolean)
                .join(", "),
            ),
          ),
        ),
      ),
    );
    return section;
  }

  function trend(history, branch) {
    const section = el(
      "section",
      { class: "trend", "aria-labelledby": "trend-h" },
      el("h2", { id: "trend-h" }, "Trend"),
      el(
        "p",
        { class: "muted small" },
        `Findings over the last ${plural(history.length, "analysis", "analyses")}${branch ? ` on ${branch}` : ""}. A bar is added when the result changes.`,
      ),
    );
    if (history.length < 2) {
      section.append(
        el(
          "p",
          { class: "empty" },
          "The trend fills in as you work: each analysis that changes the result adds a bar.",
        ),
      );
      return section;
    }
    section.append(
      el(
        "div",
        { class: "legend" },
        ["high", "medium", "low"].map((s) => el("span", {}, sevMark(s), ` ${LABEL[s]}`)),
      ),
    );

    const W = 560;
    const H = 150;
    const pad = { l: 28, r: 8, t: 8, b: 22 };
    const n = history.length;
    const max = Math.max(1, ...history.map((h) => h.high + h.medium + h.low));
    const slot = (W - pad.l - pad.r) / n;
    const bw = Math.max(4, Math.min(28, slot * 0.62));
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
    const svg = svgEl("svg", {
      viewBox: `0 0 ${W} ${H}`,
      class: "chart",
      role: "img",
      "aria-label": "Findings per analysis",
    });
    // Recessive grid: the baseline and the maximum.
    for (const v of [0, max]) {
      svgEl("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: v ? "grid" : "axis" }, svg);
      svgEl("text", { x: pad.l - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, svg).textContent = String(v);
    }
    history.forEach((h, i) => {
      const x = pad.l + slot * i + (slot - bw) / 2;
      let base = 0;
      const segs = ["high", "medium", "low"].filter((s) => h[s] > 0);
      segs.forEach((s, j) => {
        const top = base + h[s];
        const y0 = y(base);
        const y1 = y(top);
        // A 2px surface gap between stacked segments.
        const gap = j > 0 ? 2 : 0;
        const height = Math.max(1, y0 - y1 - gap);
        svgEl("rect", { x, y: y1, width: bw, height, rx: j === segs.length - 1 ? 3 : 0, class: `bar ${s}` }, svg);
        base = top;
      });
      // Hit target wider and taller than the bar.
      const hit = svgEl(
        "rect",
        { x: pad.l + slot * i, y: pad.t, width: slot, height: H - pad.t - pad.b, class: "hit" },
        svg,
      );
      const text = `${when(h.at)}: ${h.high} high, ${h.medium} medium, ${h.low} low${h.info ? `, ${h.info} info` : ""}; ${plural(h.changed, "changed component")}`;
      hit.addEventListener("mouseenter", (ev) => showTip(ev, text));
      hit.addEventListener("mousemove", (ev) => showTip(ev, text));
      hit.addEventListener("mouseleave", () => (tip.hidden = true));
    });
    svgEl("text", { x: pad.l, y: H - 6, class: "tick" }, svg).textContent = when(history[0].at);
    svgEl("text", { x: W - pad.r, y: H - 6, class: "tick", "text-anchor": "end" }, svg).textContent = when(
      history[n - 1].at,
    );
    section.append(svg);

    // The same numbers as a table, for screen readers and exact values.
    section.append(
      el(
        "details",
        { class: "table" },
        el("summary", {}, "Show as table"),
        el(
          "table",
          {},
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              ["Analysis", "Risk", "High", "Medium", "Low", "Info", "Changed"].map((t) => el("th", {}, t)),
            ),
          ),
          el(
            "tbody",
            {},
            [...history]
              .reverse()
              .map((h) =>
                el(
                  "tr",
                  {},
                  el("td", {}, when(h.at)),
                  el("td", {}, h.risk),
                  ...[h.high, h.medium, h.low, h.info, h.changed].map((v) => el("td", { class: "num" }, String(v))),
                ),
              ),
          ),
        ),
      ),
    );
    return section;
  }

  function showTip(ev, text) {
    tip.textContent = text;
    tip.hidden = false;
    const x = Math.min(ev.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, ev.clientY - tip.offsetHeight - 12)}px`;
  }

  // ------------------------------------------------------------ page

  function render() {
    const { model, history, meta } = state;
    app.replaceChildren();
    app.append(toolbar(meta, model));
    if (meta.error && !model) {
      app.append(el("p", { class: "error" }, `Couldn't analyze: ${meta.error}`));
      return;
    }
    if (!model) {
      app.append(el("p", { class: "muted" }, meta.busy ? "Analyzing…" : "No analysis yet."));
      return;
    }
    if (selected && !model.factors.some((f) => f.id === selected && f.count)) selected = undefined;
    app.append(
      verdict(model),
      factors(model),
      el("div", { class: "pair" }, hotspots(model), trend(history, meta.branch)),
    );
  }

  // Messages only come from VS Code. Everything used is checked and rebuilt with known fields.
  const str = (v, max = 400) => (typeof v === "string" ? v.slice(0, max) : undefined);
  const int = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, 1e7) : 0);
  const sev = (v) => (SEVERITIES.includes(v) ? v : undefined);
  function clean(msg) {
    const m = msg.model;
    const model =
      m && typeof m === "object" && RISKS.includes(m.risk)
        ? {
            risk: m.risk,
            sentence: str(m.sentence) ?? "",
            changed: int(m.changed),
            base: str(m.base, 200),
            counts: Object.fromEntries(SEVERITIES.map((s) => [s, int(m.counts?.[s])])),
            gate: {
              status: m.gate?.status === "pass" ? "pass" : "fail",
              label: str(m.gate?.label, 200) ?? "",
            },
            factors: (Array.isArray(m.factors) ? m.factors : []).slice(0, 20).map((f) => ({
              id: str(f?.id, 40) ?? "",
              label: str(f?.label, 80) ?? "",
              meaning: str(f?.meaning) ?? "",
              count: int(f?.count),
              worst: sev(f?.worst),
              findings: (Array.isArray(f?.findings) ? f.findings : []).slice(0, 500).map((x) => ({
                key: int(x?.key),
                title: str(x?.title) ?? "",
                severity: sev(x?.severity) ?? "info",
                rule: str(x?.rule, 80) ?? "",
                object: str(x?.object, 120),
                file: str(x?.file, 400),
                line: int(x?.line) || undefined,
              })),
            })),
            hotspots: (Array.isArray(m.hotspots) ? m.hotspots : []).slice(0, 20).map((h) => ({
              object: str(h?.object, 120) ?? "",
              findings: int(h?.findings),
              automations: int(h?.automations),
              cycles: int(h?.cycles),
              worst: sev(h?.worst),
            })),
          }
        : undefined;
    const history = (Array.isArray(msg.history) ? msg.history : []).slice(-60).flatMap((h) =>
      h && RISKS.includes(h.risk) && typeof h.at === "string"
        ? [
            {
              at: h.at,
              risk: h.risk,
              high: int(h.high),
              medium: int(h.medium),
              low: int(h.low),
              info: int(h.info),
              changed: int(h.changed),
            },
          ]
        : [],
    );
    const meta = msg.meta ?? {};
    return {
      model,
      history,
      meta: {
        project: str(meta.project, 200),
        branch: str(meta.branch, 200),
        busy: meta.busy === true,
        error: str(meta.error),
      },
    };
  }

  window.addEventListener("message", (ev) => {
    if (ev.origin !== window.location.origin) return;
    if (ev.data?.type !== "dashboard") return;
    state = clean(ev.data);
    render();
  });
  vscode.postMessage({ type: "ready" });
})();
