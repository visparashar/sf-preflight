// SPDX-License-Identifier: Apache-2.0
/**
 * Run detached by the command line (see updateNotice.ts) so the command never waits on the network:
 * asks npm for the latest version and records it for the next run. Takes the state file's path.
 */
import { fetchLatestVersion, NPM_LATEST_URL, readUpdateState, writeUpdateState } from "./core/updateCheck.js";

const file = process.argv[2];
if (file) {
  const latest = await fetchLatestVersion(NPM_LATEST_URL, 10_000);
  if (latest) writeUpdateState(file, { ...readUpdateState(file), latest });
}
