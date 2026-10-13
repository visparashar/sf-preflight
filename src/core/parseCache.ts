// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseApexUnit } from "./apexUnit.js";
import { parseInParallel } from "./parallelParse.js";
import { analyzeApex, parseApexClass, parseApexTrigger, stripApex } from "./parsers/apex.js";
import { ANALYZER_FINGERPRINT } from "./parsers/apexAst.js";

/**
 * On-disk cache of Apex parse results. Parsing every class dominates the time on a large
 * project (about 28 s for 1,000 classes), and between runs almost no file has changed.
 *
 * Entries are keyed by the file's path and the SHA-256 of its source. Each entry also records the
 * file's size and modification time: when both still match, the file is not read or hashed at all,
 * which is most of the remaining cost of a run where nothing changed. The whole cache is
 * dropped when the analyzer's code changes (a fingerprint of its source, plus a manual
 * version) or the project's set of objects changes (Apex analysis uses that set to tell
 * SObjects from other types). It holds analysis facts such as method names and field
 * references, never the source itself. It is local to the user, written with owner-only
 * permissions, and any problem reading or writing it only means a normal, slower run.
 */

const CACHE_VERSION = 2;
const MAX_BYTES = 200 * 1024 * 1024;
/** A project's caches for other analyzer builds are removed once unused this long. */
const STALE_MS = 14 * 24 * 60 * 60 * 1000;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const FINGERPRINT = sha(
  [ANALYZER_FINGERPRINT, parseApexUnit, analyzeApex, parseApexClass, parseApexTrigger, stripApex]
    .map(String)
    .join("\u0000"),
);

interface Entry {
  /** SHA-256 of the file's source. */
  h: string;
  /** Size and modification time when the hash was last confirmed (this project's copy only). */
  s?: string;
  /** Analysis result, without `stripped`, `name` and `file` (cheap to rebuild, or known). */
  d: unknown;
}

interface CacheFile {
  v: number;
  fp: string;
  objects: string;
  entries: Record<string, Entry>;
}

/** Where caches live: `PREFLIGHT_CACHE_DIR`, else the user's cache directory. */
export function cacheDir(): string {
  const env = process.env.PREFLIGHT_CACHE_DIR;
  if (env) return env;
  const base = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(base, "sf-preflight");
}

/**
 * Some file systems keep modification times to the second, so a same-size edit made in the same
 * second as the last look would go unseen. As git does, a file modified this recently is checked by
 * its content instead.
 */
const RACY_MS = 2000;

/** A file's size and modification time, or undefined when it can't be read or was modified just now. */
export function statSignature(abs: string, now = Date.now()): string | undefined {
  try {
    const st = statSync(abs);
    if (!st.isFile() || now - st.mtimeMs < RACY_MS) return undefined;
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** The cache file's identity: each save writes a new file and renames it, so the inode changes too. */
function cacheFileSignature(abs: string): string | undefined {
  try {
    const st = statSync(abs);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** Where a file's source comes from: read on demand, plus its size and time when it is on disk. */
export interface SourceOf {
  /** Size and modification time; undefined for unsaved text or an unreadable file. */
  sig?: string;
  read: () => string;
}

/**
 * Entries already read from a cache file, kept for the life of the process: a long-running host
 * (the editor's worker) analyzes again on every pause in typing, and re-reading a large cache file
 * each time costs more than the analysis. Reused only while the file on disk is unchanged.
 */
const loaded = new Map<string, { sig: string; fp: string; objects: string; entries: Map<string, Entry> }>();

export class ParseCache {
  private entries = new Map<string, Entry>();
  private readonly used = new Set<string>();
  /** Results parsed ahead of time on worker threads, waiting for their `get`. */
  private readonly ahead = new Map<string, Entry>();
  private dirty = false;
  private readonly file: string;
  private readonly prefix: string;
  /**
   * Size and time are trusted only for the project's own files. A copy sharing the cache (the
   * project at the base ref) has different times; it is checked by hash, and leaves them alone.
   */
  private readonly own: boolean;
  readonly objectsHash: string;
  /** The last hash computed per file, so prefill and get don't hash the same source twice. */
  private readonly hashed = new Map<string, { source: string; h: string }>();
  hits = 0;
  misses = 0;

  private hashOf(file: string, source: string): string {
    const m = this.hashed.get(file);
    if (m && m.source === source) return m.h;
    const h = sha(source);
    this.hashed.set(file, { source, h });
    return h;
  }

  /** `enabled: false` (or PREFLIGHT_NO_CACHE=1) makes every lookup a miss and writes nothing. */
  constructor(
    projectDir: string,
    projectObjects: Iterable<string>,
    private readonly enabled = process.env.PREFLIGHT_NO_CACHE !== "1",
    own = true,
  ) {
    this.own = own;
    this.objectsHash = sha([...projectObjects].sort().join("\n"));
    // One file per analyzer build: the command line and the editor extension are built differently,
    // and sharing one file made each throw away the other's cache.
    this.prefix = sha(path.resolve(projectDir)).slice(0, 24);
    this.file = path.join(cacheDir(), `${this.prefix}-${FINGERPRINT.slice(0, 12)}.json`);
    if (!enabled) return;
    const sig = cacheFileSignature(this.file);
    const mem = sig ? loaded.get(this.file) : undefined;
    if (mem && mem.sig === sig && mem.fp === FINGERPRINT && mem.objects === this.objectsHash) {
      this.entries = mem.entries;
      return;
    }
    loaded.delete(this.file);
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<CacheFile>;
      if (
        raw.v === CACHE_VERSION &&
        raw.fp === FINGERPRINT &&
        raw.objects === this.objectsHash &&
        raw.entries &&
        typeof raw.entries === "object"
      ) {
        for (const [file, e] of Object.entries(raw.entries)) {
          if (e && typeof e.h === "string" && e.d && typeof e.d === "object") this.entries.set(file, e);
        }
        if (sig) loaded.set(this.file, { sig, fp: FINGERPRINT, objects: this.objectsHash, entries: this.entries });
      }
    } catch {
      // Missing, unreadable or corrupt: start empty.
    }
  }

  /** The entry still valid for this file without reading it (size and time unchanged). */
  private fresh(file: string, src: SourceOf): Entry | undefined {
    if (!this.enabled || !this.own || !src.sig) return undefined;
    const hit = this.entries.get(file);
    return hit && hit.s === src.sig ? hit : undefined;
  }

  /** The cached result for this file, or the result of `compute`, which is then remembered. */
  get<T extends object>(file: string, src: SourceOf, compute: (source: string) => T): T {
    if (!this.enabled) return compute(src.read());
    this.used.add(file);
    const quick = this.fresh(file, src);
    if (quick) {
      this.hits++;
      return structuredClone(quick.d) as T;
    }
    const source = src.read();
    const h = this.hashOf(file, source);
    const s = this.own ? src.sig : undefined;
    const hit = this.entries.get(file);
    if (hit && hit.h === h) {
      this.hits++;
      if (s && hit.s !== s) {
        hit.s = s;
        this.dirty = true;
      }
      return structuredClone(hit.d) as T;
    }
    const pre = this.ahead.get(file);
    this.ahead.delete(file);
    this.misses++;
    const value = pre && pre.h === h ? (pre.d as T) : compute(source);
    this.entries.set(file, { h, s, d: structuredClone(value) });
    this.dirty = true;
    return value;
  }

  /**
   * Parse the files that aren't cached yet on several threads, ahead of the `get` calls that
   * will use them. Does nothing for small sets or when threads are unavailable.
   */
  prefill(
    files: { file: string; kind: "class" | "trigger"; name: string; src: SourceOf }[],
    projectObjects: Set<string>,
  ): void {
    const jobs = [];
    for (const f of files) {
      if (this.fresh(f.file, f.src)) continue;
      let source: string;
      try {
        source = f.src.read();
      } catch {
        continue; // unreadable: the normal path reports it
      }
      const hit = this.enabled ? this.entries.get(f.file) : undefined;
      if (hit && hit.h === this.hashOf(f.file, source)) continue;
      jobs.push({ file: f.file, kind: f.kind, name: f.name, source });
    }
    const done = parseInParallel(jobs, projectObjects);
    for (const j of jobs) {
      const d = done.get(j.file);
      if (d) this.ahead.set(j.file, { h: this.hashOf(j.file, j.source), d });
    }
  }

  /** Write the cache if anything changed. Files no longer in the project are dropped. */
  save(): void {
    if (!this.enabled) return;
    for (const file of this.entries.keys()) {
      if (!this.used.has(file)) {
        this.entries.delete(file);
        this.dirty = true;
      }
    }
    if (!this.dirty) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      const body = JSON.stringify({
        v: CACHE_VERSION,
        fp: FINGERPRINT,
        objects: this.objectsHash,
        entries: Object.fromEntries(this.entries),
      } satisfies CacheFile);
      if (body.length > MAX_BYTES) return;
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, this.file);
      const sig = cacheFileSignature(this.file);
      if (sig) loaded.set(this.file, { sig, fp: FINGERPRINT, objects: this.objectsHash, entries: this.entries });
      this.dirty = false;
      this.pruneStale();
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        // nothing to clean up
      }
    }
  }

  /** Remove this project's caches for other analyzer builds (and the old unversioned name) once stale. */
  private pruneStale(): void {
    const dir = path.dirname(this.file);
    const now = Date.now();
    try {
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(this.prefix) || !name.endsWith(".json")) continue;
        const file = path.join(dir, name);
        if (file === this.file) continue;
        try {
          if (now - statSync(file).mtimeMs > STALE_MS) unlinkSync(file);
        } catch {
          // gone already, or not ours to remove
        }
      }
    } catch {
      // no directory listing: nothing to prune
    }
  }
}
