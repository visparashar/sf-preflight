// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Reading project files. An editor can pass the unsaved text of open files as an overlay
 * (project-relative path → content), so the analysis sees what is being typed, not what is on disk.
 */
export interface ProjectFiles {
  projectDir: string;
  overlay?: Map<string, string>;
}

/** A project file's content: the overlay's when there is one, else the file on disk. Throws when missing. */
export function readProjectFile(model: ProjectFiles, rel: string): string {
  return model.overlay?.get(rel) ?? readFileSync(path.join(model.projectDir, rel), "utf8");
}

/** Like readProjectFile, but undefined when the file can't be read. */
export function tryReadProjectFile(model: ProjectFiles, rel: string): string | undefined {
  try {
    return readProjectFile(model, rel);
  } catch {
    return undefined;
  }
}
