// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { closeSync, fstatSync, ftruncateSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import path from "node:path";
import { fingerprint } from "./baseline.js";
import { comparisonBase, gitShow } from "./changes.js";
import { FIXABLE_RULES, type FixKind, type ProposedFix, proposeFix } from "./fixers.js";
import { analyzeChange, type RunOptions } from "./index.js";
import { unifiedDiff } from "./textDiff.js";
import type { AnalysisResult, Finding, Severity } from "./types.js";
import { toPosix } from "./util.js";

/**
 * Fixes for a change's findings. Each proposal is checked before it is offered: the change is
 * analyzed again with the fix applied (in memory, as the editor's unsaved text is), and the fix is
 * kept only if its finding is gone and it brings no new high or medium finding. Nothing is written
 * until `applyFixes`, and only a file still exactly as it was analyzed.
 */

export interface Fix extends ProposedFix {
  /** Short, stable id: the same finding gets the same id on the next run. */
  id: string;
  /** Unified diff of every edit. */
  diff: string;
  /** Low or info findings the fixed version has that the change didn't (worth knowing, not blocking). */
  alsoReports: string[];
}

export interface RejectedFix {
  finding: string;
  label: string;
  reason: string;
}

export interface FixReport {
  result: AnalysisResult;
  fixes: Fix[];
  /** Proposals that didn't pass the check. */
  rejected: RejectedFix[];
  /** Findings no fixer handles. */
  withoutFix: number;
}

const BLOCKING: ReadonlySet<Severity> = new Set(["high", "medium"]);

export const fixId = (f: Pick<Finding, "rule" | "title">) =>
  createHash("sha256").update(fingerprint(f)).digest("hex").slice(0, 8);

export interface FixOptions {
  /** Only these rules. */
  rules?: string[];
  /** Most proposals to check (each check is one more analysis). Default 25. */
  max?: number;
}

export function findFixes(opts: RunOptions, fixOpts: FixOptions = {}): FixReport {
  const projectDir = path.resolve(opts.projectDir);
  const overlay: Record<string, string> = {};
  for (const [f, t] of Object.entries(opts.overlay ?? {}))
    overlay[toPosix(path.relative(projectDir, path.resolve(projectDir, f)))] = t;
  const { result } = analyzeChange(opts);
  // The same commit the analysis compared with: HEAD for staged files, else the merge base.
  const baseRef = opts.staged ? "HEAD" : result.base ? comparisonBase(projectDir, result.base, opts.head) : undefined;
  const read = (file: string) => {
    if (file in overlay) return overlay[file];
    try {
      return readFileSync(path.join(projectDir, file), "utf8");
    } catch {
      return undefined;
    }
  };
  const readBase = (file: string) => (baseRef ? gitShow(projectDir, baseRef, file) : undefined);
  const before = new Set(result.findings.map(fingerprint));
  const changedFiles = new Set(result.changes.map((c) => c.component.file));
  const wanted = fixOpts.rules?.length ? new Set(fixOpts.rules) : undefined;

  const fixes: Fix[] = [];
  const rejected: RejectedFix[] = [];
  let withoutFix = 0;
  const seen = new Set<string>();
  for (const finding of result.findings) {
    const fp = fingerprint(finding);
    if (seen.has(fp)) continue;
    seen.add(fp);
    if (wanted && !wanted.has(finding.rule)) continue;
    if (!FIXABLE_RULES.has(finding.rule)) {
      withoutFix++;
      continue;
    }
    if (fixes.length + rejected.length >= (fixOpts.max ?? 25)) break;
    const proposal = proposeFix({ finding, result, read, readBase });
    if (!proposal) {
      withoutFix++;
      continue;
    }
    // The check: analyze again with the fix in place.
    const fixed = { ...overlay };
    for (const e of proposal.edits) fixed[e.file] = e.after;
    let after: AnalysisResult;
    try {
      after = analyzeChange({ ...opts, overlay: fixed }).result;
    } catch (err) {
      rejected.push({
        finding: finding.title,
        label: proposal.label,
        reason: `the check failed: ${(err as Error).message}`,
      });
      continue;
    }
    if (after.findings.some((f) => fingerprint(f) === fp)) {
      rejected.push({
        finding: finding.title,
        label: proposal.label,
        reason: "the finding is still there with the fix",
      });
      continue;
    }
    // A fix that edits files outside the change makes them part of it: compare with those files
    // unfixed, so their existing findings don't count as new.
    let reference = before;
    if (proposal.edits.some((e) => !changedFiles.has(e.file))) {
      const unfixed = { ...overlay };
      for (const e of proposal.edits) unfixed[e.file] = e.before;
      try {
        reference = new Set(analyzeChange({ ...opts, overlay: unfixed }).result.findings.map(fingerprint));
      } catch {
        // keep the change's own findings as the reference
      }
    }
    const introduced = after.findings.filter((f) => !reference.has(fingerprint(f)));
    const blocking = introduced.filter((f) => BLOCKING.has(f.severity));
    if (blocking.length) {
      rejected.push({
        finding: finding.title,
        label: proposal.label,
        reason: `it would bring ${blocking.map((f) => `"${f.title}"`).join(", ")}`,
      });
      continue;
    }
    fixes.push({
      ...proposal,
      id: fixId(finding),
      diff: proposal.edits.map((e) => unifiedDiff(e.file, e.before, e.after)).join("\n"),
      alsoReports: introduced.map((f) => f.title),
    });
  }
  return { result, fixes, rejected, withoutFix };
}

export interface CheckedFinding {
  id: string;
  rule: string;
  severity: Severity;
  title: string;
}

export interface EditCheck {
  /** accepted: a finding is gone and nothing blocking is new. rejected: something blocking is new, or the target is still there. no-effect: nothing changed in the findings. */
  verdict: "accepted" | "rejected" | "no-effect";
  resolved: CheckedFinding[];
  introduced: CheckedFinding[];
  /** The targeted finding, when one was named and it is still reported. */
  stillThere?: CheckedFinding;
  reasons: string[];
}

/**
 * Check an edit someone else wrote (a person, or a coding agent's "fix with AI"): analyze the change
 * again with the new file contents in place, as for a proposed fix. Nothing is written. `target` is a
 * fix id (as `findFixes` gives) or a rule id; when given, that finding must be gone for the edit to be accepted.
 */
export function checkEdits(opts: RunOptions, files: Record<string, string>, target?: string): EditCheck {
  const projectDir = path.resolve(opts.projectDir);
  const overlay: Record<string, string> = {};
  for (const [f, t] of Object.entries(opts.overlay ?? {}))
    overlay[toPosix(path.relative(projectDir, path.resolve(projectDir, f)))] = t;
  const fixed = { ...overlay };
  for (const [f, text] of Object.entries(files)) {
    const rel = toPosix(path.relative(projectDir, path.resolve(projectDir, f)));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`${f} is outside the project`);
    fixed[rel] = text;
  }
  const brief = (f: Finding): CheckedFinding => ({ id: fixId(f), rule: f.rule, severity: f.severity, title: f.title });
  const before = analyzeChange(opts).result.findings;
  const after = analyzeChange({ ...opts, overlay: fixed }).result.findings;
  const beforeKeys = new Set(before.map(fingerprint));
  const afterKeys = new Set(after.map(fingerprint));
  const resolved = before.filter((f) => !afterKeys.has(fingerprint(f))).map(brief);
  const introduced = after.filter((f) => !beforeKeys.has(fingerprint(f))).map(brief);
  const blocking = introduced.filter((f) => BLOCKING.has(f.severity));
  const reasons: string[] = [];
  const named = target ? after.find((f) => f.rule === target || fixId(f) === target) : undefined;
  const targetExisted = target ? before.some((f) => f.rule === target || fixId(f) === target) : true;
  if (target && !targetExisted) reasons.push(`no finding "${target}" in this change`);
  if (named) reasons.push(`"${named.title}" is still reported`);
  if (blocking.length) reasons.push(`it brings ${blocking.map((f) => `"${f.title}"`).join(", ")}`);
  let verdict: EditCheck["verdict"];
  if (reasons.length) verdict = "rejected";
  else if (resolved.length) verdict = "accepted";
  else verdict = "no-effect";
  if (verdict === "no-effect") reasons.push("the findings are the same with this edit");
  return { verdict, resolved, introduced, stillThere: named ? brief(named) : undefined, reasons };
}

export interface ApplyResult {
  applied: string[];
  /** Fixes not applied because a file changed since it was analyzed (another fix, or an edit). */
  stale: { id: string; file: string }[];
}

/**
 * Write fixes to disk. A fix is applied only if every file it edits is still exactly as analyzed;
 * otherwise it is left out (analyze again for a fresh proposal). Each file is read, checked and
 * written through one file handle.
 */
export function applyFixes(projectDir: string, fixes: Fix[]): ApplyResult {
  const applied: string[] = [];
  const stale: ApplyResult["stale"] = [];
  for (const fix of fixes) {
    const handles: { fd: number; edit: Fix["edits"][number] }[] = [];
    let ok = true;
    try {
      for (const edit of fix.edits) {
        const fd = openSync(path.join(projectDir, edit.file), "r+");
        handles.push({ fd, edit });
        const size = fstatSync(fd).size;
        const buf = Buffer.alloc(size);
        let off = 0;
        while (off < size) {
          const n = readSync(fd, buf, off, size - off, off);
          if (n <= 0) break;
          off += n;
        }
        if (buf.toString("utf8", 0, off) !== edit.before) {
          stale.push({ id: fix.id, file: edit.file });
          ok = false;
          break;
        }
      }
      if (ok) {
        for (const { fd, edit } of handles) {
          ftruncateSync(fd, 0);
          const data = Buffer.from(edit.after, "utf8");
          writeSync(fd, data, 0, data.length, 0);
        }
        applied.push(fix.id);
      }
    } catch {
      stale.push({ id: fix.id, file: handles.at(-1)?.edit.file ?? fix.edits[0]?.file ?? "" });
    } finally {
      for (const { fd } of handles) closeSync(fd);
    }
  }
  return { applied, stale };
}

const KIND_WORDS: Record<FixKind, string> = {
  safe: "safe",
  undo: "undoes part of the change",
  review: "read before applying",
};

export function fixesToMarkdown(report: FixReport, applied?: ApplyResult): string {
  const out: string[] = [];
  const done = new Set(applied?.applied ?? []);
  out.push(
    `## Preflight fixes: ${report.fixes.length} of ${report.result.findings.length} finding(s)${applied ? `, ${done.size} applied` : ""}`,
    "",
  );
  if (!report.fixes.length) out.push("No finding in this change has a checked fix.", "");
  for (const fix of report.fixes) {
    out.push(`### ${done.has(fix.id) ? "✅ " : ""}${fix.label} \`${fix.id}\``, "");
    out.push(`- **Fixes:** ${fix.finding} (\`${fix.rule}\`)`, `- **Kind:** ${KIND_WORDS[fix.kind]}`);
    if (fix.note) out.push(`- **Note:** ${fix.note}`);
    if (fix.alsoReports.length) out.push(`- **Afterwards also reported:** ${fix.alsoReports.join("; ")}`);
    out.push("", "```diff", fix.diff, "```", "");
  }
  if (report.rejected.length) {
    out.push("### Proposals that didn't pass the check", "");
    for (const r of report.rejected) out.push(`- ${r.label} (for "${r.finding}"): ${r.reason}.`);
    out.push("");
  }
  if (applied?.stale.length)
    out.push(
      `Not applied, because a file changed since it was analyzed: ${applied.stale.map((s) => `\`${s.id}\` (${s.file})`).join(", ")}. Run again for fresh fixes.`,
      "",
    );
  if (report.withoutFix)
    out.push(
      `${report.withoutFix} other finding(s) need a decision a rule can't make; the findings report says what to do about each.`,
      "",
    );
  return out.join("\n");
}
