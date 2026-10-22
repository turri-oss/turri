import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import "./terminal-images.ts";
import { resumeLine } from "./resume-line.ts";
import { lastRun, type RunRecord } from "./chat-records.ts";
import { driveTerminal } from "./chat-terminal.ts";
import turri, { createTurriCore, processSession } from "./extension.ts";

/**
 * pi, started the way its own CLI starts it, for `turri`.
 *
 * What differs is pi's own branding, because turri shows its own: its startup header - its
 * version, key hints and the list of every loaded skill, extension and theme - its update notice
 * and its tab title. pi only takes the header from the `quietStartup` setting, and a setting would
 * quiet every `pi` on the machine, so it is answered for this run instead. `--verbose` still shows it.
 */

const args = process.argv.slice(2);

/** Set by cli.ts when pi loads turri's extension itself - an older turri installed it into every pi. */
const GLOBAL_EXTENSION = "TURRI_EXTENSION_IN_PI";
if (!args.includes("--verbose")) {
  SettingsManager.prototype.getQuietStartup = () => true;
}

// pi's "Update Available" notice is left out: the pi turri runs is its pinned dependency, which `pi update`
// does not touch - it moves when turri does.
process.env.PI_SKIP_VERSION_CHECK = "1";

// The terminal's tab title: pi writes `π - <folder>` (its APP_TITLE, a constant), turri a jellyfish and its name.
const setTitle = ProcessTerminal.prototype.setTitle;
ProcessTerminal.prototype.setTitle = function (title: string) {
  setTitle.call(this, title.replace(/^π(?= |$)/, "🪼 turri"));
};

// What pi prints on the way out to resume the session names pi - its APP_NAME, a constant - which may not be on the
// PATH at all: turri takes the same flags, so it is turri the line names.
const write = process.stdout.write.bind(process.stdout) as (chunk: unknown, ...rest: unknown[]) => boolean;
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
  write(typeof chunk === "string" ? resumeLine(chunk) : chunk, ...rest)) as typeof process.stdout.write;

// pi's own keys stand: a new line is shift+enter or ctrl+j. turri's side panel is on ctrl+h (job-panel.ts PANEL_KEY).

// What pi's CLI does before main: the process title, pi's environment markers, the HTTP
// dispatcher. Not exported, so loaded from the file - beside pi's entry point, wherever npm put it.
const setup = pathToFileURL(join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli", "setup.js")).href;
const { setupCli } = (await import(setup)) as { setupCli: () => void };
setupCli();

// turri's session, with its chats: built into pi here, in this process, rather than loaded from a file - one session
// the terminal's chats share (chats.ts). An older turri installed into every pi loads it itself: cli.ts says so, and
// it is not built in twice.
const extensionFactories = process.env[GLOBAL_EXTENSION] === "1" ? [] : [turri];

// pi's terminal - not its print, json or rpc modes, nor a run given its input on stdin - holds several chats, and
// records them for `turri --continue`, which opens them all again: the first as pi's own session, the rest beside it.
const interactive =
  process.stdin.isTTY === true && !args.some((arg) => ["-p", "--print", "--mode", "--help", "-h", "--version", "-v", "--list-models"].includes(arg) || arg.startsWith("--mode="));
if (interactive) {
  let restore: RunRecord | undefined;
  const asked = args.findIndex((arg) => arg === "--continue" || arg === "-c");
  const saved = asked !== -1 ? lastRun(process.cwd()) : undefined;
  if (saved !== undefined) {
    args.splice(asked, 1, "--session", saved.chats[0]!.sessionFile);
    restore = saved;
  }
  driveTerminal(
    processSession(() => createTurriCore({}, { persist: true })),
    restore !== undefined ? { restore } : {},
  );
}

await main(args, { extensionFactories });
