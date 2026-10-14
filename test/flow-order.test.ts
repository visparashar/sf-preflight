// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject, saveProcedure } from "../src/core/index.js";

const NS = 'xmlns="http://soap.sforce.com/2006/04/metadata"';

describe("record-triggered flow order", () => {
  let dir: string;
  const flow = (name: string, trigger: "RecordBeforeSave" | "RecordAfterSave", order?: number) => {
    const f = path.join(dir, "force-app/main/default/flows", `${name}.flow-meta.xml`);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(
      f,
      `<Flow ${NS}><status>Active</status><start><object>Case</object><recordTriggerType>Create</recordTriggerType><triggerType>${trigger}</triggerType>${order ? `<triggerOrder>${order}</triggerOrder>` : ""}</start></Flow>`,
    );
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "preflight-flow-order-"));
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("runs orders 1 to 1000 first, then flows without one, then 1001 to 2000, ties by name", () => {
    flow("Late", "RecordAfterSave", 1500);
    flow("Unordered_B", "RecordAfterSave");
    flow("Unordered_A", "RecordAfterSave");
    flow("Second", "RecordAfterSave", 50);
    flow("First_Tie_B", "RecordAfterSave", 10);
    flow("First_Tie_A", "RecordAfterSave", 10);
    flow("Alone_Before", "RecordBeforeSave");
    const p = saveProcedure(loadProject(dir, { cache: false }), "Case", "insert");
    expect(p.steps.map((s) => s.automation.name)).toEqual([
      "Alone_Before",
      "First_Tie_A",
      "First_Tie_B",
      "Second",
      "Unordered_A",
      "Unordered_B",
      "Late",
    ]);
    const notes = Object.fromEntries(p.steps.map((s) => [s.automation.name, s.notes]));
    expect(notes.Second).toContain("trigger order 50");
    expect(notes.Unordered_A?.join(" ")).toContain("no trigger order");
    // A flow that runs alone, or ahead of nothing, says nothing about order.
    expect(notes.Alone_Before).toEqual([]);
  });
});
