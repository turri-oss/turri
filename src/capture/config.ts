import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_FILE, CONFIG_KEYS, configFileProblem, projectConfigFile, splitModelSpec } from "../config.ts";
import { quickStartForCapture } from "../init-config.ts";
import { currentValue, shownValue, withSetting } from "../config-edit.ts";
import { isProjectDir } from "../regenerate/paths.ts";

/**
 * The captured project's config. It starts as the config in use where the capture was started - the person's models,
 * thinking, reviews, limits and every other setting they chose - so the capture's own agents, its testing scripts and
 * every pulse after it run as they asked, never on a default they did not choose. What belongs to the original project
 * alone is left out - its module, its testing scripts, its base folder, its test folder - since the capture writes its
 * own. Then the capture's own settings over it: conformance tests on, the models given for it.
 */

/** The keys of a config in use that name the original project's own things: never carried into a capture. */
const ORIGINAL_ONLY = [CONFIG_KEYS.module, CONFIG_KEYS.testDir, CONFIG_KEYS.baseFolder, CONFIG_KEYS.unittestsScript, CONFIG_KEYS.conformanceTestsScript, CONFIG_KEYS.prepareEnvironmentScript];

/** The config file in use for a folder: the nearest folder upwards that is a project's, its config.turri.yaml - or none. */
export function configInUse(dir: string): string | undefined {
  for (let at = resolve(dir); ; at = dirname(at)) {
    if (isProjectDir(at)) {
      const file = join(at, projectConfigFile(at));
      return existsSync(file) ? file : undefined;
    }
    if (dirname(at) === at) return undefined;
  }
}

/** Why the config in use cannot be started from - it does not parse - or undefined. */
export function configInUseProblem(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  const problem = configFileProblem(file);
  return problem === undefined ? undefined : `${problem} (${file}). A capture starts from the config in use - its models among it - and this one does not parse: fix it - each key set once - then capture again.`;
}

/**
 * The text the captured project's config starts as: the config in use - config.turri.yaml, never another tool's
 * config.yaml - without what was the original project's own, conformance tests on, and the models given for the capture
 * where the config in use says otherwise.
 */
export async function startingConfig(source: string | undefined, given: { harnessModel?: string; codingModel?: string }): Promise<string> {
  const carried = source !== undefined && basename(source) === CONFIG_FILE && existsSync(source) ? readFileSync(source, "utf8") : "";
  let text = carried || await quickStartForCapture(splitModelSpec(given.harnessModel).model, splitModelSpec(given.codingModel).model);
  for (const key of ORIGINAL_ONLY) text = withSetting(text, key, undefined);
  text = withSetting(text, CONFIG_KEYS.conformanceTests, true);
  // A model given - the chat's own, or one named on the command line - is written where the config in use says another:
  // under models: when it names the role there, which wins over the key.
  const set = (role: "chat" | "coding", key: string, value: string | undefined) => {
    if (value === undefined) return;
    const target = currentValue(text, `models.${role}`) !== undefined ? `models.${role}` : key;
    // Naming the same model without a level keeps its configured thinking; an explicit level wins.
    const current = shownValue(currentValue(text, target));
    const spec = splitModelSpec(value);
    if (current === value || (spec.thinking === undefined && splitModelSpec(current).model === spec.model)) return;
    text = withSetting(text, target, value);
  };
  set("chat", CONFIG_KEYS.harnessModel, given.harnessModel);
  set("coding", CONFIG_KEYS.codingModel, given.codingModel);
  const header = [
    "# Written by turri capture.",
    ...(carried !== "" ? [`# It started as the config in use where the capture was started - ${source} - without what was that project's own:`, "# its module, testing scripts, base folder and test folder."] : []),
    "# Every key is in turri's docs/config.md.",
  ];
  return `${header.join("\n")}\n${text.replace(/^\s*\n/, "")}`;
}
