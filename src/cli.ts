#!/usr/bin/env node
/**
 * One entry point, so the tools can be used from wherever the specification lives.
 *
 * Paths are resolved against the current working directory, and a .plain file's linked
 * resources are too - so the intended use is to `cd` to the module and name the file,
 * rather than to run from this repo and reach across with absolute paths.
 */

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_ROOT, extensionInstalledGlobally, themesInstalledGlobally, versionLine } from "./cli-root.ts";
import { dropNoise } from "./quiet.ts";
import { describeVersion } from "./turri-versions.ts";
import { readProjectConfig } from "@turri-dev/core/project";
import { CODING_MODEL_ENV, REOPEN_FILE_ENV, takeReopening } from "@turri-dev/core/startup";
import { chatModels } from "./chat-models.ts";
/**
 * Start pi with this project's extension and themes already wired in.
 *
 * Saves both a global pi install and the `-e <absolute path>` that a project-local
 * extension otherwise needs before the project is trusted.
 */
/**
 * Where this file is, and how its siblings are named: the sources in a clone (`src/*.ts`), the compiled files in an
 * installed package (`dist/*.js`).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const OWN_EXTENSION = import.meta.url.endsWith(".ts") ? ".ts" : ".js";

/** Whether pi is installed where Node finds it - beside turri, or wherever npm hoisted it. */
function piInstalled(): boolean {
  try {
    import.meta.resolve("@earendil-works/pi-coding-agent");
    return true;
  } catch {
    return false;
  }
}

/** The theme `turri` starts in. */
const DEFAULT_THEME = "turri-dark";

function chat(args: string[]): never {
  if (!piInstalled()) {
    console.error(`pi is not installed beside turri (${CLI_ROOT}). Run npm install there, or install turri again.`);
    process.exit(1);
  }
  // pi itself, through a launcher that leaves out pi's startup header - see pi-launch.ts.
  const launcher = join(HERE, `pi-launch${OWN_EXTENSION}`);

  // turri is built into pi by the launcher - unless an older turri's file still loads it into every pi, which builds it
  // in as well: pi-launch.ts is told, and leaves it to that. turri doctor offers to remove the file.
  const inPi = extensionInstalledGlobally();
  const themes = themesInstalledGlobally() ? [] : ["--theme", join(CLI_ROOT, ".pi", "themes")];
  // A chat that quits asking to open again elsewhere - after a capture, in the project it wrote - writes where in this
  // file, and is started again there, as the first was (reopen.ts).
  const reopenFile = join(tmpdir(), `turri-reopen-${process.pid}.json`);
  let run: { cwd: string; args: string[]; env: Record<string, string> } = { cwd: process.cwd(), args, env: {} };
  for (;;) {
    // turri's own theme, unless this run names another. For this run only: pi's settings
    // are left as they are, so a plain `pi` keeps its theme.
    const useTheme = run.args.some((arg) => arg === "--use-theme" || arg.startsWith("--use-theme=")) ? [] : ["--use-theme", DEFAULT_THEME];

    // The model the person talks to, and the one every render runs on - see chat-models.ts.
    const { piArgs, codingModel } = chatModels(run.args, readProjectConfig(run.cwd));

    // Fullscreen: pi owns the viewport, so the conversation stays where it is scrolled to while the
    // jobs redraw - in the terminal's own scrollback, every redraw pulls it back to the bottom.
    const tuiMode = run.args.some((arg) => arg === "--tui-mode" || arg.startsWith("--tui-mode=")) ? [] : ["--tui-mode", "fullscreen"];

    // A condition passed directly to node (rather than through NODE_OPTIONS) must reach the chat too.
    const conditions = import.meta.resolve("@turri-dev/core/project").endsWith(".ts") ? ["--conditions=turri-source"] : [];
    const result = spawnSync(process.execPath, [...conditions, launcher, ...themes, ...useTheme, ...tuiMode, ...piArgs], {
      stdio: "inherit",
      cwd: run.cwd,
      env: {
        ...process.env,
        ...run.env,
        [REOPEN_FILE_ENV]: reopenFile,
        ...(codingModel ? { [CODING_MODEL_ENV]: codingModel } : {}),
        ...(inPi ? { TURRI_EXTENSION_IN_PI: "1" } : {}),
      },
    });
    const next = takeReopening(reopenFile);
    if (next === undefined) process.exit(result.status ?? 1);
    run = { cwd: next.dir, args: next.args, env: next.env };
  }
}

const COMMANDS: Record<string, { module: string; blurb: string; args?: string[] }> = {
  regenerate: { module: "./regenerate-cli.ts", blurb: "regenerate a module and its chain from the spec as it is (with module:func-ids: regenerate those again)" },
  drift: { module: "./drift-cli.ts", blurb: "what is left to regenerate: how far the code has drifted from its spec" },
  conform: { module: "./conform-cli.ts", blurb: "write and run a module's conformance tests" },
  parse: { module: "./parse-cli.ts", blurb: "parse ***plain - its syntax and structure, never its code or tests - regenerating nothing" },
  lineage: { module: "./lineage-cli.ts", blurb: "a module's lineage: what was regenerated into it, and when" },
  launch: { module: "./launch-cli.ts", blurb: "launch what is regenerated from dist/<module> on this machine" },
  cultivate: { module: "./cultivate-cli.ts", blurb: "run a gated skill" },
  capture: { module: "./capture-cli.ts", blurb: "capture an existing codebase into ***plain, in <path>/plain - offline, with a report of what it decided" },
};

/** Getting the machine ready, and checking it is. */
const SETUP_COMMANDS: Record<string, string> = {
  "init-config": "write a quick start config.turri.yaml here, from the vendor you use: a strong model to talk to, a smaller one to write the code",
  doctor: "check what turri needs - in a project, what it needs of this machine, and that its models answer",
};

/**
 * pi's package commands, run by pi itself: someone who installs turri has no `pi` on the PATH - npm links only turri's
 * own command - and turri reads the packages pi installs (installed-providers.ts). `update` updates packages only: pi's
 * own `update` with no source updates pi, and turri's pi is a pinned dependency (`updatesPi`).
 */
const PACKAGE_COMMANDS: Record<string, string> = {
  install: "install a pi package for every turri, -l for this project only - pi-claude-code for a Claude subscription, say",
  update: "update a pi package, or --extensions for all of them",
  remove: "remove a pi package `turri install` put in",
  list: "the pi packages installed, yours and this project's",
};

/** Whether `update <args>` would update pi itself, as pi reads it: no package named, `self` or `pi`, `--self` or `--all`. */
function updatesPi(args: string[]): boolean {
  if (args.some((arg) => arg === "--self" || arg === "--all" || arg === "self" || arg === "pi")) return true;
  if (args.some((arg) => arg === "-h" || arg === "--help" || arg === "--extensions" || arg === "--extension" || arg === "--models")) return false;
  return !args.some((arg) => !arg.startsWith("-"));
}

const USAGE = [
  "usage: turri [options]          open the conversation here: pi, with turri's tools and themes loaded",
  "       turri <command> [args]",
  "       turri --version          turri's version, and pi's",
  "",
  `  ${"options".padEnd(12)} --harness-model <m>  the model you chat with   --coding-model <m>  the model that writes the code`,
  `  ${"".padEnd(12)} --debug  keep what turri writes for debugging it - agents' logs and sessions - as debug: true does`,
  `  ${"".padEnd(12)} --use-theme <t>  another theme than turri-dark - and every option of pi's own`,
  "",
  ...Object.entries(COMMANDS).map(([name, { blurb }]) => `  ${name.padEnd(12)} ${blurb}`),
  "",
  ...Object.entries(SETUP_COMMANDS).map(([name, blurb]) => `  ${name.padEnd(12)} ${blurb}`),
  ...Object.entries(PACKAGE_COMMANDS).map(([name, blurb]) => `  ${name.padEnd(12)} ${blurb}`),
  "",
  "Run `turri <command> --help` for that command's options.",
  "",
  "Paths are relative to the current directory. Run turri from the directory holding the",
  "specification, so that linked resources inside it resolve the way the parser expects.",
].join("\n");

dropNoise();
// --debug, for any command and for the conversation: TURRI_DEBUG for this run, and the pi it starts - taken out before
// the rest is read, so a command never sees it.
const argv = withoutDebug(process.argv.slice(2));
const [command, ...rest] = argv;

function withoutDebug(args: string[]): string[] {
  const kept: string[] = [];
  for (const arg of args) {
    if (arg === "--debug") process.env.TURRI_DEBUG = "1";
    else kept.push(arg);
  }
  return kept;
}

// `turri help` too: the word people type first, which would otherwise be an unknown command.
if (command === "-h" || command === "--help" || command === "help") {
  console.log(USAGE);
  process.exit(0);
}

// turri's version, not pi's alone: pi's --version would answer for it - and where this turri is, the newest on npm,
// every turri on the PATH, and what to do when the one that runs is not the newest (turri-versions.ts).
if (command === "-v" || command === "--version") {
  const { coreVersion } = await import("@turri-dev/core/system");
  console.log(await describeVersion(versionLine(coreVersion())));
  process.exit(0);
}

// The AWS region the project's Bedrock models need, set before any model is called - unless the person set one
// (bedrock-region.ts) - for a command that calls models with no session: a session sets it itself as it opens, the chat's
// among them. The models named on the command line count too.
if (command === "doctor" || command === "capture") {
  const { applyBedrockRegion } = await import("./bedrock-region.ts");
  const named = argv.flatMap((arg, at) =>
    ["--harness-model", "--coding-model", "--model"].includes(arg) ? [argv[at + 1] ?? ""] : arg.startsWith("--harness-model=") || arg.startsWith("--coding-model=") || arg.startsWith("--model=") ? [arg.slice(arg.indexOf("=") + 1)] : [],
  );
  applyBedrockRegion(process.cwd(), { also: named.filter((model) => model !== "") });
}

// turri alone is the conversation, and so is turri with pi's options - `turri -c`, `turri --harness-model <m>`. A word
// turri does not know is an error below, not a conversation started on it.
if (command === undefined || command.startsWith("-")) chat(argv);

if (command === "init-config") {
  const { main } = await import("./init-config-cli.ts");
  process.exit(await main(rest));
}

if (command === "doctor") {
  const { main } = await import("./doctor-cli.ts");
  process.exit(await main(rest));
}

// pi's own main answers them, as `pi install` would - into the same ~/.pi/agent turri reads - and exits.
if (Object.hasOwn(PACKAGE_COMMANDS, command)) {
  if (command === "update" && updatesPi(rest)) {
    console.error("turri update updates pi packages: name one (turri update <source>), or --extensions for all of them. pi is part of turri - npm install -g @turri-dev/cli@latest updates both.");
    process.exit(1);
  }
  const { main } = await import("@earendil-works/pi-coding-agent");
  await main(argv);
  process.exit(process.exitCode ?? 0);
}

const entry = COMMANDS[command];
if (entry === undefined) {
  console.error(`unknown command: ${command}\n\n${USAGE}`);
  process.exit(1);
}

// The subcommands parse process.argv themselves, so present it as if they were invoked
// directly. Their agents are the coding agents: --coding-model is their --model.
process.argv = [
  process.argv[0]!,
  process.argv[1]!,
  ...rest.flatMap((arg) =>
    arg === "--coding-model" ? ["--model"] : arg.startsWith("--coding-model=") ? ["--model", arg.slice("--coding-model=".length)] : [arg],
  ),
  ...(entry.args ?? []),
];

// A headless run is stopped by a signal - SIGTERM, SIGHUP - whatever else listens for it: it exits, and what its agents
// left running goes with it (the core kills every process group it started on exit). Left to the libraries' own
// handlers, one ran on for minutes after it was told to stop, building in the same codebase as the run after it. Ctrl-C
// too - except where the command stops its work with it, and ends as it would: regenerate, conform, launch, cultivate.
if (!["parse", "drift", "lineage"].includes(command)) {
  const ownInterrupt = ["regenerate", "conform", "launch", "cultivate"].includes(command);
  const signals: Array<[NodeJS.Signals, number]> = [["SIGTERM", 143], ["SIGHUP", 129], ...(ownInterrupt ? [] : [["SIGINT", 130] as [NodeJS.Signals, number]])];
  for (const [signal, code] of signals) {
    process.on(signal, () => {
      console.error(`\nstopped (${signal})`);
      process.exit(code);
    });
  }
}
await import(entry.module.replace(/\.ts$/, OWN_EXTENSION));
