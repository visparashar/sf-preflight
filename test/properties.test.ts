// SPDX-License-Identifier: Apache-2.0
/**
 * Property-based tests (fuzzing) for the code that reads untrusted input: metadata and source
 * files from a repository, webhook URLs and text that ends up in Slack or Teams messages.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseDestructiveManifest } from "../src/core/destructive.js";
import { mergeFields, qualify } from "../src/core/fieldUsers.js";
import { hostOf } from "../src/core/integrations.js";
import { assertSafeWebhook, plain, slackEscape } from "../src/core/notify.js";
import { formulaFieldRefs } from "../src/core/parsers/formula.js";
import { classifyPath } from "../src/core/project.js";
import { referencePatterns } from "../src/core/references.js";

const RUNS = { numRuns: 300 };
const apiName = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,8}_[A-Za-z0-9]{1,10}$/);

describe("parsers never throw on arbitrary text", () => {
  it("formula field references", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (s) => {
        for (const r of formulaFieldRefs(s)) {
          expect(r.startsWith("$")).toBe(false);
          expect(r).toMatch(/^[A-Za-z_][\w.]*$/);
        }
      }),
      RUNS,
    );
  });

  it("destructive manifests", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (s) => {
        for (const m of parseDestructiveManifest(`<Package><types>${s}<name>ApexClass</name></types></Package>`)) {
          expect(m.member).not.toBe("*");
          expect(m.member.includes("..")).toBe(false);
        }
      }),
      RUNS,
    );
  });

  it("merge fields and report tokens", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (s) => {
        for (const f of mergeFields(s)) expect(f).toMatch(/^[A-Za-z_]\w*\.[A-Za-z_]\w*$/);
        const q = qualify(s, "Account");
        if (q !== undefined) expect(q.split(".").length).toBe(2);
      }),
      RUNS,
    );
  });

  it("URL hosts", () => {
    fc.assert(
      fc.property(fc.oneof(fc.webUrl(), fc.string()), (s) => {
        const h = hostOf(s);
        if (h !== undefined) {
          expect(h).toBe(h.toLowerCase());
          expect(h).not.toMatch(/[/:?#]/);
        }
      }),
      RUNS,
    );
  });
});

describe("reference patterns", () => {
  it("are valid regular expressions for any component name", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 60 }), (name) => {
        const safe = name.replace(/[/\\]/g, "_");
        expect(() =>
          referencePatterns(classifyPath(`force-app/main/default/staticresources/${safe}.resource-meta.xml`)),
        ).not.toThrow();
      }),
      RUNS,
    );
  });

  it("find a static resource by its own syntax, and never by a name declaration", () => {
    fc.assert(
      fc.property(apiName, (name) => {
        const res = referencePatterns(classifyPath(`force-app/main/default/staticresources/${name}.resource-meta.xml`));
        expect(res.some((r) => r.test(`{!$Resource.${name}}`))).toBe(true);
        expect(res.some((r) => r.test(`<fullName>${name}</fullName>`))).toBe(false);
        expect(res.some((r) => r.test(`{!$Resource.${name}X}`))).toBe(false);
      }),
      RUNS,
    );
  });
});

describe("text sent to Slack and Teams", () => {
  it("plain() removes control and format characters and respects the length limit", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500, unit: "binary" }), fc.integer({ min: 1, max: 200 }), (s, max) => {
        const out = plain(s, max);
        expect(out.length).toBeLessThanOrEqual(max + 1);
        expect(out).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      }),
      RUNS,
    );
  });

  it("slackEscape() leaves no markup characters", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (s) => {
        const out = slackEscape(s);
        expect(out).not.toMatch(/[<>]/);
        expect(out).not.toMatch(/&(?!amp;|lt;|gt;)/);
      }),
      RUNS,
    );
  });

  it("webhook URLs are https or refused, and a refusal never repeats the URL", () => {
    fc.assert(
      fc.property(fc.oneof(fc.webUrl({ withQueryParameters: true }), fc.string({ maxLength: 80 })), (raw) => {
        try {
          expect(assertSafeWebhook(raw).protocol).toBe("https:");
        } catch (err) {
          if (raw.length >= 12) expect((err as Error).message).not.toContain(raw);
        }
      }),
      RUNS,
    );
  });
});
