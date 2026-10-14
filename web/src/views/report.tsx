// SPDX-License-Identifier: Apache-2.0
import { useCallback, useMemo, useState } from "preact/hooks";
import type {
  AgentImpact,
  AnalysisResult,
  AutomationKind,
  CascadeNode,
  Finding,
  Severity,
  SuggestedTest,
  TestKind,
} from "../../../src/core/types.js";
import type { GraphNode } from "../../../vscode/src/graph.js";
import {
  Checklist,
  CopyButton,
  Facts,
  FileRef,
  Icon,
  type IndexItem,
  Rich,
  Section,
  SectionIndex,
  Sev,
} from "../components.js";
import { GraphFrame, type Theme } from "../graph.js";
import { formatDate, plural, reachSentence, riskWord, SEVERITIES, SEVERITY_LABEL, shortSha } from "../lib/format.js";
import type { ReportDoc } from "../lib/load.js";
import { toMarkdown } from "../lib/markdown.js";

const AUTOMATION_LABEL: Record<AutomationKind, string> = {
  Flow: "Flow",
  ApexTrigger: "Trigger",
  ApexClass: "Apex class",
  ValidationRule: "Validation rule",
  RollUpSummary: "Roll-up summary",
  LightningComponent: "Lightning component",
  ApprovalProcess: "Approval process",
  WorkflowRule: "Workflow rule",
  AssignmentRule: "Assignment rule",
  AutoResponseRule: "Auto-response rule",
  DuplicateRule: "Duplicate rule",
  EscalationRule: "Escalation rule",
  OmniScript: "OmniScript",
  IntegrationProcedure: "Integration Procedure",
  DataMapper: "Data Mapper",
  FlexCard: "FlexCard",
  Change: "The change",
};

const TEST_LABEL: Record<TestKind, string> = {
  agent: "Agent actions",
  bulk: "Bulk",
  "validation-collision": "Validation collisions",
  recursion: "Recursion",
  "permission-negative": "Permissions",
  idempotency: "Idempotency",
  boundary: "Boundaries",
};

function rangeText(r: AnalysisResult): string | undefined {
  if (r.base) return `${r.base} with ${r.head ?? "the working tree"}`;
  if (r.changes.length) return "Files given on the command line";
  return undefined;
}

function severityLine(counts: Record<Severity, number>): string {
  const parts = SEVERITIES.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
  return parts.length ? parts.join(", ") : "None";
}

// ---------------------------------------------------------------- verdict

function Verdict({ doc }: { doc: ReportDoc }) {
  const r = doc.report;
  const s = r.summary;
  return (
    <header class="verdict">
      <div>
        <div class={`word tone-${s.risk}`}>{riskWord(s.risk)}</div>
        <p class="sentence">{reachSentence(r)}</p>
        <Facts
          className="facts"
          items={[
            ["Compared", rangeText(r)],
            ["Project", r.projectPathInRepo !== undefined ? r.projectPathInRepo || "Repository root" : r.projectDir],
            ["Findings", severityLine(s.findingsBySeverity)],
            ["Policy", r.config ? <code>{r.config.file}</code> : undefined],
            ["Written", formatDate(r.generatedAt)],
            ["File", doc.origin ? `${doc.name} from ${doc.origin}` : doc.name],
          ]}
        />
        <div class="tools">
          <CopyButton text={() => toMarkdown(r)} label="Copy as Markdown" />
          <button type="button" class="btn" onClick={() => window.print()}>
            <Icon name="print" size={16} />
            <span class="label">Print</span>
          </button>
        </div>
        {doc.newer && (
          <p class="notice">A newer sf-preflight wrote this report. Parts this viewer doesn't know yet aren't shown.</p>
        )}
      </div>
      {r.gate ? (
        <Checklist gate={r.gate} />
      ) : (
        <div class="checklist">
          <header>
            <h2>Findings</h2>
            <span class="status muted">{plural(r.findings.length, "finding")}</span>
          </header>
          <ul>
            {SEVERITIES.map((sev) => (
              <li key={sev}>
                <span class={`sev ${sev}`} />
                <div class="label">
                  {s.findingsBySeverity[sev]} {SEVERITY_LABEL[sev].toLowerCase()}
                </div>
              </li>
            ))}
          </ul>
          <div class="foot">
            No quality gate in this report. Add <code>--gate</code> to <code>preflight analyze</code> to decide pass or
            fail from your policy.
          </div>
        </div>
      )}
    </header>
  );
}

// ---------------------------------------------------------------- findings

interface Scope {
  label: string;
  titles: string[];
}

function FindingItem({ f }: { f: Finding }) {
  const [first, ...rest] = f.files;
  return (
    <li class={`finding tone-${f.severity}`}>
      <span class="bar" aria-hidden="true" />
      <div>
        <div class="title">{f.title}</div>
        <div class="meta">
          <Sev severity={f.severity} />
          <code>{f.rule}</code>
          {f.object && <span>{f.object}</span>}
          {first && <FileRef file={first} line={f.line} />}
        </div>
        {f.detail && (
          <p class="detail">
            <Rich text={f.detail} />
          </p>
        )}
        {rest.length > 0 && (
          <ul class="files">
            {rest.map((file) => (
              <li key={file}>
                <FileRef file={file} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function Findings({ r, scope, clearScope }: { r: AnalysisResult; scope?: Scope; clearScope: () => void }) {
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [query, setQuery] = useState("");
  const counts = useMemo(() => {
    const c: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
    for (const f of r.findings) c[f.severity]++;
    return c;
  }, [r]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return r.findings.filter(
      (f) =>
        (severity === "all" || f.severity === severity) &&
        (!scope || scope.titles.includes(f.title)) &&
        (!q || [f.title, f.detail, f.rule, f.object ?? "", ...f.files].some((t) => t.toLowerCase().includes(q))),
    );
  }, [r, severity, query, scope]);

  return (
    <Section
      id="findings"
      title="Findings"
      count={r.findings.length}
      intro={
        r.findings.length
          ? "What could go wrong when this change ships, most severe first. Each finding names the rule that raised it."
          : undefined
      }
    >
      {r.findings.length === 0 ? (
        <p class="empty-note">No findings: nothing in this change matched a rule.</p>
      ) : (
        <>
          <div class="filters">
            <button type="button" class="chip" aria-pressed={severity === "all"} onClick={() => setSeverity("all")}>
              All <span class="n">{r.findings.length}</span>
            </button>
            {SEVERITIES.map((s) => (
              <button
                key={s}
                type="button"
                class="chip"
                aria-pressed={severity === s}
                disabled={!counts[s]}
                onClick={() => setSeverity(severity === s ? "all" : s)}
              >
                <span class={`sev ${s}`}>{SEVERITY_LABEL[s]}</span> <span class="n">{counts[s]}</span>
              </button>
            ))}
            <input
              class="search"
              type="search"
              placeholder="Search findings"
              aria-label="Search findings"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            />
          </div>
          {scope && (
            <div class="scope">
              <span>
                Findings on <b>{scope.label}</b>
              </span>
              <button type="button" class="linkish" onClick={clearScope}>
                Show all
              </button>
            </div>
          )}
          {shown.length ? (
            <ul class="findings">
              {shown.map((f, i) => (
                <FindingItem key={`${f.rule}-${i}`} f={f} />
              ))}
            </ul>
          ) : (
            <p class="empty-note">No findings match. Clear the search or pick another severity.</p>
          )}
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- order of execution, cascade

function SaveOrder({ r }: { r: AnalysisResult }) {
  return (
    <Section
      id="save-order"
      title="Order of execution"
      count={r.saveProcedures.length}
      intro="What runs, in order, when each impacted object is saved. Each step can write other records and start their saves too."
    >
      <div class="saves">
        {r.saveProcedures.map((sp) => (
          <article key={`${sp.object}-${sp.event}`} class="save">
            <h3>
              {sp.object} <span class="event">{sp.event}</span>
            </h3>
            {sp.steps.length ? (
              <ol class="steps">
                {sp.steps.map((st) => (
                  <li key={st.order}>
                    <div>
                      <div class="phase">{st.phaseLabel}</div>
                      <div class="what">
                        <code>{st.automation.name}</code>
                      </div>
                      {st.writes.length > 0 && (
                        <div class="writes">
                          Writes{" "}
                          {st.writes.map((w, i) => (
                            <span key={`${w.object}-${w.op}-${i}`}>
                              {i > 0 && ", "}
                              {w.object} ({w.op}
                              {w.selfUpdate ? ", the same record" : ""})
                            </span>
                          ))}
                        </div>
                      )}
                      {st.notes.map((n) => (
                        <div key={n} class="notes">
                          {n}
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p class="muted" style={{ padding: "12px 18px" }}>
                No automation runs on this save.
              </p>
            )}
          </article>
        ))}
      </div>
    </Section>
  );
}

function CascadeItem({ n }: { n: CascadeNode }) {
  return (
    <li>
      <span class="node">
        <span class="obj">{n.object}</span>
        <span class="muted">{n.event}</span>
        {n.via && (
          <span class="via">
            {n.via.kind === "Change" ? "from the change to " : `via ${AUTOMATION_LABEL[n.via.kind] ?? n.via.kind} `}
            <code>{n.via.name}</code>
          </span>
        )}
        {n.cycle && <span class="cycle-tag">Recursion: {n.object} is already on this path</span>}
        {n.truncated && <span class="muted">Deeper saves not followed</span>}
      </span>
      {n.children.length > 0 && (
        <ul>
          {n.children.map((c, i) => (
            <CascadeItem key={`${c.object}-${i}`} n={c} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Cascade({ r }: { r: AnalysisResult }) {
  return (
    <Section
      id="cascade"
      title="Cascade"
      count={r.cycles.length || undefined}
      intro={
        r.cycles.length
          ? `How the saves spread from the change. ${plural(r.cycles.length, "path")} loop${r.cycles.length === 1 ? "s" : ""} back to an object already saved, which recurses at bulk or agent volume.`
          : "How the saves spread from the change, object by object."
      }
    >
      <ul class="tree">
        {r.cascade.map((n, i) => (
          <CascadeItem key={`${n.object}-${i}`} n={n} />
        ))}
      </ul>
    </Section>
  );
}

// ---------------------------------------------------------------- agents, tests

function access(a: AgentImpact): string | undefined {
  if (!a.needs.length) return a.systemMode ? "None: the Apex runs in system mode" : undefined;
  return a.needs.map((n) => `${n.object} (${n.access.join(", ")})`).join("; ");
}

function Agents({ r }: { r: AnalysisResult }) {
  return (
    <Section
      id="agents"
      title="Agentforce actions"
      count={r.agents.length}
      intro="Agent actions that reach the change. An action can pick correctly and still fail on what the org does when it runs."
    >
      <div class="cards">
        {r.agents.map((a) => (
          <article key={`${a.agent}.${a.action}`} class="card">
            <div class="path">
              {a.agentLabel ?? a.agent}
              {a.topic ? ` › ${a.topic}` : ""}
            </div>
            <h3>{a.actionLabel ?? a.action}</h3>
            <Facts
              items={[
                [
                  "Calls",
                  <>
                    {a.target.kind === "ApexClass" ? "Apex class" : a.target.kind}{" "}
                    <code>{a.target.name ?? "unknown"}</code>
                    {!a.target.inProject && <span class="muted"> (not in this project)</span>}
                  </>,
                ],
                [
                  "Why it's affected",
                  a.reasons.length ? (
                    <ul class="plain-list">
                      {a.reasons.map((x) => (
                        <li key={x}>
                          <Rich text={x} />
                        </li>
                      ))}
                    </ul>
                  ) : undefined,
                ],
                ["Saves", a.reaches.length ? a.reaches.join(", ") : undefined],
                ["Recursion", a.cycle?.length ? <span class="fail">{a.cycle.join(" to ")}</span> : undefined],
                ["Runs as", a.runsAs === "dedicated user" ? "The agent's own runtime user" : "The signed-in user"],
                ["Access it needs", access(a)],
                [
                  "Testing Center",
                  a.tests.length ? (
                    plural(a.tests.length, "test") +
                    ` expect${a.tests.length === 1 ? "s" : ""} this action: ${a.tests.join(", ")}`
                  ) : (
                    <span class="fail">No test expects this action</span>
                  ),
                ],
                ["Confirmation", a.confirmationRequired ? "Asks the user to confirm" : undefined],
              ]}
            />
          </article>
        ))}
      </div>
    </Section>
  );
}

function Tests({ r }: { r: AnalysisResult }) {
  const groups = useMemo(() => {
    const m = new Map<TestKind, SuggestedTest[]>();
    for (const t of r.suggestedTests) m.set(t.kind, [...(m.get(t.kind) ?? []), t]);
    return [...m.entries()];
  }, [r]);
  return (
    <Section
      id="tests"
      title="Tests to run"
      count={r.suggestedTests.length}
      intro={
        <>
          The tests that matter for exactly what this change touches. <code>preflight tests</code> writes the Apex for
          them and can run them in a sandbox.
        </>
      }
    >
      <div class="groups">
        {groups.map(([kind, tests]) => (
          <div key={kind} class="group">
            <h3>{TEST_LABEL[kind] ?? kind}</h3>
            <ul class="plain-list">
              {tests.map((t, i) => (
                <li key={`${kind}-${i}`}>
                  <Rich text={t.description} />
                  {t.covers.length > 0 && <span class="muted"> Covers {t.covers.join(", ")}.</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- changes, references

function Changes({ r }: { r: AnalysisResult }) {
  const cov = r.coverage;
  return (
    <Section id="changes" title="Changes" count={r.changes.length}>
      {r.changes.length ? (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Change</th>
                <th>Component</th>
                <th>Type</th>
                <th>File</th>
              </tr>
            </thead>
            <tbody>
              {r.changes.map((c) => (
                <tr key={c.component.file}>
                  <td class={`change-type ${c.changeType}`}>{c.changeType}</td>
                  <td>
                    <code>{c.component.name}</code>
                  </td>
                  <td class="kind">{c.component.metadataType ?? c.component.type}</td>
                  <td>
                    <FileRef file={c.component.file} />
                    {c.previousFile && <div class="muted">from {c.previousFile}</div>}
                    {c.manifest && <div class="muted">deleted by {c.manifest}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="empty-note">No Salesforce metadata changed.</p>
      )}
      {cov && cov.basic > 0 && (
        <p class="verify">
          {plural(cov.deep, "component")} analyzed in depth; {plural(cov.basic, "component")} of other types (
          {cov.basicByType.map((t) => `${t.count} ${t.type}`).join(", ")}) recognized and checked for references only.
        </p>
      )}
      {r.ignoredFiles.length > 0 && (
        <details class="verify">
          <summary>{plural(r.ignoredFiles.length, "changed file")} outside the metadata</summary>
          <ul class="plain-list">
            {r.ignoredFiles.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Section>
  );
}

function References({ r }: { r: AnalysisResult }) {
  return (
    <Section
      id="references"
      title="References"
      count={r.references.length}
      intro="Metadata that refers to what changed and would break or behave differently."
    >
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Refers to</th>
              <th>From</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody>
            {r.references.map((ref, i) => (
              <tr key={`${ref.to}-${ref.from.name}-${i}`}>
                <td>
                  <code>{ref.to}</code>
                </td>
                <td>
                  <span class="kind">{AUTOMATION_LABEL[ref.from.kind as AutomationKind] ?? ref.from.kind}</span>{" "}
                  <code>{ref.from.name}</code>
                </td>
                <td>
                  {ref.from.file ? <FileRef file={ref.from.file} /> : <span class="muted">Not in the project</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- org, authorship, warnings

function Org({ r }: { r: AnalysisResult }) {
  const o = r.org!;
  const counts = Object.entries(o.recordCounts);
  return (
    <Section
      id="org"
      title="Org context"
      intro="Read-only facts from the org, so the source isn't the whole story. Counts and metadata names only."
    >
      <Facts
        items={[
          ["Org", o.org],
          ["Read", formatDate(o.queriedAt)],
        ]}
      />
      <div class="groups" style={{ marginTop: "24px" }}>
        {counts.length > 0 && (
          <div class="group">
            <h3>Records</h3>
            <div class="table-wrap">
              <table>
                <tbody>
                  {counts.map(([obj, n]) => (
                    <tr key={obj}>
                      <td>{obj}</td>
                      <td class="num">{n.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {o.orgOnlyAutomation.length > 0 && (
          <div class="group">
            <h3>Automation only in the org</h3>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Automation</th>
                    <th>Object</th>
                    <th>Runs</th>
                    <th>Package</th>
                  </tr>
                </thead>
                <tbody>
                  {o.orgOnlyAutomation.map((a) => (
                    <tr key={`${a.kind}-${a.name}`}>
                      <td>
                        <span class="kind">{AUTOMATION_LABEL[a.kind]}</span> <code>{a.name}</code>
                      </td>
                      <td>{a.object}</td>
                      <td>{a.when.join(", ")}</td>
                      <td>{a.packageName ?? a.namespace ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {o.assignments.length > 0 && (
          <div class="group">
            <h3>Who holds the changed access</h3>
            <ul class="plain-list">
              {o.assignments.map((a) => (
                <li key={`${a.kind}-${a.name}`}>
                  <code>{a.name}</code>: {plural(a.activeUsers, "active user")}
                </li>
              ))}
            </ul>
          </div>
        )}
        {(o.agentUsers ?? []).length > 0 && (
          <div class="group">
            <h3>Agent runtime users</h3>
            <ul class="plain-list">
              {o.agentUsers!.map((u) => (
                <li key={u.agent}>
                  {u.agentLabel ?? u.agent}'s runtime user:{" "}
                  {u.status !== "checked" ? (
                    u.status
                  ) : u.missing.length || u.missingClasses?.length ? (
                    <span class="fail">
                      missing{" "}
                      {[
                        ...u.missing.map((m) => `${m.object} (${m.access.join(", ")})`),
                        ...(u.missingClasses ?? []),
                      ].join("; ")}
                    </span>
                  ) : (
                    "has the access the actions need"
                  )}
                  {u.broad.length > 0 && <span class="muted"> Also has {u.broad.join(", ")}.</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {o.packages.length > 0 && (
          <div class="group">
            <h3>Installed packages</h3>
            <ul class="plain-list">
              {o.packages.map((p) => (
                <li key={p.name}>
                  {p.name} <span class="muted">{p.version}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {o.errors.length > 0 && (
          <div class="group">
            <h3>Queries that failed</h3>
            <ul class="plain-list">
              {o.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
}

function Authorship({ r }: { r: AnalysisResult }) {
  const p = r.provenance!;
  return (
    <Section
      id="authorship"
      title="Authorship"
      count={p.commits}
      intro="Commits in the range, and which carry signs of an AI coding tool. The analysis is the same either way; it tells reviewers where to look harder."
    >
      <Facts
        items={[
          ["Range", <code key="r">{p.range}</code>],
          ["AI-assisted", `${p.aiAssistedCommits} of ${plural(p.commits, "commit")}`],
          ["Tools", p.tools.length ? p.tools.join(", ") : undefined],
          ["History", p.shallow ? "Shallow clone: earlier commits are missing" : undefined],
        ]}
      />
      {p.details.length > 0 && (
        <div class="table-wrap" style={{ marginTop: "20px" }}>
          <table>
            <thead>
              <tr>
                <th>Commit</th>
                <th>Subject</th>
                <th>Author</th>
                <th>AI tools</th>
              </tr>
            </thead>
            <tbody>
              {p.details.map((c) => (
                <tr key={c.sha}>
                  <td>
                    <code>{shortSha(c.sha)}</code>
                  </td>
                  <td>{c.subject}</td>
                  <td>{c.author}</td>
                  <td>{c.aiTools.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- page

export function ReportView({ doc, theme }: { doc: ReportDoc; theme: Theme }) {
  const r = doc.report;
  const [scope, setScope] = useState<Scope>();
  const onNode = useCallback((n: GraphNode) => {
    setScope({ label: n.label, titles: n.findings });
    document.getElementById("findings")?.scrollIntoView();
  }, []);

  const has = {
    graph: r.changes.length > 0,
    saves: r.saveProcedures.length > 0,
    cascade: r.cascade.length > 0,
    agents: r.agents.length > 0,
    tests: r.suggestedTests.length > 0,
    references: r.references.length > 0,
    org: Boolean(r.org),
    authorship: Boolean(r.provenance),
    warnings: r.warnings.length > 0,
  };
  const index: IndexItem[] = [
    { id: "findings", label: "Findings", count: r.findings.length },
    ...(has.graph ? [{ id: "graph", label: "Blast radius" }] : []),
    ...(has.saves ? [{ id: "save-order", label: "Order of execution", count: r.saveProcedures.length }] : []),
    ...(has.cascade ? [{ id: "cascade", label: "Cascade" }] : []),
    ...(has.agents ? [{ id: "agents", label: "Agentforce", count: r.agents.length }] : []),
    ...(has.tests ? [{ id: "tests", label: "Tests to run", count: r.suggestedTests.length }] : []),
    { id: "changes", label: "Changes", count: r.changes.length },
    ...(has.references ? [{ id: "references", label: "References", count: r.references.length }] : []),
    ...(has.org ? [{ id: "org", label: "Org context" }] : []),
    ...(has.authorship ? [{ id: "authorship", label: "Authorship" }] : []),
    ...(has.warnings ? [{ id: "warnings", label: "Warnings", count: r.warnings.length }] : []),
  ];

  return (
    <main id="main" class="doc">
      <Verdict doc={doc} />
      <div class="body">
        <SectionIndex items={index} />
        <div class="sections">
          <Findings r={r} scope={scope} clearScope={() => setScope(undefined)} />
          {has.graph && (
            <Section
              id="graph"
              title="Blast radius"
              className="graph-section"
              intro="The change at the centre and one ring per hop: the objects it saves, the automation that runs, and what refers to it. Drag to pan and scroll to zoom; click a node with findings to list them."
            >
              <GraphFrame report={r} theme={theme} onNode={onNode} />
            </Section>
          )}
          {has.saves && <SaveOrder r={r} />}
          {has.cascade && <Cascade r={r} />}
          {has.agents && <Agents r={r} />}
          {has.tests && <Tests r={r} />}
          <Changes r={r} />
          {has.references && <References r={r} />}
          {has.org && <Org r={r} />}
          {has.authorship && <Authorship r={r} />}
          {has.warnings && (
            <Section
              id="warnings"
              title="Warnings"
              count={r.warnings.length}
              intro="Things the analysis couldn't read or follow."
            >
              <ul class="plain-list">
                {r.warnings.map((w) => (
                  <li key={w}>
                    <Rich text={w} />
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </main>
  );
}
