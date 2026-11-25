import { BACKGROUND_NOTE } from "../background-skills.ts";
import { CONFIG_FILE, moduleConfigFile, withConfigModule } from "../config.ts";
import { PACKAGE_ROOT } from "../environment.ts";
import { runSkill } from "../genome.ts";
import type { Reporter } from "../graph.ts";
import { skillRunDir } from "../regenerate/paths.ts";
import { testingScriptSkill, type ScriptKind } from "../regenerate/test-scripts.ts";
import { discoverSkills } from "../skills.ts";
import type { Part } from "./state.ts";

/**
 * A captured project's testing scripts, written by turri's own skills - implement-unit-testing-script and
 * implement-conformance-testing-script - as the chat runs them in the background: nobody asked, a gate that cannot be
 * satisfied standing. Without them, a captured project could not be regenerated until someone asked for them; with
 * them, it can be at once.
 */

export interface ScriptRequest {
  /** The captured project. */
  plainDir: string;
  /** The codebase it was captured from. */
  root: string;
  /** The part's first module, by name: the one its script is for. */
  module: string;
  /** The module whose config file holds the part's scripts, when the project has several parts. */
  configModule?: string;
  part: Part;
  kind: ScriptKind;
  model?: string;
  signal?: AbortSignal;
}

/** Writes a testing script of a part, or throws why it could not. */
export type ScriptWriter = (request: ScriptRequest) => Promise<void>;

const QUIET: Reporter = { step: () => {}, artifact: () => {}, gate: () => {}, judge: () => {}, outcome: () => {} };

/** A part's testing script, written by turri's skill for it. */
export const writeTestingScript: ScriptWriter = async (request) => {
  const { skill: name } = testingScriptSkill(request.kind);
  const skill = discoverSkills(PACKAGE_ROOT, request.plainDir).skills.find((found) => found.name === name);
  if (skill === undefined) throw new Error(`turri has no skill ${name}`);
  const context = [
    `It is for ${request.module}.plain${request.configModule !== undefined ? `, built with ${moduleConfigFile(request.configModule)} over ${CONFIG_FILE}` : ""}.`,
    `This project was captured just now from the codebase at ${request.root}, which the code regenerated from its ***plain replaces. Its ***plain says what the code is built on${request.part.stdlibStack !== undefined ? ` - ${request.part.stdlibStack}` : ""}; the original's manifests in that folder show the tools it used, where the ***plain leaves one open.`,
    BACKGROUND_NOTE,
  ].join("\n\n");
  const result = await withConfigModule(request.configModule, () =>
    runSkill({
      skillDir: skill.dir,
      cwd: request.plainDir,
      runDir: skillRunDir(request.plainDir, skill.name),
      report: QUIET,
      context,
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      // Nobody is asked: a gate that cannot be satisfied stands.
      escalate: async () => false,
    }),
  );
  if (!result.ok) throw new Error("its skill stopped at a review gate, with no approved script");
};
