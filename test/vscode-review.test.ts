// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Fix, fixId } from "../src/core/fix.js";
import { analyzeChange } from "../src/core/index.js";
import type { SaveProcedure } from "../src/core/types.js";
import { independentSafeFixes, reviewOf, saveOrderOf } from "../vscode/src/review.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/sample-org");
const SRC = "force-app/main/default";
const result = analyzeChange({
  projectDir: FIXTURE,
  files: [path.join(FIXTURE, SRC, "objects/Opportunity/fields/Contract_Signed_Date__c.field-meta.xml")],
  config: false,
}).result;

const fixFor = (i: number, kind: Fix["kind"], file: string): Fix => {
  const f = result.findings[i]!;
  return {
    rule: f.rule,
    finding: f.title,
    id: fixId({ rule: f.rule, title: f.title }),
    label: `Fix ${i}`,
    kind,
    edits: [{ file, before: "a", after: "b" }],
    diff: `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`,
    alsoReports: [],
  };
};

describe("the review model", () => {
  it("lists every finding by key, with its risk factor, before fixes are known", () => {
    const m = reviewOf(result, undefined, undefined);
    expect(m.findings).toHaveLength(result.findings.length);
    expect(m.findings.map((f) => f.key)).toEqual(result.findings.map((_, i) => i));
    expect(m.fixesPending).toBe(true);
    expect(m.safeFixes).toBe(0);
    expect(m.risk).toBe("high");
    expect(m.findings.every((f) => m.factors.some((x) => x.id === f.factor))).toBe(true);
    expect(JSON.stringify(m)).not.toContain(FIXTURE);
  });

  it("attaches the checked fix to its finding and counts the ones that apply together", () => {
    const m = reviewOf(result, undefined, [fixFor(0, "safe", "a.cls"), fixFor(1, "review", "b.cls")]);
    expect(m.fixesPending).toBe(false);
    expect(m.findings[0]!.fix).toMatchObject({ label: "Fix 0", kind: "safe", files: ["a.cls"] });
    expect(m.findings[1]!.fix?.kind).toBe("review");
    expect(m.findings[2]?.fix).toBeUndefined();
    expect(m.safeFixes).toBe(1);
  });

  it("applies only safe fixes together, and not two that edit one file", () => {
    const a = fixFor(0, "safe", "a.cls");
    const b = fixFor(1, "safe", "a.cls");
    const c = fixFor(2, "safe", "c.cls");
    const d = fixFor(3, "undo", "d.cls");
    const { apply, later } = independentSafeFixes([a, b, c, d]);
    expect(apply.map((f) => f.label)).toEqual(["Fix 0", "Fix 2"]);
    expect(later.map((f) => f.label)).toEqual(["Fix 1"]);
  });
});

describe("the save order beside a finding", () => {
  const procedure: SaveProcedure = {
    object: "Contact",
    event: "update",
    steps: [
      {
        order: 1,
        phase: "before-trigger",
        phaseLabel: "Before-save triggers",
        automation: { kind: "ApexTrigger", name: "ContactTrigger", file: "triggers/ContactTrigger.trigger" },
        writes: [],
        notes: [],
      },
      {
        order: 2,
        phase: "after-trigger",
        phaseLabel: "After-save triggers",
        automation: { kind: "ApexClass", name: "ContactTriggerHandler", file: "classes/ContactTriggerHandler.cls" },
        writes: [{ object: "Account", op: "update", confidence: "high" }],
        notes: ["runs once"],
      },
    ],
  };

  it("marks the step a finding is about, by name or by file", () => {
    const byName = saveOrderOf(procedure, {
      title: "ContactTriggerHandler updates Account",
      detail: "",
      files: [],
    });
    expect(byName.steps.map((s) => s.hit)).toEqual([false, true]);
    const byFile = saveOrderOf(procedure, {
      title: "Loop",
      detail: "",
      files: ["triggers/ContactTrigger.trigger"],
    });
    expect(byFile.steps.map((s) => s.hit)).toEqual([true, false]);
    expect(byName.steps[1]).toMatchObject({
      phase: "After-save triggers",
      writes: ["Account (update)"],
      notes: ["runs once"],
    });
  });

  it("doesn't mark a step whose name is only part of another word", () => {
    const m = saveOrderOf(procedure, { title: "MyContactTriggerX", detail: "", files: [] });
    expect(m.steps.every((s) => !s.hit)).toBe(true);
  });
});
