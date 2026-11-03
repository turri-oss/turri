import { spawnSync } from "node:child_process";
import { spawnAsync } from "./spawn-async.ts";
import { existsSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { EXTENSION_PROVIDERS, installedProviders, runtimeWithProviders } from "./installed-providers.ts";
import { globalExtensionFile, MIN_NODE, nodeVersionOk, PACKAGE_ROOT, turriIdentity } from "./environment.ts";
import { fetchLatest, newerThan, turrisOnPath, versionFindings } from "./turri-versions.ts";
import { sandboxAvailable, sandboxWithAsync, type Wall } from "./regenerate/os-sandbox.ts";
import { findTestScripts, onThisMachine } from "./regenerate/test-scripts.ts";
import { configKeyOptions, parseArgs } from "./cli-options.ts";
import { CONFIG_FILE, hasProjectConfig, readProjectConfig, stackConfigFile, stackOf, stacksOf } from "./config.ts";
import { checkModels, modelsInUse, piModelAccess, type ModelAccess } from "./model-check.ts";
import { bedrockRegionFor, describeBedrockRegion, regionInGeography, type BedrockRegion } from "./bedrock-region.ts";
import { baseFilesAsync } from "./regenerate/base-folder.ts";
import { brand } from "./brand.ts";
import { readScript, scriptAgainstMachine, stackOnMachineAsync } from "./stack.ts";

/**
 * `turri doctor`: whether this machine is ready for turri.
 *
 * It looks: Node, a bash to run commands with, which wall is up under the agents' commands - Seatbelt, bubblewrap, or
 * the command check and the audit alone - and, in a project, whether this machine has the toolchains its modules'
 * implementation reqs name and what its testing scripts run, and whether each model its config names answers with this
 * machine's credentials - one short request a model (model-check.ts). It changes one thing, asked first: a plain `pi`
 * that an older turri made load turri too is put back to plain pi.
 *
 * `doctor()` is the checks alone, for the CLI and for a host (src/host.ts): it prints nothing and asks nothing.
 */

export type Level = "ok" | "missing" | "limited" | "info";

export interface Check {
  level: Level;
  name: string;
  detail: string;
  /** More about it, a line each, shown under the detail. */
  more?: string[];
  /** What to run or do about it. */
  fix?: string;
}

const MARK: Record<Level, string> = { ok: "✓", missing: "✗", limited: "!", info: "·" };

function checkNode(): Check {
  const version = process.versions.node;
  return nodeVersionOk(version)
    ? { level: "ok", name: "Node", detail: version }
    : {
        level: "missing",
        name: "Node",
        detail: `${version} - turri needs ${MIN_NODE.join(".")} or newer`,
        fix: "install a newer Node (https://nodejs.org, or `brew install node`)",
      };
}

/** bash: every agent command and every testing script runs with it, on every platform. */
export function checkShell(found: boolean = spawnSync("bash", ["--version"], { stdio: "ignore", windowsHide: true }).status === 0, platform: NodeJS.Platform = process.platform): Check {
  if (found) return { level: "ok", name: "bash", detail: "on the PATH - agents' commands and the testing scripts run with it" };
  return {
    level: "missing",
    name: "bash",
    detail: "not on the PATH - agents' commands and the testing scripts run with it",
    fix: platform === "win32" ? "install Git for Windows (Git Bash), and put its bash on the PATH" : "install bash with your system's package manager",
  };
}

/** git: each module's history, which every pulse starts from and lands in, and the spec diffs the work is planned from. */
export function checkGit(found: boolean = spawnSync("git", ["--version"], { stdio: "ignore", windowsHide: true }).status === 0): Check {
  if (found) return { level: "ok", name: "git", detail: "on the PATH - each module's history, and the spec diffs" };
  return {
    level: "missing",
    name: "git",
    detail: "not on the PATH - each module's history is a git repository, and the work is planned from git diffs",
    fix: "install git with your system's package manager",
  };
}

/** Which wall is up under the agents' commands, and - where none starts - why, and how to give it one. */
export function checkSandbox(wall: Wall = sandboxAvailable(), platform: NodeJS.Platform = process.platform): Check {
  if (wall.kind === "seatbelt") return { level: "ok", name: "OS sandbox", detail: "Seatbelt - under the command check and the audit" };
  if (wall.kind === "bubblewrap") {
    return { level: "ok", name: "OS sandbox", detail: `bubblewrap${wall.proc === "bind" ? ", the host's /proc bound (this container masks its own)" : ""} - under the command check and the audit` };
  }
  return {
    level: platform === "win32" ? "info" : "limited",
    name: "OS sandbox",
    detail: `none - ${wall.why}; the command check and the audit hold alone`,
    ...(wall.fix !== undefined ? { fix: wall.fix } : {}),
  };
}

/**
 * In a project: each module's toolchains, as its implementation reqs name them, against this machine's PATH; and each
 * testing script against this machine - a program it names that is not here, a toolchain it runs that is not on the
 * PATH. Nothing outside a project.
 */
export async function checkProject(
  project: string,
  machine: { has?: (command: string) => boolean; exists?: (path: string) => boolean; jdk?: () => boolean | Promise<boolean> } = {},
): Promise<Check[]> {
  const checks: Check[] = [];
  for (const { module, needs, missing } of await stackOnMachineAsync(project, machine.has, machine.jdk)) {
    if (needs.length === 0) continue;
    checks.push(
      missing.length === 0
        ? { level: "ok", name: `${module}`, detail: `has ${needs.map((need) => need.toolchain).join(", ")}` }
        : {
            level: "missing",
            name: `${module}`,
            detail: `its implementation reqs need ${missing.map((need) => `${need.toolchain} (${need.words.join(", ")})`).join(", ")}, which this machine lacks`,
            fix: `install ${missing.map((need) => need.toolchain).join(" and ")} on this machine - the agents use its toolchains, and install none`,
          },
    );
  }
  const scripts = findTestScripts(project);
  for (const script of [scripts.unit, scripts.prepare, scripts.conformance]) {
    if (script === undefined) continue;
    const text = readScript(script);
    if (text === undefined) continue;
    const found = scriptAgainstMachine(text, machine);
    if (found.length === 0) continue;
    checks.push({
      level: "limited",
      name: relative(project, script),
      detail: "does not fit this machine - it is yours to fix:",
      more: found,
    });
  }
  return checks;
}

async function checkProvider(project: string = process.cwd()): Promise<Check> {
  try {
    // pi's providers, and those the person's installed pi extensions register - a Claude subscription through Claude Code.
    const runtime = await runtimeWithProviders(await installedProviders(project));
    const available = new ModelRegistry(runtime).getAvailable();
    const providers = [...new Set(available.map((model) => model.provider))];
    if (providers.length > 0) {
      return { level: "ok", name: "Model provider", detail: `${providers.join(", ")} (${available.length} models)` };
    }
  } catch {
    // Reported as missing below.
  }
  return {
    level: "missing",
    name: "Model provider",
    detail: "no model has credentials",
    fix: "run `pi` and use /login, or set an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ...)",
  };
}

/**
 * turri itself: whether it is the newest npm has - asked now - and every turri on the PATH, which runs, and what hides a
 * newer one behind an older (turri-versions.ts). What to do, said under each.
 */
async function checkTurri(): Promise<Check[]> {
  const own = turriIdentity();
  const onPath = turrisOnPath();
  const latest = own.git_commit === null ? await fetchLatest() : undefined;
  const findings = versionFindings({ ...(latest !== undefined ? { latest } : {}), onPath });
  const version = own.version ?? "?";
  const outdated = findings.find((finding) => finding.kind === "outdated");
  const versionCheck: Check =
    own.git_commit !== null
      ? { level: "info", name: "turri version", detail: `${version}, from a clone - not compared with npm` }
      : outdated !== undefined
        ? { level: "limited", name: "turri version", detail: outdated.text, fix: outdated.fixes.join("; ") }
        : latest === undefined
          ? { level: "info", name: "turri version", detail: `${version} - npm did not answer, so it is not compared` }
          : own.version !== null && newerThan(latest, own.version)
            ? // Older than npm's, with a newer turri installed already: the PATH check says which, and what hides it.
              { level: "limited", name: "turri version", detail: `${version} - npm has ${latest}, and a newer turri is installed already: see turri on PATH` }
            : { level: "ok", name: "turri version", detail: `${version} - the newest on npm` };
  if (onPath.length === 0) {
    return [
      versionCheck,
      {
        level: "limited",
        name: "turri on PATH",
        detail: "not found",
        // A clone has its sources; the package from npm has only what was compiled from them.
        fix: existsSync(join(PACKAGE_ROOT, "src")) ? `cd ${PACKAGE_ROOT} && npm link` : "npm install -g @turri-dev/cli",
      },
    ];
  }
  const copies = onPath.map((turri) => `${turri.path}  turri ${turri.version ?? "?"}  (${[turri.runs ? "runs" : "hidden", ...(turri.self ? ["this one"] : []), ...(turri.clone ? ["a clone"] : [])].join(", ")})`);
  const hidden = findings.filter((finding) => finding.kind !== "outdated");
  const pathCheck: Check =
    hidden.length > 0
      ? // Every turri, then what to do, in order: a step a line.
        { level: "missing", name: "turri on PATH", detail: hidden[0]!.text, more: [...copies, ...hidden.flatMap((finding) => finding.fixes).map((fix) => `→ ${fix}`)] }
      : { level: "ok", name: "turri on PATH", detail: onPath.length === 1 ? onPath[0]!.path : `${onPath.length} turris - the first, which runs, is the newest`, ...(onPath.length > 1 ? { more: copies } : {}) };
  return [versionCheck, pathCheck];
}

/**
 * turri loaded into every `pi` - a file an older `turri setup` wrote into pi's extensions. turri and pi are kept apart
 * now: `turri` starts pi with turri, and a plain `pi` stays pi. Said only when the file is there, for doctor to remove.
 */
function checkGlobal(): Check[] {
  const file = globalExtensionFile();
  if (file === undefined) return [];
  return [
    {
      level: "limited",
      name: "turri in every pi",
      detail: `${file} loads turri into every plain pi too`,
      fix: "turri doctor offers to remove it, below - turri keeps starting with turri",
    },
  ];
}

/**
 * In a project: each model its config names - with the stack chosen, that stack's over it - tried with one short
 * request. A model that answers is ready; one that does not says what the provider said, and what to do about it.
 */
export async function checkProjectModels(project: string, access?: ModelAccess): Promise<Check[]> {
  const used = modelsInUse(readProjectConfig(project, stackOf(project)));
  if (used.length === 0) {
    return [{ level: "missing", name: "Models", detail: "config.turri.yaml names none", fix: "turri init-config writes the two models - or name them here: --harness-model, --coding-model" }];
  }
  let verdicts;
  try {
    const region = describeBedrockRegion(bedrockRegionFor(project));
    verdicts = await checkModels(used, access ?? (await piModelAccess()), region !== undefined ? { bedrockRegion: region } : {});
  } catch (error) {
    return [{ level: "missing", name: "Models", detail: `pi's models could not be read: ${error instanceof Error ? error.message : String(error)}` }];
  }
  return verdicts.map((verdict) => {
    const name = verdict.usedBy.join(", ");
    return verdict.ok
      ? { level: "ok" as const, name, detail: `${verdict.spec} answered (${(verdict.ms / 1000).toFixed(1)}s)` }
      : { level: "missing" as const, name, detail: verdict.spec, more: [verdict.problem], fix: verdict.fix };
  });
}

export interface DoctorOptions {
  /** The project to check. Without it, only the machine. */
  dir?: string;
  /** Ask each model the project's config names for a word - a request a model, which costs money. Off by default. */
  models?: boolean;
  /** The environment whose PATH is looked in - bash, git, the sandbox, the toolchains, what the testing scripts run. */
  env?: NodeJS.ProcessEnv;
}

/** The CLI's own: what matters only in a terminal, and models named on the command line - asked of, a project or not. */
interface CliOptions {
  cli?: boolean;
  modelsGiven?: boolean;
}

/** Whether doctor asks the models: asked to, and a config that names them - or models named on the command line. */
function asksModels(options: DoctorOptions & CliOptions): options is DoctorOptions & CliOptions & { dir: string } {
  return options.models === true && options.dir !== undefined && (hasProjectConfig(options.dir) || options.modelsGiven === true);
}

/** Whether `command` runs with `env` - its PATH looked in, as the agents' shells and the testing scripts would. Never holds a host's thread up. */
async function runs(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return (await spawnAsync(command, ["--version"], { env })).status === 0;
}

/**
 * Whether this machine - and, with `dir`, that project - is ready for turri, as checks. It prints nothing and asks
 * nothing, so a host can show them in its own way; `turri doctor` prints the same.
 */
export async function doctor(options: DoctorOptions = {}): Promise<Check[]> {
  return allChecks({ ...options, cli: false, modelsGiven: false });
}

async function allChecks(options: DoctorOptions & CliOptions): Promise<Check[]> {
  const env = options.env ?? process.env;
  // Each check that runs a command runs it without holding the thread up - a host asks on its own - side by side.
  const [bash, git, wall, provider] = await Promise.all([runs("bash", env), runs("git", env), sandboxWithAsync(env), checkProvider(options.dir)]);
  const checks: Check[] = [checkNode(), checkShell(bash), checkGit(git), checkSandbox(wall), provider];
  if (options.cli === true) checks.push(...(await checkTurri()), ...checkGlobal());
  // In a project: what it needs of this machine, and whether its models answer.
  const project = options.dir;
  if (project === undefined) return checks;
  if (hasProjectConfig(project) || existsSync(join(project, "plain_modules"))) checks.push(...(await checkProject(project, { has: (command) => onThisMachine(command, env) !== undefined })));
  if (hasProjectConfig(project)) checks.push(...checkBedrockRegion(project, env), ...(await checkClaudeSubscription(project, env)), ...(await checkBaseFolders(project)));
  if (asksModels(options)) checks.push(...(await checkProjectModels(project)));
  return checks;
}

/** The environment pi-claude-code refuses to run with: each points Claude Code at an API key or another backend, not the subscription. */
export const CLAUDE_CODE_CONFLICTS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY"];
const CLAUDE_CODE_BACKENDS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

/** What the Claude subscription check looks at - this machine's, or a test's. */
export interface ClaudeCodeProbe {
  /** Whether pi has the claude-code provider: its extension, pi-claude-code, installed. */
  installed(): Promise<boolean>;
  /** `claude auth status`, as it answers: undefined when there is no claude to run. */
  status(command: string, env: NodeJS.ProcessEnv): Promise<{ loggedIn?: boolean; subscriptionType?: string; authMethod?: string } | undefined>;
  /** The executable a command name is, on the PATH - undefined when it is not there. */
  which(command: string, env: NodeJS.ProcessEnv): string | undefined;
}

const claudeCodeProbe = (project: string): ClaudeCodeProbe => ({
  installed: async () => (await installedProviders(project))?.getRegisteredProviderIds().includes("claude-code") === true,
  async status(command, env) {
    const run = await spawnAsync(command, ["auth", "status"], { env, timeout: 15_000 });
    if (run.error !== undefined) return undefined;
    try {
      return JSON.parse(run.stdout) as { loggedIn?: boolean; subscriptionType?: string; authMethod?: string };
    } catch {
      return { loggedIn: false };
    }
  },
  which: (command, env) => (command.includes("/") ? (existsSync(command) ? command : undefined) : onThisMachine(command, env)),
});

/**
 * A Claude subscription through Claude Code, when the project's config names a `claude-code/...` model: everything
 * pi-claude-code needs, in the order it needs it - its extension installed, Claude Code on the PATH, signed in to a Pro or
 * Max subscription, and nothing in the environment it refuses. Nothing when no model is a claude-code one.
 */
export async function checkClaudeSubscription(project: string, env: NodeJS.ProcessEnv = process.env, probe: ClaudeCodeProbe = claudeCodeProbe(project)): Promise<Check[]> {
  const configs = [readProjectConfig(project), ...stacksOf(project).map((stack) => readProjectConfig(project, stack))];
  const named = [...new Set(configs.flatMap((config) => modelsInUse(config)).filter((used) => used.spec.startsWith("claude-code/")).map((used) => used.spec))];
  if (named.length === 0) return [];
  const name = "Claude subscription";
  const extension = EXTENSION_PROVIDERS["claude-code"]!;
  if (!(await probe.installed())) {
    return [{ level: "missing", name, detail: `${named.join(", ")} need pi-claude-code, pi's extension for a Claude subscription, which is not installed`, fix: extension.install }];
  }
  const command = env.PI_CLAUDE_CODE_COMMAND?.trim() || "claude";
  const found = probe.which(command, env);
  if (found === undefined) {
    return [{ level: "missing", name, detail: `Claude Code (${command}) is not on the PATH - every claude-code request goes through it`, fix: "npm install -g @anthropic-ai/claude-code - or name it in PI_CLAUDE_CODE_COMMAND" }];
  }
  const configDir = env.PI_CLAUDE_CODE_CONFIG_DIR?.trim();
  const status = await probe.status(found, configDir ? { ...env, CLAUDE_CONFIG_DIR: configDir } : env);
  if (status?.loggedIn !== true) return [{ level: "missing", name, detail: `Claude Code (${found}) is not signed in`, fix: "claude auth login - with the Claude account that has the Pro or Max subscription" }];
  if (status.subscriptionType === undefined || status.subscriptionType === "") {
    return [{ level: "missing", name, detail: `Claude Code is signed in${status.authMethod !== undefined ? ` (${status.authMethod})` : ""}, but not to a Claude subscription`, fix: "claude auth logout, then claude auth login with the account that has the Pro or Max subscription" }];
  }
  const conflicts = [...CLAUDE_CODE_CONFLICTS.filter((key) => (env[key] ?? "") !== ""), ...CLAUDE_CODE_BACKENDS.filter((key) => /^(1|true|yes|on)$/i.test(env[key]?.trim() ?? ""))];
  if (conflicts.length > 0) {
    return [{ level: "missing", name, detail: `${conflicts.join(", ")} ${conflicts.length === 1 ? "is" : "are"} set: pi-claude-code refuses to run with ${conflicts.length === 1 ? "it" : "them"}, as ${conflicts.length === 1 ? "it points" : "they point"} Claude Code away from the subscription`, fix: `unset ${conflicts.join(" ")} where turri starts - your shell's profile, say` }];
  }
  return [{ level: "ok", name, detail: `pi-claude-code installed, Claude Code signed in to ${status.subscriptionType} - for ${named.join(", ")}` }];
}

/**
 * The base folders the project's config names - its own, and each stack's - each there with its files, or not: a codebase
 * that requires nothing starts from one, and its first pulse stops when it is not there. Nothing when none is named.
 */
export async function checkBaseFolders(project: string): Promise<Check[]> {
  const named = new Map<string, string[]>();
  for (const [stack, config] of [[undefined, readProjectConfig(project)] as const, ...stacksOf(project).map((stack) => [stack, readProjectConfig(project, stack)] as const)]) {
    if (config.baseFolder === undefined) continue;
    named.set(config.baseFolder, [...(named.get(config.baseFolder) ?? []), stack === undefined ? CONFIG_FILE : stackConfigFile(stack)]);
  }
  return Promise.all([...named].map(async ([folder, files]): Promise<Check> => {
    const path = resolve(project, folder);
    const name = `base folder ${folder}`;
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return { level: "missing", name, detail: `${existsSync(path) ? "not a folder" : "not there"} - named in ${files.join(", ")}`, fix: "make the folder, or name the right one in base-folder:, by path from the project's folder" };
    }
    const count = (await baseFilesAsync(path)).length;
    return { level: "ok", name, detail: `${count} file${count === 1 ? "" : "s"} to start a codebase from - named in ${files.join(", ")}` };
  }));
}

/**
 * The AWS region a project's Bedrock models are called in, when it uses any: turri's, the person's or the profile's - and
 * what is wrong with it, when the models need two, or the person's is not in their geography. Nothing when it uses none.
 */
export function checkBedrockRegion(project: string, env: NodeJS.ProcessEnv = process.env): Check[] {
  let decided: BedrockRegion;
  try {
    decided = bedrockRegionFor(project, { env });
  } catch {
    return [];
  }
  const line = describeBedrockRegion(decided);
  if (decided.models.length === 0 || line === undefined) return [];
  const outside = decided.source === "set" && decided.needs !== undefined && decided.region !== undefined && !regionInGeography(decided.region, decided.needs.geography);
  if (decided.conflict !== undefined) return [{ level: "missing", name: "AWS region", detail: "the Bedrock models need two regions", more: [line] }];
  if (outside) return [{ level: "missing", name: "AWS region", detail: `${decided.region}, which does not serve ${decided.needs!.geography}'s models`, more: [line] }];
  return [{ level: "ok", name: "AWS region", detail: line }];
}

/** What the checks add up to: whether turri can run here, and a line saying so - with its marks, uncoloured. */
export function verdictOf(checks: Check[]): { ready: boolean; limited: boolean; text: string } {
  const missing = checks.filter((check) => check.level === "missing").length;
  if (missing > 0) return { ready: false, limited: false, text: `Not ready: ${missing} thing${missing === 1 ? "" : "s"} to fix (✗ above).` };
  return checks.some((check) => check.level === "limited") ? { ready: true, limited: true, text: "Ready, with limits (! above)." } : { ready: true, limited: false, text: "Ready." };
}

/** The checks as plain text, a line each and what to do under it, and the verdict - for a reader that is not a terminal. */
export function describeChecks(checks: Check[]): string {
  const lines = checks.flatMap((check) => [
    `${MARK[check.level]} ${check.name}: ${check.detail}`,
    ...(check.more ?? []).map((line) => `    ${line}`),
    ...(check.fix && check.level !== "ok" ? [`    → ${check.fix}`] : []),
  ]);
  return `${lines.join("\n")}\n\n${verdictOf(checks).text}`;
}

function report(checks: Check[]): number {
  const paint: Record<Level, (text: string) => string> = { ok: brand.success, missing: brand.error, limited: brand.warning, info: brand.muted };
  // The names in one column, however long the longest - `judge-model, models.judge` - is.
  const width = Math.max(20, ...checks.map((check) => check.name.length)) + 1;
  const under = " ".repeat(width + 4);
  console.log("");
  for (const check of checks) {
    const name = check.level === "missing" ? brand.bold(check.name.padEnd(width)) : check.name.padEnd(width);
    console.log(`  ${paint[check.level](MARK[check.level])} ${name}${check.level === "info" ? brand.muted(check.detail) : check.detail}`);
    for (const line of check.more ?? []) console.log(`${under}${brand.muted(line)}`);
    if (check.fix && check.level !== "ok") console.log(`${under}${brand.accent(`→ ${check.fix}`)}`);
  }
  const verdict = verdictOf(checks);
  console.log("");
  console.log((verdict.ready ? (verdict.limited ? brand.warning : brand.success) : brand.error)(verdict.text));
  return verdict.ready ? 0 : 1;
}

/**
 * Ask a yes/no question. With --yes, yes. With no terminal to ask on, no - nothing is changed
 * without asking - and it says so, so a piped run shows what it would have done.
 */
async function confirm(question: string, fallback: boolean, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.log(`${question} - not asked: no terminal. Run turri doctor in a terminal, or with --yes.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    return answer === "" ? fallback : answer.startsWith("y");
  } finally {
    rl.close();
  }
}

/**
 * Take turri out of every `pi`: the extension file an older `turri setup` wrote. The themes it copied stay - they only
 * add turri's themes to pi's list.
 */
function removeGlobalExtension(): void {
  const file = globalExtensionFile();
  if (file === undefined) return;
  rmSync(file, { force: true });
  console.log(`  removed ${file}`);
}

const USAGE = [
  "usage: turri doctor [--harness-model <m>] [--coding-model <m>] [--judge-model <m>] [--no-models] [--yes]",
  "",
  "Check everything turri needs - in a project, what its modules need of this machine too, and that",
  "each model its config names answers with this machine's credentials (one short request a model;",
  "--no-models skips it). The model options are read as the config's keys, as turri regenerate reads them:",
  "a headless run's models can be checked before it starts, with no config.turri.yaml.",
  "It changes nothing but this, asked first: a plain pi that an older turri made load turri too is put back to",
  "plain pi. --yes answers yes.",
].join("\n");

export async function main(args: string[]): Promise<number> {
  const { options } = parseArgs(args, ["--no-models", "--yes", "-y"], USAGE, ["--harness-model", "--judge-model"]);
  configKeyOptions(options);
  console.log(brand.bold(brand.accent("Checking what turri needs.")));
  if (!nodeVersionOk()) return report([checkNode()]);
  const modelsGiven = ["harness-model", "model", "judge-model"].some((name) => options[name] !== undefined);
  const checking = { dir: process.cwd(), models: options["no-models"] === undefined, cli: true, modelsGiven };
  if (asksModels(checking)) console.log(brand.muted("Asking each model the config names for a word..."));
  const code = report(await allChecks(checking));
  // turri and pi are kept apart: a plain pi does not start turri. An older turri's file that made it do so goes, asked.
  const global = globalExtensionFile();
  if (global !== undefined && (await confirm(`\nA plain \`pi\` loads turri too, through ${global}. Remove it, so pi stays pi?`, true, options.yes !== undefined || args.includes("-y")))) {
    removeGlobalExtension();
  }
  return code;
}
