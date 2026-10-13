// SPDX-License-Identifier: Apache-2.0
// The analysis worker pool: workers are reused, crash and timeouts are handled, nothing leaks.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
let dir;
let WorkerPool;
let script;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sf-preflight-pool-"));
  await build({
    entryPoints: [path.join(here, "..", "src", "workerPool.ts")],
    outfile: path.join(dir, "pool.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  ({ WorkerPool } = createRequire(import.meta.url)(path.join(dir, "pool.cjs")));
  // A stand-in for the analysis worker: answers with its thread id and a counter it keeps.
  script = path.join(dir, "worker.cjs");
  writeFileSync(
    script,
    `const { parentPort, threadId } = require("node:worker_threads");
let calls = 0;
parentPort.on("message", ({ id, req }) => {
  calls++;
  if (req.kind === "crash") process.exit(3);
  if (req.kind === "hang") return;
  if (req.kind === "fail") return parentPort.postMessage({ id, ok: false, error: "bad request" });
  setTimeout(() => parentPort.postMessage({ id, ok: true, value: { thread: threadId, calls } }), req.ms ?? 0);
});`,
  );
});

after(() => rmSync(dir, { recursive: true, force: true }));

const opts = { size: 2, idleMs: 60_000, timeoutMs: 2_000, timeoutMessage: "too slow" };

test("reuses a worker, so what it loaded is still there", async () => {
  const pool = new WorkerPool(script, opts);
  const a = await pool.run({ kind: "ok" });
  const b = await pool.run({ kind: "ok" });
  assert.equal(b.thread, a.thread);
  assert.equal(b.calls, 2);
  pool.dispose();
});

test("runs jobs side by side and keeps at most `size` idle workers", async () => {
  const pool = new WorkerPool(script, opts);
  const results = await Promise.all([1, 2, 3].map(() => pool.run({ kind: "ok", ms: 100 })));
  assert.equal(new Set(results.map((r) => r.thread)).size, 3);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pool.alive, 2);
  pool.dispose();
  assert.equal(pool.alive, 0);
});

test("reports a failed request and keeps the worker", async () => {
  const pool = new WorkerPool(script, opts);
  const a = await pool.run({ kind: "ok" });
  await assert.rejects(pool.run({ kind: "fail" }), /bad request/);
  const b = await pool.run({ kind: "ok" });
  assert.equal(b.thread, a.thread);
  pool.dispose();
});

test("a worker that crashes is replaced", async () => {
  const pool = new WorkerPool(script, opts);
  const a = await pool.run({ kind: "ok" });
  await assert.rejects(pool.run({ kind: "crash" }), /exit code 3/);
  const b = await pool.run({ kind: "ok" });
  assert.notEqual(b.thread, a.thread);
  assert.equal(b.calls, 1);
  pool.dispose();
});

test("a job past the time limit is stopped, and the next job gets a fresh worker", async () => {
  const pool = new WorkerPool(script, { ...opts, timeoutMs: 200 });
  await assert.rejects(pool.run({ kind: "hang" }), /too slow/);
  const b = await pool.run({ kind: "ok" });
  assert.equal(b.calls, 1);
  pool.dispose();
});

test("an idle worker ends after the idle time", async () => {
  const pool = new WorkerPool(script, { ...opts, idleMs: 100 });
  await pool.run({ kind: "ok" });
  assert.equal(pool.alive, 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(pool.alive, 0);
  pool.dispose();
});

test("no jobs after dispose", async () => {
  const pool = new WorkerPool(script, opts);
  pool.dispose();
  await assert.rejects(pool.run({ kind: "ok" }), /shutting down/);
});
