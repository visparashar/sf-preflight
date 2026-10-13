// SPDX-License-Identifier: Apache-2.0
// The extension's "newer version available" notification: when it asks, when it tells, and what each button does.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
let dir;
let mod;
const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sf-preflight-update-"));
  await build({
    entryPoints: [path.join(here, "..", "src", "updateCheck.ts")],
    outfile: path.join(dir, "update.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  mod = createRequire(import.meta.url)(path.join(dir, "update.cjs"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

function harness(opts = {}) {
  const { answer, stored } = opts;
  const latest = "latest" in opts ? opts.latest : "0.6.0";
  const store = new Map(stored ? [[mod.UPDATE_STATE_KEY, stored]] : []);
  const calls = { fetched: 0, shown: [], opened: 0, notes: 0 };
  let settle;
  const answered = new Promise((r) => (settle = r));
  const deps = (now) => ({
    current: "0.5.0",
    now,
    state: { get: (k) => store.get(k), update: async (k, v) => void store.set(k, v) },
    fetchLatest: async () => {
      calls.fetched++;
      return latest;
    },
    show: async (message, ...items) => {
      calls.shown.push([message, ...items]);
      setImmediate(settle);
      return answer;
    },
    openExtension: () => calls.opened++,
    openReleaseNotes: () => calls.notes++,
  });
  return { store, calls, deps, answered };
}

test("announces a newer version once a day, asking the registry at most once a day", async () => {
  const h = harness();
  assert.equal(await mod.checkForExtensionUpdate(h.deps(10 * DAY)), "0.6.0");
  assert.deepEqual(h.calls.shown[0], [
    "sf-preflight 0.6.0 is available (you have 0.5.0).",
    "Update",
    "What's new",
    "Skip this version",
  ]);
  assert.equal(await mod.checkForExtensionUpdate(h.deps(10 * DAY + 1000)), undefined);
  assert.equal(h.calls.fetched, 1);
  assert.equal(await mod.checkForExtensionUpdate(h.deps(11 * DAY)), "0.6.0");
  assert.equal(h.calls.fetched, 2);
});

test("says nothing when up to date or when the registry can't be reached", async () => {
  assert.equal(await mod.checkForExtensionUpdate(harness({ latest: "0.5.0" }).deps(DAY)), undefined);
  const offline = harness({ latest: undefined });
  assert.equal(await mod.checkForExtensionUpdate(offline.deps(DAY)), undefined);
  assert.equal(offline.store.get(mod.UPDATE_STATE_KEY).checkedAt, DAY);
});

test("Update opens the extension's page; What's new opens the release notes", async () => {
  const u = harness({ answer: "Update" });
  await mod.checkForExtensionUpdate(u.deps(DAY));
  await u.answered;
  assert.equal(u.calls.opened, 1);
  const n = harness({ answer: "What's new" });
  await mod.checkForExtensionUpdate(n.deps(DAY));
  await n.answered;
  assert.equal(n.calls.notes, 1);
});

test("a skipped version is not announced again, but the next one is", async () => {
  const h = harness({ answer: "Skip this version" });
  await mod.checkForExtensionUpdate(h.deps(DAY));
  await h.answered;
  await new Promise((r) => setImmediate(r));
  assert.equal(h.store.get(mod.UPDATE_STATE_KEY).skipped, "0.6.0");
  assert.equal(await mod.checkForExtensionUpdate(h.deps(5 * DAY)), undefined);
  const next = harness({ latest: "0.7.0", stored: h.store.get(mod.UPDATE_STATE_KEY) });
  assert.equal(await mod.checkForExtensionUpdate(next.deps(9 * DAY)), "0.7.0");
});
