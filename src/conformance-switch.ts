import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { adoptLegacyConfig, CONFIG_FILE, CONFIG_KEYS, configForSpec, readConfigFile, readProjectConfig, stackConfigFileIn, stackForModule, stackOf, stacksOf } from "./config.ts";
import { withSetting, writeSetting } from "./config-edit.ts";

/**
 * Whether a project's functional specs are conformance tested: `conformance-tests:` in its config, a stack's own over the
 * project's, false when unset. Off, nothing of conformance testing runs - no conformance pulse, no conformance testing
 * script, the test advisor and the chat's conform and evaluate_tests off; the test plain files there are kept, and not
 * tested. The chat always knows it, and how they are turned on: the person asking for tests, or agreeing to the chat's
 * offer of them, turns them on - for this session and the next, written into the config.
 */

/** The chat's tools that run conformance testing: there while the tests are on. */
export const CONFORMANCE_TOOLS = ["conform", "evaluate_tests"];
/** The chat's tool that turns them on: there while they are off. */
export const TURN_ON_TOOL = "turn_on_conformance_tests";

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
      ? "They are on here (conformance-tests: true): functional specs with scenarios are conformance tested, and the test advisor checks new ones in the background."
      : [
          "They are off here (conformance-tests: false, or unset): no scenarios are written or tested, no conformance testing script, the test",
          "advisor is off, and conform and evaluate_tests are not among your tools. Test plain files already there are kept, and not tested.",
          `When the person asks for conformance tests, or testing scenarios, call ${TURN_ON_TOOL} - their asking is their yes - then`,
          "go on with what they asked: the test reqs, the conformance testing script, the scenarios.",
          "You may offer them yourself, once and in a line, never turning them on unasked: when a functional spec could go wrong",
          "silently, or the coding agent keeps failing at one - say what they would add, and ask. A yes, and you call the tool.",
          "Asked how they are turned on: by asking you, or /turri-config conformance-tests true.",
        ].join("\n"),
    "</conformance-tests>",
  ].join("\n");
}

/** turn_on_conformance_tests: the chat turns conformance testing on, the person having asked for it or agreed to it. */
export function turnOnConformanceTestsTool(options: { cwd: string; turnedOn: () => void }): ToolDefinition {
  return defineTool({
    name: TURN_ON_TOOL,
    label: "Turn on conformance tests",
    description:
      "Turn conformance tests on for this project - conformance-tests: true in its config, for this session and the next - " +
      "once the person asked for conformance tests or testing scenarios, or agreed when you offered them. conform and " +
      "evaluate_tests become your tools, the test advisor starts checking new functional specs, and the work loop writes " +
      "and runs the conformance tests of every functional spec with scenarios once its code is built. Never call it unasked.",
    promptSnippet: `${TURN_ON_TOOL}: turn conformance tests on, the person having asked for them or agreed`,
    parameters: Type.Object({
      plain_file: Type.Optional(Type.String({ description: "The module the tests are for: its stack's config is written when that names the key. Omitted: config.turri.yaml." })),
    }),
    async execute(_id, params) {
      const file = turnOnConformanceTests(options.cwd, params.plain_file !== undefined ? resolve(options.cwd, params.plain_file) : undefined);
      options.turnedOn();
      const text =
        `Conformance tests are on for this project now - conformance-tests: true, written in ${file}. Say so to the person in a line. ` +
        "conform and evaluate_tests are your tools from your next turn, and the test advisor checks new functional specs. Go on " +
        "with what they asked: the test reqs, the conformance testing script, the scenarios - in that order, only what is missing. " +
        "Functional specs with scenarios written already, their code built, are tested once the module is next regenerated: " +
        "call conform for them to have their tests written now.";
      return { content: [{ type: "text" as const, text }], details: { file } };
    },
  });
}
