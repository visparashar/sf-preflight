// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAY_MS,
  dueForCheck,
  fetchLatestVersion,
  isNewer,
  noticeFor,
  plainVersion,
  readUpdateState,
} from "../src/core/updateCheck.js";
import { banner, installHint, startUpdateCheck, updateCheckEnabled } from "../src/updateNotice.js";

describe("versions", () => {
  it("compares release versions, and a release is newer than its pre-release", () => {
    expect(isNewer("0.12.0", "0.11.0")).toBe(true);
    expect(isNewer("0.11.10", "0.11.9")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.11.0", "0.11.0")).toBe(false);
    expect(isNewer("0.10.9", "0.11.0")).toBe(false);
    expect(isNewer("0.12.0", "0.12.0-rc.1")).toBe(true);
    expect(isNewer("0.12.0-rc.1", "0.11.0")).toBe(false);
  });

  it("accepts only a plain version from the network", () => {
    expect(plainVersion(" 1.2.3 ")).toBe("1.2.3");
    for (const bad of ["1.2", "1.2.3-beta", "\x1b[31m9.9.9", "9.9.9\nrm -rf", 7, null, undefined])
      expect(plainVersion(bad)).toBeUndefined();
  });
});

describe("fetching the latest version", () => {
  const reply = (ok: boolean, body: unknown) => async () => ({ ok, json: async () => body });
  it("reads `version`, and gives up quietly on errors, bad data and slow answers", async () => {
    expect(await fetchLatestVersion("u", 1000, reply(true, { version: "0.12.0" }))).toBe("0.12.0");
    expect(await fetchLatestVersion("u", 1000, reply(false, { version: "0.12.0" }))).toBeUndefined();
    expect(await fetchLatestVersion("u", 1000, reply(true, { version: "<script>" }))).toBeUndefined();
    expect(await fetchLatestVersion("u", 1000, reply(true, null))).toBeUndefined();
    expect(
      await fetchLatestVersion("u", 1000, async () => {
        throw new Error("offline");
      }),
    ).toBeUndefined();
    const slow = (_u: string, init: { signal: AbortSignal }) =>
      new Promise<never>((_r, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    expect(await fetchLatestVersion("u", 50, slow)).toBeUndefined();
  });
});

describe("when to check and when to tell", () => {
  const now = 10 * DAY_MS;
  it("checks at most once a day", () => {
    expect(dueForCheck({}, now)).toBe(true);
    expect(dueForCheck({ checkedAt: now - DAY_MS + 1 }, now)).toBe(false);
    expect(dueForCheck({ checkedAt: now - DAY_MS }, now)).toBe(true);
    expect(dueForCheck({ checkedAt: now + 5000 }, now)).toBe(true); // clock went back
  });
  it("tells about a newer version at most once a day", () => {
    expect(noticeFor({ latest: "0.12.0" }, "0.11.0", now)).toBe("0.12.0");
    expect(noticeFor({ latest: "0.11.0" }, "0.11.0", now)).toBeUndefined();
    expect(noticeFor({ latest: "0.12.0", notifiedAt: now - 1000 }, "0.11.0", now)).toBeUndefined();
    expect(noticeFor({ latest: "0.12.0", notifiedAt: now - DAY_MS }, "0.11.0", now)).toBe("0.12.0");
  });
});

describe("the command line's banner", () => {
  it("is only for a person at a terminal", () => {
    const tty = { env: {}, isTTY: true };
    expect(updateCheckEnabled("analyze", tty)).toBe(true);
    expect(updateCheckEnabled("analyze", { env: {}, isTTY: false })).toBe(false);
    for (const cmd of ["mcp", "agent-hook", "hook", "notify", "monitor"])
      expect(updateCheckEnabled(cmd, tty)).toBe(false);
    for (const env of [{ CI: "true" }, { PREFLIGHT_NO_UPDATE_CHECK: "1" }, { NO_UPDATE_NOTIFIER: "1" }])
      expect(updateCheckEnabled("analyze", { env, isTTY: true })).toBe(false);
    expect(updateCheckEnabled("analyze", { env: { CI: "false" }, isTTY: true })).toBe(true);
  });

  it("suggests the update command for how it was started", () => {
    expect(installHint("/home/u/.npm/_npx/abc/node_modules/sf-preflight/dist/cli.js", "/work")).toBe(
      "npx sf-preflight@latest",
    );
    expect(installHint("/work/node_modules/sf-preflight/dist/cli.js", "/work")).toBe(
      "npm install --save-dev sf-preflight@latest",
    );
    expect(installHint("/usr/lib/node_modules/sf-preflight/dist/cli.js", "/work")).toBe(
      "npm install -g sf-preflight@latest",
    );
  });

  it("is a box, colored unless asked not to", () => {
    const plain = banner("0.12.0", "0.11.0", "npm install -g sf-preflight@latest", false);
    const lines = plain.split("\n");
    expect(lines[1]).toContain("sf-preflight 0.12.0 is available (you have 0.11.0)");
    expect(new Set(lines.map((l) => [...l].length)).size).toBe(1); // every line the same width
    expect(plain).not.toContain("\x1b[");
    expect(banner("0.12.0", "0.11.0", "x", true)).toContain("\x1b[33m");
  });

  describe("state on disk", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "preflight-update-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("asks the registry once a day, in the background, and records when it did", () => {
      const file = path.join(dir, "update-check.json");
      const asked: string[] = [];
      const run = () =>
        startUpdateCheck({
          command: "analyze",
          version: "0.11.0",
          scriptPath: "/x/cli.js",
          env: {},
          isTTY: true,
          file,
          refresh: (f) => asked.push(f),
        });
      run();
      run();
      expect(asked).toEqual([file]);
      expect(readUpdateState(file).checkedAt).toBeGreaterThan(Date.now() - 5000);
    });

    it("ignores a state file with bad data", () => {
      const file = path.join(dir, "update-check.json");
      writeFileSync(file, JSON.stringify({ checkedAt: "soon", latest: "9.9.9\u001b[2J" }));
      expect(readUpdateState(file)).toEqual({ checkedAt: undefined, latest: undefined, notifiedAt: undefined });
      writeFileSync(file, "{not json");
      expect(readUpdateState(file)).toEqual({});
      expect(readFileSync(file, "utf8")).toBe("{not json");
    });
  });
});
