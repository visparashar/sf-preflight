// SPDX-License-Identifier: Apache-2.0
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statSignature } from "../src/core/parseCache.js";
import { loadProject } from "../src/core/project.js";

let work: string;
let cacheRoot: string;
let project: string;
const saved = process.env.PREFLIGHT_CACHE_DIR;

function classesDir(): string {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith(".cls")) found.push(d);
    }
  };
  walk(project);
  return found[0] as string;
}

const snapshot = (m: ReturnType<typeof loadProject>) =>
  JSON.stringify({ classes: [...m.classes.entries()], triggers: [...m.triggers.entries()] });

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "preflight-cache-"));
  cacheRoot = path.join(work, "cache");
  project = path.join(work, "proj");
  cpSync(path.resolve("fixtures/sample-org"), project, { recursive: true });
  process.env.PREFLIGHT_CACHE_DIR = cacheRoot;
});

afterEach(() => {
  if (saved === undefined) delete process.env.PREFLIGHT_CACHE_DIR;
  else process.env.PREFLIGHT_CACHE_DIR = saved;
  rmSync(work, { recursive: true, force: true });
});

describe("parse cache", () => {
  it("gives the same model warm as cold,", () => {
    const cold = loadProject(project, { cache: true });
    const files = readdirSync(cacheRoot);
    expect(files).toHaveLength(1);
    const warm = loadProject(project, { cache: true });
    expect(snapshot(warm)).toBe(snapshot(cold));
    expect(snapshot(warm)).toBe(snapshot(loadProject(project, { cache: false })));
  });

  it("re-parses a file that changed and nothing else", () => {
    loadProject(project, { cache: true });
    const dir = classesDir();
    const file = readdirSync(dir).find((f) => f.endsWith(".cls")) as string;
    const target = path.join(dir, file);
    const name = file.replace(/\.cls$/, "");
    writeFileSync(
      target,
      `${readFileSync(target, "utf8")}\n// edit\npublic class ${name}Extra { public static void run(){ insert new Account(); } }\n`,
    );
    const after = loadProject(project, { cache: true });
    expect(snapshot(after)).toBe(snapshot(loadProject(project, { cache: false })));
  });

  it("drops entries for deleted files", () => {
    loadProject(project, { cache: true });
    const dir = classesDir();
    const file = readdirSync(dir).find((f) => f.endsWith(".cls")) as string;
    rmSync(path.join(dir, file));
    rmSync(path.join(dir, `${file}-meta.xml`), { force: true });
    loadProject(project, { cache: true });
    const body = readFileSync(path.join(cacheRoot, readdirSync(cacheRoot)[0] as string), "utf8");
    expect(body).not.toContain(file);
  });

  it("ignores a corrupt or foreign cache file", () => {
    loadProject(project, { cache: true });
    const f = path.join(cacheRoot, readdirSync(cacheRoot)[0] as string);
    writeFileSync(f, "{not json");
    expect(snapshot(loadProject(project, { cache: true }))).toBe(snapshot(loadProject(project, { cache: false })));
    writeFileSync(f, JSON.stringify({ v: 1, fp: "other", objects: "x", entries: { a: { h: "1", d: {} } } }));
    expect(snapshot(loadProject(project, { cache: true }))).toBe(snapshot(loadProject(project, { cache: false })));
  });

  it("starts over when the project's objects change", () => {
    loadProject(project, { cache: true });
    const f = path.join(cacheRoot, readdirSync(cacheRoot)[0] as string);
    const before = JSON.parse(readFileSync(f, "utf8")).objects;
    const obj = path.join(project, "force-app", "main", "default", "objects", "Brand_New__c");
    mkdirSync(obj, { recursive: true });
    writeFileSync(
      path.join(obj, "Brand_New__c.object-meta.xml"),
      '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"/>',
    );
    loadProject(project, { cache: true });
    expect(JSON.parse(readFileSync(f, "utf8")).objects).not.toBe(before);
  });

  it("writes nothing when disabled", () => {
    loadProject(project, { cache: false });
    expect(() => readdirSync(cacheRoot)).toThrow();
  });

  it("gives each class its stripped source, computed on first use", () => {
    const m = loadProject(project, { cache: true });
    const cls = [...m.classes.values()][0]!;
    const src = readFileSync(path.join(project, cls.file), "utf8");
    expect(cls.stripped.length).toBe(src.length);
    expect(cls.stripped).not.toMatch(/\/\/.*edited|'[^']+'/);
  });

  it("checks recently modified files by content, so a same-size edit is never missed", () => {
    const target = path.join(classesDir(), "SameSize.cls");
    const body = "public class SameSize { public static void run() { insert new Account(); } }\n";
    writeFileSync(target, body);
    expect(loadProject(project, { cache: true }).classes.get("samesize")?.writes[0]?.op).toBe("insert");
    // Same length, different code, written within the same second.
    const edited = body.replace("insert ", "delete ");
    expect(edited.length).toBe(body.length);
    writeFileSync(target, edited);
    expect(statSignature(target)).toBeUndefined();
    expect(loadProject(project, { cache: true }).classes.get("samesize")?.writes[0]?.op).toBe("delete");
  });

  it("trusts size and time for files untouched for a while", () => {
    const old = new Date(Date.now() - 60_000);
    const dir = classesDir();
    for (const f of readdirSync(dir)) utimesSync(path.join(dir, f), old, old);
    const first = loadProject(project, { cache: true });
    // A file whose content changes but whose size and time are put back is not read again: this is
    // the trade the cache makes (git makes the same one).
    const file = readdirSync(dir).find((f) => f.endsWith(".cls")) as string;
    const target = path.join(dir, file);
    const st = statSync(target);
    writeFileSync(target, "x".repeat(st.size));
    utimesSync(target, st.atime, st.mtime);
    const second = loadProject(project, { cache: true });
    const name = file.replace(/\.cls$/, "").toLowerCase();
    expect(JSON.stringify(second.classes.get(name)?.writes)).toBe(JSON.stringify(first.classes.get(name)?.writes));
    // Touch it and it is read again.
    utimesSync(target, old, new Date(Date.now() - 30_000));
    expect(loadProject(project, { cache: true }).classes.get(name)?.writes ?? []).toEqual([]);
  });

  it("keeps a separate file per analyzer build and removes a project's stale ones", () => {
    loadProject(project, { cache: true });
    const [current] = readdirSync(cacheRoot);
    const prefix = current!.split("-")[0]!;
    const stale = path.join(cacheRoot, `${prefix}-0123456789ab.json`);
    const recent = path.join(cacheRoot, `${prefix}-ba9876543210.json`);
    const other = path.join(cacheRoot, "ffffffffffffffffffffffff-0123456789ab.json");
    for (const f of [stale, recent, other]) writeFileSync(f, "{}");
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    utimesSync(other, old, old);
    // A change makes the cache save, which prunes.
    const dir = classesDir();
    const file = readdirSync(dir).find((f) => f.endsWith(".cls")) as string;
    writeFileSync(path.join(dir, file), `${readFileSync(path.join(dir, file), "utf8")}\n// edit\n`);
    loadProject(project, { cache: true });
    expect(readdirSync(cacheRoot).sort()).toEqual([current, path.basename(recent), path.basename(other)].sort());
  });
});
