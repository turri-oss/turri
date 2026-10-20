import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { debugMode } from "../config.ts";
import { currentJob } from "./activity.ts";
import { modulesScratchDir } from "./paths.ts";

/**
 * What a pulse writes only for a person debugging turri, and when it goes.
 *
 * A pulse writes its own log, every one of its agents' whole logs, the testing scripts' and services' full outputs and
 * its agents' temporary files. Nothing of turri reads them once the pulse is over: while it runs, its agents read their
 * outputs (`read_output`, `service_logs`) and the diagnosis of a failure reads the logs - so they are written as before,
 * and removed as it ends. In debug mode (`debug: true`, TURRI_DEBUG, `--debug`) they are kept, as they always were.
 *
 * So are the dependencies installed in the modules below a pulse's own in its chain: the chain is built in its tip, and
 * what was installed in the codebases it left behind is only installed again - from the package cache - if one of them
 * is ever built on again. The testing scripts install what they run with themselves.
 */

/** The files each pulse wrote for a person to read, by its id. */
const written = new Map<string, Set<string>>();

/** A file the running pulse wrote for a person to read - removed as it ends, unless in debug mode. Outside a pulse, nothing. */
export function pulseWrote(file: string, job: string | undefined = currentJob()?.id): void {
  if (job === undefined) return;
  const files = written.get(job) ?? new Set<string>();
  files.add(file);
  written.set(job, files);
}

/** Where a codebase's dependencies are installed: what a module its chain has left behind keeps no longer. */
const INSTALLED = ["node_modules", ".venv", "venv"];

/**
 * A pulse has ended. Unless the project is in debug mode, what it wrote for a person goes - its files, and its module's
 * temporary folder - and so do the dependencies installed in the modules below its own in its chain. `lanes` are the
 * pulse's (`plain_modules/<module>` of its whole chain), still held: no other pulse works in them. Returns whether
 * everything was kept.
 */
export function pulseEnded(options: { job: string; project: string; module?: string; lanes: string[] }): boolean {
  const files = written.get(options.job) ?? new Set<string>();
  written.delete(options.job);
  if (debugMode(options.project)) return true;
  const gone = (path: string) => {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* what cannot be removed stays: never a reason for the pulse to fail */
    }
  };
  for (const file of files) gone(file);
  for (const lane of options.lanes) {
    // A codebase of the chain: its folder holds `code` - a lane may also be a spec file, or a build folder.
    if (!existsSync(join(lane, "code"))) continue;
    const name = basename(lane);
    if (name === options.module) gone(join(modulesScratchDir(lane), "tmp", name));
    else for (const installed of INSTALLED) gone(join(lane, "code", installed));
  }
  return false;
}
