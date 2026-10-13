// SPDX-License-Identifier: Apache-2.0
import { dueForCheck, noticeFor, type UpdateState } from "../../src/core/updateCheck.js";

/**
 * "A newer sf-preflight is available" in the editor. At most once a day the extension asks Open VSX
 * for the latest version (the same release goes to the Visual Studio Marketplace at the same time);
 * nothing about the user or the workspace is sent. When a newer one exists, a notification offers to
 * open the extension's page (where VS Code's Update button is), the release notes, or to skip that
 * version. Off with `sfPreflight.checkForUpdates`.
 */

export const UPDATE_STATE_KEY = "sfPreflight.updateCheck";

interface Stored extends UpdateState {
  /** A version the user chose to skip. */
  skipped?: string;
}

export interface UpdateDeps {
  current: string;
  now: number;
  state: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> };
  fetchLatest: () => Promise<string | undefined>;
  show: (message: string, ...items: string[]) => Thenable<string | undefined>;
  openExtension: () => void;
  openReleaseNotes: () => void;
}

export const UPDATE = "Update";
export const WHATS_NEW = "What's new";
export const SKIP = "Skip this version";

/** Check, and show the notification when due. Returns the version announced, if any. */
export async function checkForExtensionUpdate(d: UpdateDeps): Promise<string | undefined> {
  let stored: Stored = d.state.get<Stored>(UPDATE_STATE_KEY) ?? {};
  if (dueForCheck(stored, d.now)) {
    const latest = await d.fetchLatest();
    stored = { ...stored, checkedAt: d.now, ...(latest ? { latest } : {}) };
    await d.state.update(UPDATE_STATE_KEY, stored);
  }
  const latest = noticeFor(stored, d.current, d.now);
  if (!latest || stored.skipped === latest) return undefined;
  await d.state.update(UPDATE_STATE_KEY, { ...stored, notifiedAt: d.now });
  void Promise.resolve(
    d.show(`sf-preflight ${latest} is available (you have ${d.current}).`, UPDATE, WHATS_NEW, SKIP),
  ).then(async (choice) => {
    if (choice === UPDATE) d.openExtension();
    else if (choice === WHATS_NEW) d.openReleaseNotes();
    else if (choice === SKIP) await d.state.update(UPDATE_STATE_KEY, { ...stored, notifiedAt: d.now, skipped: latest });
  });
  return latest;
}
