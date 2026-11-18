import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { adoptLegacyConfig, CONFIG_FILE, CONFIG_KEYS, configForSpec, readConfigFile, readProjectConfig, stackConfigFileIn, stackForModule, stackOf, stacksOf } from "./config.ts";
import { withSetting, writeSetting } from "./config-edit.ts";

/**
 * Whether a project's functional specs are conformance tested: `conformance-tests:` in its config, a stack's own over the
 * project's, false when unset. Conformance testing is a validation step that makes each change take about twice as long,
 * so it is off until the person turns it on - with /conform, or the setting - and they keep it off to iterate fast. Off,
 * nothing of conformance testing runs - no conformance pulse, no conformance testing script, the
 * chat's conform refused; the test plain files there are kept, and not tested. The chat never turns them on: it says why
 * it wants them, and the person decides.
 */

/** Why the chat's conform, or a skill that writes the conformance testing script, is refused while they are off. */
export const CONFORMANCE_OFF_REFUSAL =
  "Conformance tests are off for this project (conformance-tests: false, or unset), and turning them on is the person's " +
  "decision: they make each change take about twice as long, and the person keeps them off to iterate fast. Tell the " +
  "person, in a line or two, why you want conformance tests here; they decide, and turn them on with /conform - which " +
  "also starts them - or /turri-config conformance-tests true. Nothing was started.";

/** Whether a module's functional specs are conformance tested: its stack's `conformance-tests:` over the project's. */
export function conformanceTestsOn(plainFile: string): boolean {
  try {
    return configForSpec(resolve(plainFile)).conformanceTests === true;
  } catch {
    return false;
  }
}

/** Whether the project conformance tests anything: its own config, or a stack's - for the chat's tools, which are the project's. */
export function conformanceTestsOnIn(project: string): boolean {
  try {
    const stacks = [stackOf(project), ...stacksOf(project)].filter((stack): stack is string => stack !== undefined);
    return readProjectConfig(project).conformanceTests === true || stacks.some((stack) => readProjectConfig(project, stack).conformanceTests === true);
  } catch {
    return false;
  }
}

/**
 * Turn conformance testing on: `conformance-tests: true` written where the module's value comes from - its stack's file
 * when that names the key, else config.turri.yaml - and in effect at once. Says which file.
 */
export function turnOnConformanceTests(project: string, plainFile?: string): string {
  const stack = plainFile !== undefined ? stackForModule(resolve(plainFile)) : stackOf(project);
  if (stack !== undefined) {
    const file = join(project, stackConfigFileIn(project, stack));
    if (existsSync(file) && readConfigFile(file).conformanceTests !== undefined) {
      adoptLegacyConfig(project);
      const own = join(project, stackConfigFileIn(project, stack));
      writeFileSync(own, withSetting(readFileSync(own, "utf8"), CONFIG_KEYS.conformanceTests, true));
      return stackConfigFileIn(project, stack);
    }
  }
  writeSetting(project, CONFIG_KEYS.conformanceTests, true);
  return CONFIG_FILE;
}

/**
 * What the chat is told of conformance testing, every turn: what it is, whether it is on here, and - off - how it is
 * turned on, and that it may offer it.
 */
export function conformanceBlock(on: boolean): string {
  const what =
    "Conformance tests are black-box tests that start the built software and check it from outside, against the scenarios " +
    "of a functional spec's test plain file - written by turri's agents once the code is built, and run with the whole suite " +
    "each time more lands, so nothing that worked quietly breaks. Unit tests are always written with the code; conformance " +
    "tests are the project's choice: `conformance-tests:` in config.turri.yaml.";
  return [
    "<conformance-tests>",
    what,
    on
      ? [
          "They are on here (conformance-tests: true): functional specs with scenarios are conformance tested once their code is",
          "built. As you write or change a functional spec, judge whether it needs scenarios, as the rules on test plain files say,",
          "and write them when it does - in the same change, a visible ***plain change the person reviews like any other.",
          "Scenarios are tested only once their module has test reqs and the project a conformance testing script: when you",
          "write scenarios and one of those is missing, write it first, in that order - the test reqs, then the script with",
          "implement-conformance-testing-script - asking nothing: conformance tests on is the person's yes to them.",
        ].join("\n")
      : [
          "They are off here (conformance-tests: false, or unset). They make each change take about twice as long, so the person",
          "keeps them off to iterate fast, and turning them on is theirs alone. While off, no conformance tests are written or run,",
          "no conformance testing script either, and conform is refused. Test plain files already there are",
          "kept, and not tested. When you think conformance tests are worth it here - the person asks for tests, a functional spec",
          "could go wrong silently, or the coding agent keeps failing at one - tell them in a line or two why, and what it costs.",
          "They decide, and turn them on with /conform - which also tests what is built - or /turri-config conformance-tests true.",
        ].join("\n"),
    "</conformance-tests>",
  ].join("\n");
}
