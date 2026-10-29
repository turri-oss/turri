import { AsyncLocalStorage } from "node:async_hooks";
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import { currentChat } from "./chat-scope.ts";
import { projectDirOf } from "./regenerate/paths.ts";

/**
 * The project's `config.turri.yaml`, at its root - the folder that holds `plain_modules` - or, before it had one, its `config.yaml`.
 *
 * One file for what a project says about how it is built:
 *
 * ```yaml
 * module: prism_cli.plain                                   # what `turri regenerate` builds by default
 * test-dir: tests                                           # where the test plain files are, a folder per module: tests/<module>/ (default: tests)
 * base-folder: existing-app                                 # a codebase that requires none starts as a copy of it - code to build on, assets to use
 * harness-model:                                            # the model you chat with in `turri`
 *   model: anthropic/claude-opus-5-5
 *   thinking: high
 * coding-model:                                             # the rendering agents (default: harness-model)
 *   model: google/gemini-3.1-flash
 *   thinking: medium
 * judge-model:                                              # the judge and the test review (default: coding-model)
 *   model: google/gemini-3.1-pro
 * review: false                                             # review the code and its tests once they pass (default: true)
 * mutation-testing: false                                   # give the coding agent and the reviewer can_it_fail (default: true)
 * allow-to-stop-jobs: false                                 # stop a running job the spec moved on from (default: true)
 * release-after-pulse: true                                 # release what each pulse lands, as its last stage, before the next pulse (default: false)
 * test-advisor: false                                       # check each new or changed functional spec with no scenarios for whether it needs them - on a yes, the chat writes them (default: true)
 * sentinel: true                                            # a chat of its own every finished pulse goes to, which tests the release and tells you what is wrong: true, false, or ask - the person asked before it first opens in a session (default: ask)
 * rules-off: [integrations]                                 # ***plain rules to leave out of the prompts, by name (default: none)
 * unittests-script: test_scripts/run_unittests.sh           # the testing scripts - see test-scripts.ts
 * conformance-tests-script: test_scripts/run_conformance_tests.sh
 * prepare-environment-script: test_scripts/prepare_environment.sh  # optional: run before the conformance testing script - see test-scripts.ts
 * testing-scripts-run-on: in-place                         # what the testing scripts run on: in-place (default), or copy - see test-scripts.ts
 * turn-limit: 150                                           # seconds each turn of an agent a render starts has (default: 120; 0 for none)
 * models:                                                   # each agent role's own model, thinking and turn limit - see AGENT_ROLES
 *   default: amazon-bedrock/global.openai.gpt-6-luna         #   every role not named
 *   coding: { model: amazon-bedrock/eu.anthropic.claude-sonnet-5, thinking: high, turn-limit: 150 }
 *   explorer: google/gemini-3.1-flash-lite
 * ```
 *
 * `models:` names a model, a thinking level and a turn limit per agent role (AGENT_ROLES), each falling back as
 * roleModel says: a role it does not name takes `default`, and what an entry leaves out it takes from there too.
 * `harness-model`, `coding-model` and `judge-model` are the same as `models: chat`, `coding` and `judge`, which win
 * over them. The turn limit is the role's own, else `default`'s, else `turn-limit:`, else two minutes - the
 * config is the only place it is set.
 *
 * Each model is a model reference and a thinking level (off, minimal, low, medium, high, xhigh, max),
 * either of which may be left out; a bare string is the model alone. What a model leaves out it takes
 * from the one it inherits: judge-model from coding-model, coding-model from harness-model. They are
 * defaults: `--harness-model` / `--coding-model` / `--judge-model` on the command line win over them,
 * and so does a model chosen during the conversation (pi's /model, engine). `model:` is read
 * as `coding-model`, which it was before there were two.
 *
 * Keys are written with dashes; underscores are read the same (`conformance_tests`). Keys it
 * does not know - another tool's `config.yaml`, read while it is the old file, may carry several - are ignored, and so is a value of
 * the wrong type. Everything is optional, and what is given on the command line wins.
 *
 * A project whose parts do not share a stack - a Python backend and a React frontend beside each other - keeps a
 * stack's own settings in `config.turri.<stack>.yaml` beside `config.turri.yaml`: `config.turri.backend.yaml` for the
 * stack `backend` - its testing scripts, its toolchains. A stack is chosen, never worked out: `/stack` in the chat,
 * `--stack <name>` (or `TURRI_STACK`) on the command line. With one chosen, everything turri builds from then on is
 * built with `config.turri.yaml` and the stack's file over it, key by key - a model it names takes what it leaves out
 * from the project's - and a pulse already running keeps the stack it started with. With none, `config.turri.yaml`
 * alone. `module:` and `harness-model:` are the project's alone - there is one conversation - and are not read from a
 * stack's file.
 */

/** turri's settings for a project, in a file of its own: a `config.yaml` beside it may be another tool's. */
export const CONFIG_FILE = "config.turri.yaml";

/**
 * Where turri's settings were before they had a file of their own. A project with no `config.turri*.yaml` yet is read
 * from it - and a `config.<name>.yaml` beside it as the stack `<name>` - and turri never writes it: the first setting
 * turri writes copies them to the new names (`adoptLegacyConfig`), and from then on the old files are not read.
 */
export const LEGACY_CONFIG_FILE = "config.yaml";

/** A stack's config file's name: `config.turri.backend.yaml` for the stack `backend`. */
export function stackConfigFile(stack: string): string {
  return `config.turri.${stack}.yaml`;
}

function legacyStackConfigFile(stack: string): string {
  return `config.${stack}.yaml`;
}

function namesIn(root: string): string[] {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}

/** The stacks in the old naming, `config.<stack>.yaml`. */
function legacyStacks(root: string): string[] {
  return namesIn(root)
    .map((name) => /^config\.(?!turri(?:\.|$))(.+)\.yaml$/.exec(name)?.[1])
    .filter((name): name is string => name !== undefined)
    .sort();
}

/** Whether a folder's settings are still in the old files: a config.yaml or a config.<stack>.yaml, and no config.turri*.yaml. */
export function usesLegacyConfig(root: string): boolean {
  const names = namesIn(root);
  if (names.some((name) => /^config\.turri(?:\..+)?\.yaml$/.test(name))) return false;
  return names.includes(LEGACY_CONFIG_FILE) || legacyStacks(root).length > 0;
}

/** The file the project's settings are read from, by name: config.turri.yaml, or config.yaml while the folder has only the old files. */
export function projectConfigFile(root: string): string {
  return usesLegacyConfig(root) ? LEGACY_CONFIG_FILE : CONFIG_FILE;
}

/** The file a stack's settings are read from, by name - the old name while the folder has only the old files. */
export function stackConfigFileIn(root: string, stack: string): string {
  return usesLegacyConfig(root) ? legacyStackConfigFile(stack) : stackConfigFile(stack);
}

/** Whether a folder holds a project's settings: a config.turri.yaml, a stack's file, or the old files. */
export function hasProjectConfig(root: string): boolean {
  return existsSync(join(root, CONFIG_FILE)) || stacksOf(root).length > 0 || usesLegacyConfig(root);
}

/** The stacks a project folder has files for, by name. */
export function stacksOf(root: string): string[] {
  if (usesLegacyConfig(root)) return legacyStacks(root);
  return namesIn(root)
    .map((name) => /^config\.turri\.(.+)\.yaml$/.exec(name)?.[1])
    .filter((name): name is string => name !== undefined)
    .sort();
}

/**
 * Before turri first writes a setting in a folder whose settings are still in the old files: config.yaml copied to
 * config.turri.yaml, and each config.<stack>.yaml to config.turri.<stack>.yaml, so nothing is lost when the old files
 * stop being read. The old files are left as they are. Gives back the files written, by name.
 */
export function adoptLegacyConfig(root: string, options: { projectFile?: boolean } = {}): string[] {
  if (!usesLegacyConfig(root)) return [];
  const copies: Array<[string, string]> = [
    // `projectFile: false`: the stacks' files alone - turri init-config writes config.turri.yaml itself.
    ...(options.projectFile !== false && existsSync(join(root, LEGACY_CONFIG_FILE)) ? [[LEGACY_CONFIG_FILE, CONFIG_FILE] as [string, string]] : []),
    ...legacyStacks(root).map((stack) => [legacyStackConfigFile(stack), stackConfigFile(stack)] as [string, string]),
  ];
  for (const [from, to] of copies) copyFileSync(join(root, from), join(root, to));
  return copies.map(([, to]) => to);
}

/** The stack a pulse runs with: the one chosen as it started, whatever is chosen since. */
const pinnedStack = new AsyncLocalStorage<{ stack: string | undefined }>();

/**
 * The stack chosen now - the chat's own (`/stack` in it), else `--stack` or `TURRI_STACK` - or, inside a pulse, the one
 * it started with.
 */
export function chosenStack(): string | undefined {
  const pinned = pinnedStack.getStore();
  if (pinned !== undefined) return pinned.stack;
  const chat = currentChat();
  if (chat !== undefined) return chat.stack;
  return text(process.env.TURRI_STACK);
}

/**
 * Choose the stack everything is built with from now on - or none, the project's config alone. In a chat, for that
 * chat alone; outside one, kept in TURRI_STACK.
 */
export function chooseStack(stack: string | undefined): void {
  const chosen = stack === undefined || stack.trim() === "" ? undefined : stack.trim();
  const chat = currentChat();
  if (chat !== undefined) chat.stack = chosen;
  else if (chosen === undefined) delete process.env.TURRI_STACK;
  else process.env.TURRI_STACK = chosen;
}

/** Run `work` with `stack` as the one chosen, whatever is chosen meanwhile: a pulse keeps the stack it started with. */
export function withStack<T>(stack: string | undefined, work: () => T): T {
  return pinnedStack.run({ stack }, work);
}

/** Whether a stack is pinned here - named by the call that asked for the work, or kept by the pulse it runs in. */
export function stackPinned(): boolean {
  return pinnedStack.getStore() !== undefined;
}

/**
 * The stack a module is built with: the one pinned - named by the call, or kept by the pulse - else the stack named
 * after the module, config.turri.backend.yaml for backend.plain, else the one chosen for the session; none, when none
 * of them is.
 */
export function stackForModule(plainFile: string): string | undefined {
  const root = projectDirOf(resolve(plainFile));
  if (stackPinned()) return stackOf(root);
  const own = basename(plainFile).replace(/\.plain$/, "");
  return stacksOf(root).includes(own) ? own : stackOf(root);
}

/** The words that choose no stack: the project's config alone. */
export const NO_STACK = ["none", "off", "base", "-"];

/**
 * The stack `name` names for the project at `root` - undefined for none - refused when the project has no file for
 * it, with the stacks it has.
 */
export function stackNamed(root: string, name: string): string | undefined {
  const wanted = name.trim();
  if (wanted === "" || NO_STACK.includes(wanted.toLowerCase())) return undefined;
  const stacks = stacksOf(root);
  if (stacks.includes(wanted)) return wanted;
  throw new Error(
    stacks.length > 0
      ? `There is no stack ${wanted} in ${root}. Its stacks: ${stacks.join(", ")} - or none.`
      : `${root} has no stacks: a stack is a ${stackConfigFile("<stack>")} beside config.turri.yaml.`,
  );
}

/** The stack a project folder is built with now: the one chosen, when the folder has a file for it. */
export function stackOf(root: string): string | undefined {
  const stack = chosenStack();
  return stack !== undefined && stacksOf(root).includes(stack) ? stack : undefined;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** A model, and how hard it thinks - either may be left to the one it inherits from. */
export interface ModelChoice {
  /** "provider/model-id". */
  model?: string;
  thinking?: ThinkingLevel;
}

/**
 * The agents turri starts, by what they do - each can be given its own model, thinking and turn limit (`models:`).
 * The code fixer of a conformance run and the repair agent are coding agents; the unit-test and conformance arbiters
 * are both `arbiter`. The test advisor's calls - classifying a functional spec, its probes, its readers, its verifier -
 * are `advisor`.
 */
export const AGENT_ROLES = ["chat", "sentinel", "planner", "diagnosis", "release", "coding", "conformance", "explorer", "reviewer", "test-reviewer", "judge", "arbiter", "debugger", "advisor"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * How hard each role thinks when nothing names a level - not the config's `models:`, nor a `:level` on the model it is
 * given. The agents that do the work - write the code and the tests, explore, release - think little: they work from a
 * spec that leaves little to guess, and every turn of theirs is many. The ones that judge - review, weigh, plan, find a
 * cause - think more: a wrong call there costs pulses. The conversation keeps its own level, pi's.
 */
export const ROLE_THINKING: Partial<Record<AgentRole, ThinkingLevel>> = {
  coding: "low",
  conformance: "low",
  explorer: "low",
  release: "low",
  advisor: "low",
  reviewer: "medium",
  "test-reviewer": "medium",
  judge: "medium",
  arbiter: "medium",
  debugger: "medium",
  planner: "medium",
  diagnosis: "medium",
};

/** The roles on the conversation's side: without their own entry they take the chat's model, not `default`. */
// The release is not: it follows steps - a script, a start command - and runs on the coding model, thinking low. Nor
// is the diagnosis: a post-mortem of a job that failed, read by the person - it runs on the coding model, thinking medium.
const CHAT_SIDE: readonly AgentRole[] = ["chat", "sentinel", "planner"];

/** A role's model and thinking, and how long each of its turns may take, in seconds - each may be left out. */
export interface RoleChoice extends ModelChoice {
  turnLimit?: number;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * A model choice as the one string every agent is given, in pi's own form: "provider/id", with
 * ":level" when it names how hard to think - ":level" alone for the default model thinking so.
 */
export function modelSpec(choice: ModelChoice | undefined): string | undefined {
  if (choice === undefined || (choice.model === undefined && choice.thinking === undefined)) return undefined;
  return `${choice.model ?? ""}${choice.thinking !== undefined ? `:${choice.thinking}` : ""}`;
}

/** A model spec back into its model and thinking level - "provider/id:high", "provider/id", ":high". */
export function splitModelSpec(spec: string | undefined): ModelChoice {
  const given = spec?.trim() ?? "";
  if (given === "") return {};
  const colon = given.lastIndexOf(":");
  const level = colon === -1 ? undefined : given.slice(colon + 1);
  if (colon !== -1 && isThinkingLevel(level)) {
    const model = given.slice(0, colon);
    return { ...(model !== "" ? { model } : {}), thinking: level };
  }
  return { model: given };
}

/**
 * A model spec's model alone, its thinking left behind: what a judging role falls back on when it runs on the coding
 * model - the model, not how hard the coding agent was told to think. Its role's level (ROLE_THINKING) applies instead.
 */
export function modelOnly(spec: string | undefined): ModelChoice {
  const { model } = splitModelSpec(spec);
  return model !== undefined ? { model } : {};
}

/** A choice with what it leaves out taken from the one it inherits from - or that one, when it is not given at all. */
export function inheritModel(own: ModelChoice | undefined, from: ModelChoice | undefined): ModelChoice | undefined {
  if (own === undefined) return from;
  const model = own.model ?? from?.model;
  const thinking = own.thinking ?? from?.thinking;
  return { ...(model !== undefined ? { model } : {}), ...(thinking !== undefined ? { thinking } : {}) };
}

/**
 * The three models as they hold: the judge inherits from the coding model, the coding model from the harness model -
 * `models:` over them: `chat` over harness-model, `coding` over coding-model, `judge` over judge-model, and `default`
 * between the harness model and the rest.
 */
export function projectModels(config: Pick<ProjectConfig, "harnessModel" | "codingModel" | "judgeModel" | "models">): {
  harness?: ModelChoice;
  coding?: ModelChoice;
  judge?: ModelChoice;
} {
  const models = config.models ?? {};
  const harness = inheritModel(choiceOf(models.chat), config.harnessModel);
  const coding = inheritModel(choiceOf(models.coding), inheritModel(config.codingModel, inheritModel(choiceOf(models.default), harness)));
  // The judge falls back on the coding model, not on how hard it thinks: a judging role thinks as ROLE_THINKING has it.
  const codingModel = coding?.model !== undefined ? { model: coding.model } : undefined;
  return { harness, coding, judge: inheritModel(choiceOf(models.judge), inheritModel(config.judgeModel, inheritModel(choiceOf(models.default), codingModel))) };
}

/**
 * What a skill run from the command line runs on: the project's harness model, as a skill in the chat runs on the
 * chat's - or its coding model, for a skill that names it (`metadata.model: coding`) - undefined, and pi's default,
 * when the project names none.
 */
export function skillModel(root: string, role: "harness" | "coding" = "harness"): string | undefined {
  return modelSpec(projectModels(readProjectConfig(root, stackOf(root)))[role]);
}

/** A role entry's model and thinking alone. */
function choiceOf(entry: RoleChoice | undefined): ModelChoice | undefined {
  if (entry === undefined || (entry.model === undefined && entry.thinking === undefined)) return undefined;
  return { ...(entry.model !== undefined ? { model: entry.model } : {}), ...(entry.thinking !== undefined ? { thinking: entry.thinking } : {}) };
}

/**
 * What the config itself says a role runs on - its own entry, the legacy key that names it (judge-model for the judge
 * and the test review), then `default` (the chat's side: the chat's model instead) - or nothing when it says nothing
 * of it, and the role runs on what it is given: the job's model, which the command line and the conversation choose.
 * The coding role always runs on what it is given: its config is already in it (projectModels).
 */
export function roleModel(config: Pick<ProjectConfig, "harnessModel" | "judgeModel" | "models">, role: AgentRole): ModelChoice | undefined {
  if (role === "coding") return undefined;
  const models = config.models ?? {};
  const own = choiceOf(models[role]);
  // The debugger looks at the coding agent's failure: without its own entry it runs on the model it is given - a stronger one.
  if (role === "debugger") return own;
  if (CHAT_SIDE.includes(role)) return own === undefined ? undefined : inheritModel(own, inheritModel(choiceOf(models.chat), config.harnessModel));
  const legacy = role === "judge" || role === "test-reviewer" ? config.judgeModel : undefined;
  return inheritModel(own, inheritModel(legacy, choiceOf(models.default)));
}

/**
 * What the test advisor's calls run on: `models.advisor` - else `default` - and without either the coding
 * model alone, thinking as the role has it (ROLE_THINKING). Undefined when the config names no model at all.
 */
export function advisorModel(config: ProjectConfig): string | undefined {
  const coding = projectModels(config).coding?.model;
  return modelSpec(inheritModel(roleModel(config, "advisor"), coding !== undefined ? { model: coding } : undefined));
}

/** How long each turn of a role's agents may take, in milliseconds: its own, `default`'s, `turn-limit:`'s - or undefined, the harness's default. */
export function roleTurnLimitMs(config: Pick<ProjectConfig, "models" | "turnLimit">, role: AgentRole | undefined): number | undefined {
  const models = config.models ?? {};
  const seconds = (role !== undefined ? models[role]?.turnLimit : undefined) ?? models.default?.turnLimit ?? config.turnLimit;
  return seconds !== undefined ? seconds * 1000 : undefined;
}

/** A whole number of at least 1, as the config gives it - or nothing. */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** A model as the config gives it: a string, or `model:` and `thinking:`. */
function modelChoice(value: unknown): ModelChoice | undefined {
  if (typeof value === "string") return text(value) !== undefined ? splitModelSpec(value) : undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const model = text(raw.model) ?? text(raw.name) ?? text(raw.ref);
  const thinking = isThinkingLevel(raw.thinking) ? raw.thinking : undefined;
  if (model === undefined && thinking === undefined) return undefined;
  return { ...(model !== undefined ? { model } : {}), ...(thinking !== undefined ? { thinking } : {}) };
}

/** A role's entry under `models:`: a model string, or `model:`, `thinking:` and `turn-limit:`. */
function roleChoice(value: unknown): RoleChoice | undefined {
  const choice = modelChoice(value);
  const raw = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const turnLimit = turnLimitSetting(raw["turn-limit"] ?? raw.turn_limit);
  if (choice === undefined && turnLimit === undefined) return undefined;
  return { ...(choice ?? {}), ...(turnLimit !== undefined ? { turnLimit } : {}) };
}

/** A turn limit in seconds: a whole number, 0 for none. */
function turnLimitSetting(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/** `models:` - each role's entry, by its name; `default` for every role not named. */
function modelsSetting(value: unknown): ProjectConfig["models"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const models: NonNullable<ProjectConfig["models"]> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const name = key.replace(/_/g, "-");
    if (name !== "default" && !(AGENT_ROLES as readonly string[]).includes(name)) continue;
    const choice = roleChoice(entry);
    if (choice !== undefined) models[name as AgentRole | "default"] = choice;
  }
  return Object.keys(models).length > 0 ? models : undefined;
}

/** `sentinel:` - on, off, or `ask`: on once the person says so, asked before it first opens in a session. */
export type SentinelSetting = boolean | "ask";

export interface ProjectConfig {
  /** The .plain file the module command builds when it is given none. */
  module?: string;
  /** The model `turri` starts with: the one the person talks to. */
  harnessModel?: ModelChoice;
  /** The model the rendering agents run on - every render, conformance, repair and spec change. Unset: the harness model. */
  codingModel?: ModelChoice;
  /**
   * The model of the agents that give a verdict in a conformance run - the judge, which says whether
   * the code, the tests or the spec is wrong, and the test review. Unset: the coding model.
   */
  judgeModel?: ModelChoice;
  /**
   * Whether the code and its unit tests - and the conformance tests - are reviewed once they pass: two reviews at
   * most, the second weighed by the arbiter. false: the work goes on once its tests pass. Unset: false.
   */
  review?: boolean;
  /**
   * Whether the coding agent and the reviewer have can_it_fail: a bug put in the code for one run of the unit tests,
   * to see that a test catches it - on a copy, or in place and put back after. Unset: true.
   */
  mutationTesting?: boolean;
  /**
   * Whether turri stops a running job the spec has moved on from - a spec change, or a file it links edited - and
   * regenerates the spec as it now is instead. false: the job runs to its end and lands what it was regenerating, and
   * what changed since is regenerated on top of it by the next job: something lands as soon as it can, the software
   * evolving job by job. The person's own halt stops a job either way. Unset: true.
   */
  allowToStopJobs?: boolean;
  /**
   * Whether every pulse that lands code releases it as its last stage, before the module's next pulse starts - an agent
   * looking for the project's release guidance as the chat does, and doing what it says. Unset: false.
   */
  releaseAfterPulse?: boolean;
  /**
   * Whether the session has a sentinel: a chat of its own that every finished pulse goes to - checked, a release tested,
   * and what is wrong put to the person - instead of the chat that asked for it (docs/sentinel.md). `ask`: the person is
   * asked, before it first opens in a session, whether to start it. Unset: ask.
   */
  sentinel?: SentinelSetting;
  /**
   * Whether the test advisor starts by itself: in the chat and a host, each new or changed functional spec with no
   * scenarios is classified in the background, and on a yes the chat writes its scenarios (docs/test-advisor.md). false
   * turns off only that: the chat's evaluate_tests still works, and asked for scenarios, the chat writes them as before.
   * Unset: true.
   */
  testAdvisor?: boolean;
  /**
   * The folder of the test plain files, from the project's folder: a functional spec's scenarios are in its test plain
   * file in `<test-dir>/<module>/`. Unset: `tests`.
   */
  testDir?: string;
  /**
   * A folder, from the project's folder, that a codebase requiring no other module starts from - a copy of it, once,
   * before its first pulse: code to build on, files to use (src/regenerate/base-folder.ts). Unset: it starts empty.
   */
  baseFolder?: string;
  /** Path from the root to the unit testing script. */
  unittestsScript?: string;
  /** Path from the root to the conformance testing script. */
  conformanceTestsScript?: string;
  /** Run on the build before every conformance testing script run: `<script> <build folder>`. */
  prepareEnvironmentScript?: string;
  /**
   * What the testing scripts run on, on this machine: the code in place (the default) - as for an integration whose
   * scripts merge it into a host codebase - or a fresh copy of the code.
   */
  testingScriptsRunOn?: "copy" | "in-place";
  /** How many jobs run at once in the chat - modules that share nothing build side by side up to it. Unset: from the machine's memory. */
  parallelJobs?: number;
  /**
   * The ***plain authoring rules (genome/rules/<name>.md) left out of the conversation's prompt and every spec-writing
   * agent's, by name: a rule a project's own skills or AGENTS.md replace. The project's alone.
   */
  rulesOff?: string[];
  /**
   * Tokens of conversation - what an agent has done, past its instructions - after which an agent that keeps its
   * session through a job is compacted between turns. The project's alone. Unset: 100k.
   */
  compactAt?: number;
  /** The most functional specs the planner puts in one pulse. Unset: 3. A stack's file wins. */
  maxSpecsPerPulse?: number;
  /** The most lines of spec - its functional specs and the definitions they bring - in one pulse; past it, split. Unset: 120. */
  maxLinesPerPulse?: number;
  /**
   * What passes through to the agents' commands beside the scrubbed environment: every variable of the dotenv `files`
   * (paths from the project root), and the `vars` named, from the environment turri was started in. A module's own are
   * added to the project's.
   */
  agentEnv?: { files: string[]; vars: string[] };
  /**
   * Folders of this machine an agent's commands may read beside the system's and the toolchains turri finds itself: a
   * toolchain installed somewhere unusual. A module's own are added to the project's.
   */
  toolchains?: string[];
  /**
   * Megabytes of the ledger - what turri did, as facts, in .turri/ledger - the project keeps: past it, the oldest runs'
   * are pruned when a run first writes. 0 keeps none, and writes none. The project's alone. Unset: 100.
   */
  ledgerKeep?: number;
  /**
   * Whether turri keeps what it writes for a person debugging it: every agent's whole log and saved session, each
   * pulse's log, the testing scripts' and services' outputs, the agents' temporary files, and the dependencies installed
   * in the modules a chain has left behind. Off, only what turri reads to work is kept. The project's alone. Unset: false.
   */
  debug?: boolean;
  /**
   * Megabytes of package caches - plain_modules/.turri/cache, and the caches in the agents' home folders - the project
   * keeps: past it, the least recently written are removed when a run first starts an agent's command. 0 keeps none.
   * The project's alone. Unset: 4096.
   */
  cacheKeep?: number;
  /** Each agent role's own model, thinking and turn limit; `default` for every role not named. */
  models?: Partial<Record<AgentRole | "default", RoleChoice>>;
  /** Seconds each turn of an agent a render starts has, for every role without its own. Unset: 120. 0: none. */
  turnLimit?: number;
}

/** The config keys, as written in the file. */
export const CONFIG_KEYS = {
  module: "module",
  harnessModel: "harness-model",
  codingModel: "coding-model",
  judgeModel: "judge-model",
  review: "review",
  mutationTesting: "mutation-testing",
  allowToStopJobs: "allow-to-stop-jobs",
  releaseAfterPulse: "release-after-pulse",
  sentinel: "sentinel",
  testAdvisor: "test-advisor",
  testDir: "test-dir",
  baseFolder: "base-folder",
  unittestsScript: "unittests-script",
  conformanceTestsScript: "conformance-tests-script",
  prepareEnvironmentScript: "prepare-environment-script",
  testingScriptsRunOn: "testing-scripts-run-on",
  parallelJobs: "parallel-jobs",
  rulesOff: "rules-off",
  compactAt: "compact-at",
  maxSpecsPerPulse: "max-specs-per-pulse",
  maxLinesPerPulse: "max-lines-per-pulse",
  agentEnv: "agent-env",
  toolchains: "toolchains",
  ledgerKeep: "ledger-keep",
  debug: "debug",
  cacheKeep: "cache-keep",
  models: "models",
  turnLimit: "turn-limit",
} as const satisfies Record<keyof ProjectConfig, string>;

function whatScriptsRunOn(value: unknown): "copy" | "in-place" | undefined {
  return value === "copy" || value === "in-place" ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * The project's config - with a stack's over it, when one is named - or nothing of it when there is no file or it does
 * not parse.
 */
export function readProjectConfig(root: string, stack?: string): ProjectConfig {
  return withRunOverrides(readStackedConfig(root, stack));
}

function readStackedConfig(root: string, stack?: string): ProjectConfig {
  const project = readConfigFile(join(root, projectConfigFile(root)));
  if (stack === undefined) return project;
  const own = readConfigFile(join(root, stackConfigFileIn(root, stack)));
  // The project's alone: one conversation, one module built when none is named.
  const merged: ProjectConfig = { ...project };
  for (const key of Object.keys(CONFIG_KEYS) as Array<keyof ProjectConfig>) {
    if (key === "module" || key === "harnessModel" || key === "parallelJobs" || key === "rulesOff" || key === "compactAt" || key === "ledgerKeep" || key === "debug" || key === "cacheKeep" || key === "toolchains" || key === "agentEnv" || own[key] === undefined) continue;
    (merged as Record<string, unknown>)[key] = own[key];
  }
  merged.agentEnv = joinAgentEnv(project.agentEnv, own.agentEnv);
  merged.toolchains = project.toolchains !== undefined && own.toolchains !== undefined ? [...new Set([...project.toolchains, ...own.toolchains])] : (own.toolchains ?? project.toolchains);
  merged.codingModel = inheritModel(own.codingModel, project.codingModel);
  merged.judgeModel = inheritModel(own.judgeModel, project.judgeModel);
  merged.models = joinModels(project.models, own.models);
  return withoutUndefined(merged);
}

/**
 * What a command's own options say of the config's keys - `turri regenerate --harness-model`, `--coding-model`,
 * `--judge-model`, `--review`, `--mutation-testing` - read as if the file had them: each takes its key's value, and
 * every key keeps its place in the order, so a run is the same as one with them in config.turri.yaml - a `models:`
 * entry still winning over `harness-model`, `coding-model` or `judge-model`. A headless run needs no config file
 * edited. Never set in the conversation.
 */
type RunOverrides = Partial<Pick<ProjectConfig, "harnessModel" | "codingModel" | "judgeModel" | "review" | "mutationTesting">>;

let runOverrides: RunOverrides = {};

/** Megabytes of package caches a project keeps when `cache-keep:` does not say. */
export const DEFAULT_CACHE_KEEP_MB = 4096;

/**
 * Whether turri keeps what it writes for a person debugging it, in this project: TURRI_DEBUG - `--debug` sets it, and
 * `0` or `false` turns it off - else the project's `debug:`. Off by default.
 */
export function debugMode(project: string): boolean {
  const said = process.env.TURRI_DEBUG?.trim().toLowerCase();
  if (said !== undefined && said !== "") return said !== "0" && said !== "false";
  try {
    return readProjectConfig(project).debug === true;
  } catch {
    return false;
  }
}

/** Read a command's options as the config's keys for the rest of this process. */
export function overrideConfig(overrides: RunOverrides): void {
  runOverrides = { ...overrides };
}

/** `--review <value>`, `--mutation-testing <value>`: the config's own, true or false. Undefined for anything else. */
export function booleanOption(value: string): boolean | undefined {
  const word = value.trim().toLowerCase();
  return word === "true" ? true : word === "false" ? false : undefined;
}

/** The config with the command's options in place of the keys they name. */
function withRunOverrides(config: ProjectConfig): ProjectConfig {
  const given = Object.entries(runOverrides).filter(([, value]) => value !== undefined);
  return given.length === 0 ? config : { ...config, ...Object.fromEntries(given) };
}

/** A module's `models:` over the project's, role by role - each entry taking what it leaves out from the project's; the chat's the project's alone. */
function joinModels(project: ProjectConfig["models"], own: ProjectConfig["models"]): ProjectConfig["models"] {
  if (own === undefined) return project;
  const joined: NonNullable<ProjectConfig["models"]> = { ...(project ?? {}) };
  for (const [role, entry] of Object.entries(own) as Array<[AgentRole | "default", RoleChoice]>) {
    if (role === "chat") continue;
    const base = project?.[role];
    const choice = inheritModel(choiceOf(entry), choiceOf(base));
    const turnLimit = entry.turnLimit ?? base?.turnLimit;
    joined[role] = { ...(choice ?? {}), ...(turnLimit !== undefined ? { turnLimit } : {}) };
  }
  return joined;
}

/** A module's `agent-env:` added to the project's. */
function joinAgentEnv(project: ProjectConfig["agentEnv"], own: ProjectConfig["agentEnv"]): ProjectConfig["agentEnv"] {
  if (project === undefined || own === undefined) return own ?? project;
  return { files: [...new Set([...project.files, ...own.files])], vars: [...new Set([...project.vars, ...own.vars])] };
}

/** An `agent-env:` as the config gives it: dotenv files and variable names, or nothing when it names neither. */
function agentEnvSetting(value: unknown): ProjectConfig["agentEnv"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const list = (items: unknown) =>
    (Array.isArray(items) ? items : typeof items === "string" ? [items] : []).filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
  const raw = value as { files?: unknown; vars?: unknown };
  const setting = { files: list(raw.files), vars: list(raw.vars) };
  return setting.files.length > 0 || setting.vars.length > 0 ? setting : undefined;
}

function withoutUndefined(config: ProjectConfig): ProjectConfig {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)) as ProjectConfig;
}

/** Where the test plain files are when `test-dir:` does not say. */
export const DEFAULT_TEST_DIR = "tests";

/** The folder of a module's project's test plain files: `test-dir:` - its stack's over the project's - from the project's folder. */
export function testDirOf(plainFile: string): string {
  return resolve(projectDirOf(resolve(plainFile)), configForSpec(plainFile).testDir ?? DEFAULT_TEST_DIR);
}

/** The config a spec is built with: its project's, with its module's stack over it (`stackForModule`). */
export function configForSpec(plainFile: string): ProjectConfig {
  const root = projectDirOf(resolve(plainFile));
  return readProjectConfig(root, stackForModule(plainFile));
}

/** One config file, read, or nothing of it when it is not there or does not parse. */
function readConfigFile(path: string): ProjectConfig {
  let parsed: unknown;
  try {
    if (!statSync(path).isFile()) return {};
    parsed = loadYaml(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const raw = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key.replace(/_/g, "-"), value]));
  return {
    module: text(raw[CONFIG_KEYS.module]),
    harnessModel: modelChoice(raw[CONFIG_KEYS.harnessModel]),
    codingModel: modelChoice(raw[CONFIG_KEYS.codingModel]) ?? modelChoice(raw.model),
    judgeModel: modelChoice(raw[CONFIG_KEYS.judgeModel]),
    review: typeof raw[CONFIG_KEYS.review] === "boolean" ? (raw[CONFIG_KEYS.review] as boolean) : undefined,
    mutationTesting: typeof raw[CONFIG_KEYS.mutationTesting] === "boolean" ? (raw[CONFIG_KEYS.mutationTesting] as boolean) : undefined,
    allowToStopJobs: typeof raw[CONFIG_KEYS.allowToStopJobs] === "boolean" ? (raw[CONFIG_KEYS.allowToStopJobs] as boolean) : undefined,
    releaseAfterPulse: typeof raw[CONFIG_KEYS.releaseAfterPulse] === "boolean" ? (raw[CONFIG_KEYS.releaseAfterPulse] as boolean) : undefined,
    sentinel: typeof raw[CONFIG_KEYS.sentinel] === "boolean" || raw[CONFIG_KEYS.sentinel] === "ask" ? (raw[CONFIG_KEYS.sentinel] as SentinelSetting) : undefined,
    testAdvisor: typeof raw[CONFIG_KEYS.testAdvisor] === "boolean" ? (raw[CONFIG_KEYS.testAdvisor] as boolean) : undefined,
    testDir: text(raw[CONFIG_KEYS.testDir]),
    baseFolder: text(raw[CONFIG_KEYS.baseFolder]),
    unittestsScript: text(raw[CONFIG_KEYS.unittestsScript]),
    conformanceTestsScript: text(raw[CONFIG_KEYS.conformanceTestsScript]),
    prepareEnvironmentScript: text(raw[CONFIG_KEYS.prepareEnvironmentScript]),
    testingScriptsRunOn: whatScriptsRunOn(raw[CONFIG_KEYS.testingScriptsRunOn]),
    agentEnv: agentEnvSetting(raw[CONFIG_KEYS.agentEnv]),
    toolchains: Array.isArray(raw[CONFIG_KEYS.toolchains])
      ? (raw[CONFIG_KEYS.toolchains] as unknown[]).filter((path): path is string => typeof path === "string" && path.trim() !== "").map((path) => path.trim())
      : undefined,
    rulesOff: Array.isArray(raw[CONFIG_KEYS.rulesOff]) ? (raw[CONFIG_KEYS.rulesOff] as unknown[]).filter((name): name is string => typeof name === "string") : undefined,
    compactAt:
      typeof raw[CONFIG_KEYS.compactAt] === "number" && Number.isInteger(raw[CONFIG_KEYS.compactAt]) && (raw[CONFIG_KEYS.compactAt] as number) >= 1000
        ? (raw[CONFIG_KEYS.compactAt] as number)
        : undefined,
    parallelJobs:
      typeof raw[CONFIG_KEYS.parallelJobs] === "number" && Number.isInteger(raw[CONFIG_KEYS.parallelJobs]) && (raw[CONFIG_KEYS.parallelJobs] as number) >= 1
        ? (raw[CONFIG_KEYS.parallelJobs] as number)
        : undefined,
    maxSpecsPerPulse: positiveInteger(raw[CONFIG_KEYS.maxSpecsPerPulse]),
    maxLinesPerPulse: positiveInteger(raw[CONFIG_KEYS.maxLinesPerPulse]),
    ledgerKeep:
      typeof raw[CONFIG_KEYS.ledgerKeep] === "number" && Number.isInteger(raw[CONFIG_KEYS.ledgerKeep]) && (raw[CONFIG_KEYS.ledgerKeep] as number) >= 0
        ? (raw[CONFIG_KEYS.ledgerKeep] as number)
        : undefined,
    debug: typeof raw[CONFIG_KEYS.debug] === "boolean" ? (raw[CONFIG_KEYS.debug] as boolean) : undefined,
    cacheKeep:
      typeof raw[CONFIG_KEYS.cacheKeep] === "number" && Number.isInteger(raw[CONFIG_KEYS.cacheKeep]) && (raw[CONFIG_KEYS.cacheKeep] as number) >= 0
        ? (raw[CONFIG_KEYS.cacheKeep] as number)
        : undefined,
    models: modelsSetting(raw[CONFIG_KEYS.models]),
    turnLimit: turnLimitSetting(raw[CONFIG_KEYS.turnLimit]),
  };
}
