// SPDX-License-Identifier: Apache-2.0
/**
 * Runs sf-preflight in a worker thread, so a large project never blocks the editor. The worker
 * stays up between requests (`{ id, req }` in, `{ id, ok, value | error }` out), so what it has
 * already loaded, such as the parse cache, is reused on the next pause in typing.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";
import {
  analyzeChange,
  generateTests,
  insightFor,
  loadProject,
  saveProcedure,
  testsToMarkdown,
  toMarkdown,
} from "../../src/core/index.js";
import type { SaveEvent } from "../../src/core/types.js";

export type WorkerRequest =
  | { kind: "analyze"; projectDir: string; base: string; depth: number; overlay?: Record<string, string> }
  | { kind: "insight"; projectDir: string; file: string; overlay?: Record<string, string> }
  | { kind: "tests"; projectDir: string; base: string; depth: number; outDir: string }
  | { kind: "explain"; projectDir: string; object: string; event: SaveEvent }
  | { kind: "objects"; projectDir: string };

/**
 * Refuse to write through a symbolic link (a committed link named preflight-tests, or one of the
 * generated files) to somewhere outside the project.
 */
function assertInside(project: string, target: string): void {
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`${target} is a symbolic link; refusing to overwrite it.`);
  }
  let dir = path.dirname(target);
  while (!existsSync(dir)) dir = path.dirname(dir);
  const rel = path.relative(project, realpathSync(dir));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${target} leads outside the project; refusing to write it.`);
  }
}

function handle(req: WorkerRequest): unknown {
  switch (req.kind) {
    case "analyze": {
      const { result, policy } = analyzeChange({
        projectDir: req.projectDir,
        base: req.base,
        maxDepth: req.depth,
        overlay: req.overlay,
      });
      // The gate's threshold from .preflight.json, for the dashboard's gate check.
      return { result, markdown: toMarkdown(result), failOn: policy.gate?.failOn ?? "high" };
    }
    case "tests": {
      const { model, result } = analyzeChange({ projectDir: req.projectDir, base: req.base, maxDepth: req.depth });
      const gen = generateTests(model, result);
      const written: string[] = [];
      const project = realpathSync(req.projectDir);
      for (const f of gen.files) {
        const target = path.join(req.outDir, f.path);
        assertInside(project, target);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, f.content);
        written.push(target);
      }
      return { written, markdown: testsToMarkdown(gen) };
    }
    case "explain": {
      const model = loadProject(req.projectDir);
      return { procedure: saveProcedure(model, req.object, req.event) };
    }
    case "insight": {
      const overlay = new Map(
        Object.entries(req.overlay ?? {}).map(([f, t]) => [
          path.relative(req.projectDir, f).split(path.sep).join("/"),
          t,
        ]),
      );
      const model = loadProject(req.projectDir, { overlay });
      const rel = path.relative(req.projectDir, req.file).split(path.sep).join("/");
      return insightFor(model, rel);
    }
    case "objects": {
      const model = loadProject(req.projectDir);
      return { objects: [...model.objects.values()].map((o) => o.name).sort() };
    }
  }
}

export interface WorkerReply {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

parentPort?.on("message", ({ id, req }: { id: number; req: WorkerRequest }) => {
  let reply: WorkerReply;
  try {
    reply = { id, ok: true, value: handle(req) };
  } catch (err) {
    reply = { id, ok: false, error: (err as Error).message };
  }
  parentPort?.postMessage(reply);
});
