// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * "A newer version is available" for the command line and the editor extension.
 *
 * At most once a day, a plain GET of the public "latest version" document (npm for the command
 * line, Open VSX for the extension). Nothing about the user, the project or the run is sent. The
 * answer is used only if it is a plain `x.y.z` version, so nothing from the network reaches the
 * terminal unchecked. Any failure (offline, proxy, slow registry) is silent.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const NPM_LATEST_URL = "https://registry.npmjs.org/sf-preflight/latest";
export const OPEN_VSX_URL = "https://open-vsx.org/api/visparashar/sf-preflight-vscode";
export const RELEASES_URL = "https://github.com/visparashar/sf-preflight/releases";

const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** A plain release version (`1.2.3`), or undefined. Pre-releases and anything else are ignored. */
export function plainVersion(v: unknown): string | undefined {
  return typeof v === "string" && VERSION.test(v.trim()) ? v.trim() : undefined;
}

/** Is `latest` a newer release than `current`? (`current` may be a pre-release: `0.12.0-rc.1` < `0.12.0`.) */
export function isNewer(latest: string, current: string): boolean {
  const l = VERSION.exec(latest);
  const c = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(current.trim());
  if (!l || !c) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(l[i]) - Number(c[i]);
    if (d !== 0) return d > 0;
  }
  return c[4] !== undefined; // same numbers: newer only than a pre-release
}

type Fetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

/** The `version` field of a JSON document, or undefined on any failure or after `timeoutMs`. */
export async function fetchLatestVersion(
  url: string,
  timeoutMs = 3000,
  fetchImpl: Fetch = globalThis.fetch as unknown as Fetch,
): Promise<string | undefined> {
  if (typeof fetchImpl !== "function") return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown } | null;
    return plainVersion(body?.version);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export interface UpdateState {
  /** When the registry was last asked. */
  checkedAt?: number;
  /** What it said. */
  latest?: string;
  /** When the notice was last shown (it is shown at most once a day). */
  notifiedAt?: number;
}

export function readUpdateState(file: string): UpdateState {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as UpdateState;
    return {
      checkedAt: typeof raw.checkedAt === "number" ? raw.checkedAt : undefined,
      latest: plainVersion(raw.latest),
      notifiedAt: typeof raw.notifiedAt === "number" ? raw.notifiedAt : undefined,
    };
  } catch {
    return {};
  }
}

export function writeUpdateState(file: string, state: UpdateState): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // a notice not remembered is not worth an error
  }
}

/** Whether to ask the registry now. */
export const dueForCheck = (state: UpdateState, now: number) =>
  state.checkedAt === undefined || now - state.checkedAt >= DAY_MS || now < state.checkedAt;

/** The version to tell the user about now, if any. */
export function noticeFor(state: UpdateState, current: string, now: number): string | undefined {
  if (!state.latest || !isNewer(state.latest, current)) return undefined;
  if (state.notifiedAt !== undefined && now - state.notifiedAt < DAY_MS && now >= state.notifiedAt) return undefined;
  return state.latest;
}
