// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { Fix } from "../src/core/index.js";
import { suggestionFor, suggestionsFor } from "../src/core/index.js";

const fix = (before: string, after: string, file = "a.xml"): Fix => ({
  id: "abc12345",
  rule: "r",
  finding: "f",
  label: "l",
  kind: "safe",
  edits: [{ file, before, after }],
  diff: "",
  alsoReports: [],
});

describe("pull request suggestions", () => {
  it("replaces the changed lines", () => {
    expect(suggestionFor(fix("a\nb\nc\nd\n", "a\nB\nC\nd\n"))).toMatchObject({
      startLine: 2,
      endLine: 3,
      current: ["b", "c"],
      replacement: ["B", "C"],
    });
  });

  it("deletes lines with an empty replacement", () => {
    expect(suggestionFor(fix("a\nb\nc\n", "a\nc\n"))).toMatchObject({
      startLine: 2,
      endLine: 2,
      current: ["b"],
      replacement: [],
    });
  });

  it("adds lines by replacing a neighbor with itself plus them", () => {
    expect(suggestionFor(fix("a\nb\nc\n", "a\nx\ny\nb\nc\n"))).toMatchObject({
      startLine: 2,
      endLine: 2,
      current: ["b"],
      replacement: ["x", "y", "b"],
    });
    expect(suggestionFor(fix("a\nb", "a\nb\nc"))).toMatchObject({ startLine: 2, endLine: 2, replacement: ["b", "c"] });
  });

  it("skips fixes it can't express as one suggestion", () => {
    const two = fix("a\n", "b\n");
    two.edits.push({ file: "b.xml", before: "x", after: "y" });
    expect(suggestionFor(two)).toBeUndefined();
    expect(suggestionFor(fix("a\r\nb\r\n", "a\r\nc\r\n"))).toBeUndefined();
    expect(suggestionsFor([two, fix("a", "b")])).toMatchObject({
      skipped: ["abc12345"],
      suggestions: [{ path: "a.xml" }],
    });
  });
});
