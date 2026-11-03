import { basename, resolve } from "node:path";
import { PLAIN_SOURCE_FILE_EXTENSION, withParseCache } from "../plain/parser.ts";
import { createJobRegistry } from "./jobs.ts";
import { createWorkLoop, functionalityCompletion, type DriftReport, type WorkLoop } from "./loop.ts";
import { projectPlainFiles } from "./requires.ts";

/**
 * How each module of a project stands, in one call: what `WorkLoop.drift` and `functionalityCompletion` say of it, each
 * as they say it alone. One look at the whole project: each file parsed once, each record read once, the modules below
 * shared by every chain they are in - where asking module by module parses and reads the chain below each again.
 */
export interface ModuleStanding {
  /** The module's .plain file. */
  plainFile: string;
  module: string;
  /** `drift(plainFile)`: what is left to regenerate in every codebase of its chain - undefined when drift could not say (`driftError`). */
  drift?: DriftReport[];
  driftError?: string;
  /** `functionalityCompletion(plainFile)`: its chain's functional specs completed, one entry per chain - undefined with `completionError`. */
  completion?: ReturnType<typeof functionalityCompletion>;
  completionError?: string;
}

export interface StandingOptions {
  /**
   * The work loop whose drift is read - the session's, which knows its running pulses and halts. Without one, a loop of
   * its own that starts nothing, as the codebases' records have them.
   */
  loop?: WorkLoop;
  /** The .plain files to look at. Without them, every .plain file in the project's folder. */
  files?: string[];
}

/** Every module of a project, how it stands - see `ModuleStanding`. */
export function projectStanding(projectDir: string, options: StandingOptions = {}): ModuleStanding[] {
  const root = resolve(projectDir);
  const files = (options.files ?? projectPlainFiles(root)).map((file) => resolve(root, file));
  const loop = options.loop ?? createWorkLoop({ registry: createJobRegistry(), cwd: root, dryRun: true });
  return withParseCache(() =>
    files.map((plainFile): ModuleStanding => {
      const standing: ModuleStanding = { plainFile, module: basename(plainFile, PLAIN_SOURCE_FILE_EXTENSION) };
      try {
        standing.drift = loop.drift(plainFile);
      } catch (error) {
        standing.driftError = messageOf(error);
      }
      try {
        standing.completion = functionalityCompletion(plainFile);
      } catch (error) {
        standing.completionError = messageOf(error);
      }
      return standing;
    }),
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
