import { AsyncLocalStorage } from "node:async_hooks";
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import { projectDirOf, resolveTemplateDirs } from "./regenerate/paths.ts";

/**
 * The project's `config.turri.yaml`, at its root - the folder that holds `plain_modules` - or, before it had one, its `config.yaml`.
 *
 * One file for what a project says about how it is built:
 *
 * ```yaml
 * module: prism_cli.plain                                   # what `turri regenerate` builds by default
 * conformance-tests: false                                  # whether scenarios are written and conformance tested - false: none (default: false)
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
 * launch-after-pulse: true                                  # launch what each pulse lands, in the background, the newest commit winning (default: false)
 * sentinel: true                                            # a chat of its own every finished pulse goes to, which tests what is launched and tells you what is wrong: true, false, or ask - the person asked before it first opens in a session (default: ask)
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
 * and so does a model chosen during the conversation (pi's /model) or named on a call. `model:` is read
 * as `coding-model`, which it was before there were two.
 *
 * Keys are written with dashes; underscores are read the same (`conformance_tests`). Keys it
 * does not know - another tool's `config.yaml`, read while it is the old file, may carry several - are ignored, and so is a value of
 * the wrong type. Everything is optional, and what is given on the command line wins.
 *
 * A module can have settings of its own in `config.turri.<module>.yaml` beside `config.turri.yaml`:
 * `config.turri.backend.yaml` for `backend.plain` - its testing scripts, its toolchains, its models - laid over
 * `config.turri.yaml` key by key, a model it names taking what it leaves out from the project's. A module with no file
 * of its own takes the one of a module it requires - `config.turri.backend.yaml` builds `backend_auth.plain`, which
 * requires `backend.plain` - and two among the modules it requires is an error (`configModuleFor`). Nobody chooses it:
 * it is worked out from the module, and a pulse keeps the one it started with. `module:`, `harness-model:` and the
 * other settings of the whole project are read from `config.turri.yaml` alone.
 */

/** turri's settings for a project, in a file of its own: a `config.yaml` beside it may be another tool's. */
export const CONFIG_FILE = "config.turri.yaml";

/**
 * Where turri's settings were before they had a file of their own. A project with no `config.turri*.yaml` yet is read
 * from it - and a `config.<name>.yaml` beside it as the module `<name>`'s - and turri never writes it: the first setting
 * turri writes copies them to the new names (`adoptLegacyConfig`), and from then on the old files are not read.
 */
export const LEGACY_CONFIG_FILE = "config.yaml";

/** A module's config file's name: `config.turri.backend.yaml` for `backend.plain`. */
export function moduleConfigFile(module: string): string {
  return `config.turri.${module}.yaml`;
}

function legacyModuleConfigFile(module: string): string {
  return `config.${module}.yaml`;
}

/**
 * The names in a folder - read again only once the folder itself has changed: a name added, removed or renamed in it
 * moves its modification time. Asked many times a look, for every module of every chain. A folder changed less than a
 * second before it was read is read again each time: a name added within the same tick of the file system's clock
 * would not move it (readConfigFile).
 */
function namesIn(root: string): string[] {
  try {
    const at = statSync(root).mtimeMs;
    const kept = keptNames.get(root);
    if (kept !== undefined && kept.at === at && at < kept.readAt - RACY_MS) return [...kept.names];
    const readAt = Date.now();
    const names = readdirSync(root);
    keptNames.set(root, { at, names, readAt });
    if (keptNames.size > 64) keptNames.delete(keptNames.keys().next().value!);
    return [...names];
  } catch {
    return [];
  }
}

const keptNames = new Map<string, { at: number; names: string[]; readAt: number }>();

/** The modules with a file of their own in the old naming, `config.<module>.yaml`. */
function legacyModuleConfigs(root: string): string[] {
  return namesIn(root)
    .map((name) => /^config\.(?!turri(?:\.|$))(.+)\.yaml$/.exec(name)?.[1])
    .filter((name): name is string => name !== undefined)
    .sort();
}

/** Whether a folder's settings are still in the old files: a config.yaml or a config.<module>.yaml, and no config.turri*.yaml. */
export function usesLegacyConfig(root: string): boolean {
  const names = namesIn(root);
  if (names.some((name) => /^config\.turri(?:\..+)?\.yaml$/.test(name))) return false;
  return names.includes(LEGACY_CONFIG_FILE) || legacyModuleConfigs(root).length > 0;
}

/** The file the project's settings are read from, by name: config.turri.yaml, or config.yaml while the folder has only the old files. */
export function projectConfigFile(root: string): string {
  return usesLegacyConfig(root) ? LEGACY_CONFIG_FILE : CONFIG_FILE;
}

/** The file a module's own settings are read from, by name - the old name while the folder has only the old files. */
export function moduleConfigFileIn(root: string, module: string): string {
  return usesLegacyConfig(root) ? legacyModuleConfigFile(module) : moduleConfigFile(module);
}

/** Whether a folder holds a project's settings: a config.turri.yaml, a module's file, or the old files. */
export function hasProjectConfig(root: string): boolean {
  return existsSync(join(root, CONFIG_FILE)) || moduleConfigsOf(root).length > 0 || usesLegacyConfig(root);
}

/** The modules a project folder has config files for, by name. */
export function moduleConfigsOf(root: string): string[] {
  if (usesLegacyConfig(root)) return legacyModuleConfigs(root);
  return namesIn(root)
    .map((name) => /^config\.turri\.(.+)\.yaml$/.exec(name)?.[1])
    .filter((name): name is string => name !== undefined)
    .sort();
}

/**
 * Before turri first writes a setting in a folder whose settings are still in the old files: config.yaml copied to
 * config.turri.yaml, and each config.<module>.yaml to config.turri.<module>.yaml, so nothing is lost when the old files
 * stop being read. The old files are left as they are. Gives back the files written, by name.
 */
/**
 * Keys turri has renamed, old to new - no alias: a project's config.turri.yaml or config.turri.<module>.yaml that still has
 * the old one has it renamed as turri first reads or writes the project's config (`renameOldKeys`), its value and its
 * comment kept. One that sets the new one too is left as it is, the old one said in the banner as doing nothing.
 */
export const RENAMED_KEYS: Readonly<Record<string, string>> = { "release-after-pulse": "launch-after-pulse" };

/** A key renamed in a config file. */
export interface RenamedKey {
  file: string;
  from: string;
  to: string;
}

/** The projects whose config files were looked at for old keys this process, and what was renamed in each - for the banner. */
const renamedKeys = new Map<string, RenamedKey[]>();

/**
 * Rename the old keys of `RENAMED_KEYS` in the project's config.turri*.yaml files - once a process, or again with `again`
 * (a file just copied from its old name). A top-level key alone, its line kept but for the key's name; a file that also
 * sets the new key, one that does not parse, or one that cannot be written is left as it is. Returns every key renamed
 * in the project this process.
 */
export function renameOldKeys(root: string, options: { again?: boolean } = {}): RenamedKey[] {
  const dir = resolve(root);
  const done = renamedKeys.get(dir);
  if (done !== undefined && options.again !== true) return done;
  const renamed = done ?? [];
  renamedKeys.set(dir, renamed);
  for (const file of namesIn(dir).filter((name) => /^config\.turri(\.[^.]+)?\.yaml$/.test(name))) {
    const path = join(dir, file);
    let text: string;
    let parsed: unknown;
    try {
      text = readFileSync(path, "utf8");
      parsed = loadYaml(text);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    let changed = text;
    const now: RenamedKey[] = [];
    for (const [from, to] of Object.entries(RENAMED_KEYS)) {
      if (!(from in parsed) || to in parsed) continue;
      const line = new RegExp(`^${from.replace(/[-]/g, "\\-")}(?=[ \\t]*:)`, "m");
      if (!line.test(changed)) continue;
      changed = changed.replace(line, to);
      now.push({ file, from, to });
    }
    if (now.length === 0) continue;
    try {
      writeFileSync(path, changed);
      renamed.push(...now);
    } catch {
      /* a file turri cannot write keeps its old key: the banner says it does nothing */
    }
  }
  return renamed;
}

export function adoptLegacyConfig(root: string, options: { projectFile?: boolean } = {}): string[] {
  renameOldKeys(root);
  if (!usesLegacyConfig(root)) return [];
  const copies: Array<[string, string]> = [
    // `projectFile: false`: the modules' files alone - turri init-config writes config.turri.yaml itself.
    ...(options.projectFile !== false && existsSync(join(root, LEGACY_CONFIG_FILE)) ? [[LEGACY_CONFIG_FILE, CONFIG_FILE] as [string, string]] : []),
    ...legacyModuleConfigs(root).map((module) => [legacyModuleConfigFile(module), moduleConfigFile(module)] as [string, string]),
  ];
  for (const [from, to] of copies) copyFileSync(join(root, from), join(root, to));
  // What was copied may have keys turri has renamed since.
  if (copies.length > 0) renameOldKeys(root, { again: true });
  return copies.map(([, to]) => to);
}

/** The module whose config file a pulse runs with: worked out as it was queued, whatever the files say since. */
const pinnedConfig = new AsyncLocalStorage<{ module: string | undefined }>();

/** Inside a pulse - or work pinned like one - the module whose config file it runs with; none outside. */
export function pinnedConfigModule(): string | undefined {
  return pinnedConfig.getStore()?.module;
}

/** Run `work` with `module`'s config file over the project's, whatever the files say meanwhile: a pulse keeps the one it started with. */
export function withConfigModule<T>(module: string | undefined, work: () => T): T {
  return pinnedConfig.run({ module }, work);
}

/** Whether a module's config file is pinned here - by the pulse it runs in, or the work that plans it. */
export function configModulePinned(): boolean {
  return pinnedConfig.getStore() !== undefined;
}

/**
 * The module whose config file builds a module - its `config.turri.<module>.yaml` laid over `config.turri.yaml` - or
 * none, `config.turri.yaml` alone. The one pinned, inside a pulse; else the module's own file; else the one file among
 * the modules it requires, all the way down - a module is built on their code, in one codebase, with their testing
 * scripts. Two among them is an error: which one builds it cannot be told. Only `requires` counts, not imports.
 */
export function configModuleFor(plainFile: string): string | undefined {
  const root = projectDirOf(resolve(plainFile));
  if (configModulePinned()) return configModuleOf(root);
  const own = basename(plainFile).replace(/\.plain$/, "");
  const files = moduleConfigsOf(root);
  if (files.length === 0) return undefined;
  if (files.includes(own)) return own;
  const below = requiredModulesOf(resolve(plainFile)).filter((name) => files.includes(name));
  if (below.length > 1) throw new Error(moduleConfigClash(own, below, root));
  return below[0];
}

/** Why a module's config cannot be told: two or more of the modules it requires have a config file of their own. */
export function moduleConfigClash(module: string, below: string[], root: string): string {
  const named = below.map((name) => moduleConfigFileIn(root, name)).join(", ");
  return (
    `${module}.plain requires modules that each have a config file of their own - ${named} - and a module built on others ` +
    `takes theirs, so which builds ${module}.plain cannot be told. Give ${module}.plain its own ${moduleConfigFileIn(root, module)}, ` +
    `or keep only one of them.`
  );
}

/**
 * Every module a module requires, all the way down, by name - read from each file's frontmatter alone, found as the
 * parser finds them (the module's folder, its template/ folder, PLAIN_TEMPLATE_DIRS). One that is not there, or does
 * not read, ends its branch: the parse says what is wrong with it.
 */
export function requiredModulesOf(plainFile: string): string[] {
  const dirs = resolveTemplateDirs(plainFile);
  const found: string[] = [];
  const visit = (file: string) => {
    for (const name of requiresIn(file)) {
      const bare = basename(name.replace(/^\.\//, ""), ".plain");
      if (found.includes(bare)) continue;
      found.push(bare);
      const next = dirs.map((dir) => join(dir, `${name}.plain`)).find((candidate) => existsSync(candidate));
      if (next !== undefined) visit(next);
    }
  };
  visit(plainFile);
  return found;
}

/** The modules a .plain file's frontmatter says it requires. */
function requiresIn(file: string): string[] {
  try {
    const match = /^-{3,}[ \t]*\n(?:([\s\S]*?)\n)?-{3,}[ \t]*(?:\n|$)/.exec(readFileSync(file, "utf8"));
    const front = match?.[1] !== undefined ? (loadYaml(match[1]) as { requires?: unknown } | null) : undefined;
    const requires = front?.requires;
    const names = typeof requires === "string" ? [requires] : Array.isArray(requires) ? requires : [];
    return names.filter((name): name is string => typeof name === "string" && name.trim() !== "").map((name) => name.trim());
  } catch {
    return [];
  }
}

/** The module whose config file is pinned here, when the project folder has that file. */
export function configModuleOf(root: string): string | undefined {
  const module = pinnedConfigModule();
  return module !== undefined && moduleConfigsOf(root).includes(module) ? module : undefined;
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
 * are both `arbiter`.
 */
export const AGENT_ROLES = ["chat", "sentinel", "planner", "capture", "capture-analysis", "diagnosis", "launch", "coding", "conformance", "explorer", "reviewer", "test-reviewer", "judge", "arbiter", "debugger"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * How hard each role thinks when nothing names a level - not the config's `models:`, nor a `:level` on the model it is
 * given. The agents that do the work - write the code and the tests, explore, launch - think little: they work from a
 * spec that leaves little to guess, and every turn of theirs is many. The ones that judge - review, weigh, plan, find a
 * cause - think more: a wrong call there costs pulses. The conversation keeps its own level, pi's.
 */
export const ROLE_THINKING: Partial<Record<AgentRole, ThinkingLevel>> = {
  coding: "low",
  conformance: "low",
  explorer: "low",
  launch: "low",
  reviewer: "medium",
  "test-reviewer": "medium",
  judge: "medium",
  arbiter: "medium",
  debugger: "medium",
  planner: "medium",
  capture: "medium",
  "capture-analysis": "low",
  diagnosis: "medium",
};

/** The roles on the conversation's side: without their own entry they take the chat's model, not `default`. */
// The launch is not: it follows steps - a script, a start command - and runs on the coding model, thinking low. Nor
// is the diagnosis: a post-mortem of a job that failed, read by the person - it runs on the coding model, thinking medium.
// Capture's writers are on the chat's side; its analysis agents take the coding model.
const CHAT_SIDE: readonly AgentRole[] = ["chat", "sentinel", "planner", "capture"];

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
  return modelSpec(projectModels(readProjectConfig(root, configModuleOf(root)))[role]);
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
  // An explicit capture setting still applies to the whole capture. Otherwise analysis takes the coding model it was given.
  if (role === "capture-analysis") return inheritModel(own, choiceOf(models.capture));
  // The debugger looks at the coding agent's failure: without its own entry it runs on the model it is given - a stronger one.
  if (role === "debugger") return own;
  if (CHAT_SIDE.includes(role)) return own === undefined ? undefined : inheritModel(own, inheritModel(choiceOf(models.chat), config.harnessModel));
  const legacy = role === "judge" || role === "test-reviewer" ? config.judgeModel : undefined;
  return inheritModel(own, inheritModel(legacy, choiceOf(models.default)));
}

/** How long each turn of a role's agents may take, in milliseconds: its own, `default`'s, `turn-limit:`'s - or undefined, the harness's default. */
export function roleTurnLimitMs(config: Pick<ProjectConfig, "models" | "turnLimit">, role: AgentRole | undefined): number | undefined {
  const models = config.models ?? {};
  const seconds = (role !== undefined ? models[role]?.turnLimit : undefined) ?? (role === "capture-analysis" ? models.capture?.turnLimit : undefined) ?? models.default?.turnLimit ?? config.turnLimit;
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
   * Whether every pulse that lands code is launched (docs/launch.md): in the background, on the launch track - the newest
   * commit winning, no pulse waiting on it - by an agent that follows the project's launch guidance. Unset: false.
   */
  launchAfterPulse?: boolean;
  /**
   * Whether the session has a sentinel: a chat of its own that every finished pulse goes to - checked, what is launched tested,
   * and what is wrong put to the person - instead of the chat that asked for it (docs/sentinel.md). `ask`: the person is
   * asked, before it first opens in a session, whether to start it. Unset: ask.
   */
  sentinel?: SentinelSetting;
  /**
   * The folder of the test plain files, from the project's folder: a functional spec's scenarios are in its test plain
   * file in `<test-dir>/<module>/`. Unset: `tests`.
   */
  testDir?: string;
  /**
   * Whether functional specs' scenarios are written and conformance tested (conformance-switch.ts). False: none - no
   * conformance pulse, no conformance testing script, the chat's conform refused; the test plain
   * files there are kept, and not tested. They make each change take about twice as long, so only the person turns them
   * on - /conform, or this key. Unset: false.
   */
  conformanceTests?: boolean;
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
  /** The most functional specs the planner puts in one pulse. Unset: 3. A module's own file wins. */
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
  launchAfterPulse: "launch-after-pulse",
  sentinel: "sentinel",
  testDir: "test-dir",
  conformanceTests: "conformance-tests",
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
 * The project's config - with a module's own file over it, when one is named - or nothing of it when there is no file or it does
 * not parse.
 */
export function readProjectConfig(root: string, module?: string): ProjectConfig {
  return withRunOverrides(readLayeredConfig(root, module));
}

function readLayeredConfig(root: string, module?: string): ProjectConfig {
  // A key turri has renamed, renamed in the files as they are first read.
  renameOldKeys(root);
  const project = readConfigFile(join(root, projectConfigFile(root)));
  if (module === undefined) return project;
  const own = readConfigFile(join(root, moduleConfigFileIn(root, module)));
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

/** The folder of a module's project's test plain files: `test-dir:` - its own file's over the project's - from the project's folder. */
export function testDirOf(plainFile: string): string {
  return resolve(projectDirOf(resolve(plainFile)), configForSpec(plainFile).testDir ?? DEFAULT_TEST_DIR);
}

/** The config a spec is built with: its project's, with its module's own file over it - or a required module's (`configModuleFor`). */
export function configForSpec(plainFile: string): ProjectConfig {
  const root = projectDirOf(resolve(plainFile));
  // Two module files among the modules it requires: the project's alone, read as anything reads it - the parse, and
  // every call that would build the module, refuse it with why (`configModuleFor`).
  let module: string | undefined;
  try {
    module = configModuleFor(plainFile);
  } catch {
    module = undefined;
  }
  return readProjectConfig(root, module);
}

/**
 * One config file, read, or nothing of it when it is not there or does not parse. Parsed again only once the file has
 * changed - its size or its modification time - and each caller given its own copy. A file modified less than a second
 * before it was read is read again each time, as git treats a racily clean file: written again within the same tick of
 * the file system's clock - milliseconds on Linux - and to the same size, its stamp would not change.
 */
export function readConfigFile(path: string): ProjectConfig {
  let stamp: string;
  let modified: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return {};
    stamp = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
    modified = stat.mtimeMs;
  } catch {
    return {};
  }
  const kept = keptConfigs.get(path);
  if (kept !== undefined && kept.stamp === stamp && modified < kept.readAt - RACY_MS) return structuredClone(kept.config);
  const readAt = Date.now();
  const config = readConfigFileNow(path);
  keptConfigs.set(path, { stamp, config, readAt });
  if (keptConfigs.size > 64) keptConfigs.delete(keptConfigs.keys().next().value!);
  return structuredClone(config);
}

/** How long before it was read a config file must have last changed for its stamp to be trusted. */
const RACY_MS = 1_000;

const keptConfigs = new Map<string, { stamp: string; config: ProjectConfig; readAt: number }>();

function readConfigFileNow(path: string): ProjectConfig {
  let parsed: unknown;
  try {
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
    launchAfterPulse: typeof raw[CONFIG_KEYS.launchAfterPulse] === "boolean" ? (raw[CONFIG_KEYS.launchAfterPulse] as boolean) : undefined,
    sentinel: typeof raw[CONFIG_KEYS.sentinel] === "boolean" || raw[CONFIG_KEYS.sentinel] === "ask" ? (raw[CONFIG_KEYS.sentinel] as SentinelSetting) : undefined,
    testDir: text(raw[CONFIG_KEYS.testDir]),
    conformanceTests: typeof raw[CONFIG_KEYS.conformanceTests] === "boolean" ? (raw[CONFIG_KEYS.conformanceTests] as boolean) : undefined,
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

/** Keys a config file is read for besides CONFIG_KEYS: the older spellings turri still takes. */
const OLDER_KEYS = ["model", "turn_limit"];

/**
 * The keys of the project's own config files - config.turri.yaml and each module's - that turri reads nothing of: a setting
 * turri no longer has (`test-advisor`), or one misspelt. Said as turri starts, so a setting the person thinks is on is
 * not silently ignored. config.yaml is left out: it may be another tool's, with keys of its own.
 */
export function unknownConfigKeys(root: string): Array<{ file: string; keys: string[] }> {
  // An old name of a renamed key is said on a line of its own (configLines), not as a key turri does not read.
  const known = new Set<string>([...Object.values(CONFIG_KEYS), ...OLDER_KEYS, ...Object.keys(RENAMED_KEYS)]);
  const found: Array<{ file: string; keys: string[] }> = [];
  for (const file of namesIn(root).filter((name) => /^config\.turri(\.[^.]+)?\.yaml$/.test(name)).sort()) {
    let parsed: unknown;
    try {
      parsed = loadYaml(readFileSync(join(root, file), "utf8"));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const keys = Object.keys(parsed).filter((key) => !known.has(key));
    if (keys.length > 0) found.push({ file, keys });
  }
  return found;
}

/**
 * What a line under the banner about a config file is, for a host that draws them without reading their text: `renamed`,
 * a key turri renamed in the file - information, nothing to do; `old-beside-new`, an old name left beside its new one,
 * doing nothing - take it out; `unknown`, keys turri does not read - take them out, or fix their spelling.
 */
export type ConfigLineKind = "broken" | "renamed" | "old-beside-new" | "unknown";

export interface ConfigLine {
  kind: ConfigLineKind;
  /** The file, from the project: `config.turri.yaml`, `config.turri.<module>.yaml`. */
  file: string;
  /** The line, as the terminal shows it. */
  text: string;
}

/**
 * The banner's lines for the project's config files: each key turri renamed in them this process, each old name left
 * beside its new one - doing nothing - and each file with keys turri does not read.
 */
export function configLines(root: string): ConfigLine[] {
  const broken = configProblems(root).map((problem): ConfigLine => ({ kind: "broken", file: problem.file, text: `${problem.text} - so none of ${problem.file} applies: turri runs on its defaults and pi's, the models among them. Set each key once.` }));
  const renamed = renameOldKeys(root).map(({ file, from, to }): ConfigLine => ({ kind: "renamed", file, text: `${file}: ${from} is called ${to} now - turri renamed it there, its value kept.` }));
  const left: ConfigLine[] = [];
  for (const file of namesIn(root).filter((name) => /^config\.turri(\.[^.]+)?\.yaml$/.test(name)).sort()) {
    let parsed: unknown;
    try {
      parsed = loadYaml(readFileSync(join(root, file), "utf8"));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    for (const [from, to] of Object.entries(RENAMED_KEYS)) {
      if (from in parsed && to in parsed) left.push({ kind: "old-beside-new", file, text: `${file} has ${from}, the old name of ${to}, which it sets too: ${from} does nothing - take it out.` });
    }
  }
  const unknown = unknownConfigKeys(root).map(
    ({ file, keys }): ConfigLine => ({
      kind: "unknown",
      file,
      text: `${file} has ${keys.length === 1 ? "a key" : "keys"} turri does not read - ${keys.join(", ")}: no setting turri has, so ${keys.length === 1 ? "it does" : "they do"} nothing. Take ${keys.length === 1 ? "it" : "them"} out, or see docs/config.md for the spelling.`,
    }),
  );
  return [...broken, ...renamed, ...left, ...unknown];
}

/**
 * Why a config file does not parse - its line and what YAML says, a key set twice among them - or undefined when it
 * parses or is not there. turri reads a config that does not parse as empty, every setting at its default, the models
 * pi's own: said, never silently.
 */
export function configFileProblem(path: string): string | undefined {
  let text: string;
  try {
    if (!statSync(path).isFile()) return undefined;
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const file = basename(path);
  try {
    const parsed = loadYaml(text);
    if (parsed !== null && parsed !== undefined && (typeof parsed !== "object" || Array.isArray(parsed))) return `${file} is not a list of settings, a key and its value a line`;
    return undefined;
  } catch (error) {
    const reason = (error as { reason?: unknown }).reason;
    const line = (error as { mark?: { line?: unknown } }).mark?.line;
    const at = typeof line === "number" ? `, line ${line + 1}` : "";
    const key = typeof line === "number" ? /^\s*([\w.-]+)\s*:/.exec(text.split("\n")[line] ?? "")?.[1] : undefined;
    if (reason === "duplicated mapping key") return `${file}${at}: ${key !== undefined ? `${key} is` : "a key is"} set twice`;
    return `${file}${at} does not parse: ${typeof reason === "string" ? reason : error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }
}

/** The config files of a project folder that do not parse - config.turri.yaml and each module's own - each with why. */
export function configProblems(root: string): Array<{ file: string; text: string }> {
  return namesIn(root)
    // config.yaml only while turri reads it: until it writes config.turri.yaml, it may be another tool's.
    .filter((name) => /^config\.turri(\.[^.]+)?\.yaml$/.test(name) || (name === LEGACY_CONFIG_FILE && usesLegacyConfig(root)))
    .sort()
    .flatMap((file) => {
      const text = configFileProblem(join(root, file));
      return text === undefined ? [] : [{ file, text }];
    });
}

/** Why a project's config does not parse, in a sentence for a refusal - undefined when every file of it parses. */
export function brokenConfig(root: string): string | undefined {
  const problems = configProblems(root);
  if (problems.length === 0) return undefined;
  return (
    `${problems.map((problem) => problem.text).join("; ")}. A config that does not parse is read as empty: none of it would apply - ` +
    `not the models, not conformance tests, no other setting - and turri would run on its defaults and pi's. Fix it - each key set once - then ask again.`
  );
}
