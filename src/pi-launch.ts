import "./terminal-images.ts";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { createTurri, type Turri } from "@turri-dev/core";
import { lastRun } from "@turri-dev/core/project";
import { withoutResumeLine } from "./resume-line.ts";
import { chatModels } from "./chat-models.ts";
import { driveTerminal } from "./chat-terminal.ts";
import { clientInfo } from "./cli-root.ts";
import { setProcessTurri } from "./extension.ts";
import { takeOverSettings } from "./pi-settings.ts";
import { adoptAsBound } from "./print-mode.ts";
import { quietBrandThemeOverrides } from "./pi-themes.ts";
import { takeCaptured } from "./reopen.ts";
import { createTerminal } from "./terminal-view.ts";

/**
 * pi, started the way its own CLI starts it, for `turri`.
 *
 * What differs is pi's own branding, because turri shows its own: its startup header - its
 * version, key hints and the list of every loaded skill, extension and theme - its update notice
 * and its tab title. pi only takes the header from the `quietStartup` setting, and a setting would
 * quiet every `pi` on the machine, so it is answered for this run instead. `--verbose` still shows it.
 */

// turri's own options - the two models - taken out of pi's arguments, as the session's overrides (chat-models.ts).
const { piArgs: args, overrides } = chatModels(process.argv.slice(2));

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

// Leaving turri leaves the terminal as it was, the command run its only trace. pi's fullscreen screen - its default -
// writes the conversation out to the terminal on the way out, unless its `fullscreenExitOutput` is `resume-hint`, which
// is answered for this run as `quietStartup` is; the line it prints instead, to resume the session, is left out too:
// `turri --continue` opens the last run again.
SettingsManager.prototype.getFullscreenExitOutput = () => "resume-hint";

// /settings is turri's, pi's own menu the last entry of it (pi-settings.ts).
takeOverSettings();
quietBrandThemeOverrides();
const write = process.stdout.write.bind(process.stdout) as (chunk: unknown, ...rest: unknown[]) => boolean;
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
  write(typeof chunk === "string" ? withoutResumeLine(chunk) : chunk, ...rest)) as typeof process.stdout.write;

// pi's own keys stand: a new line is shift+enter or ctrl+j. turri's side panel is on ctrl+h (job-panel.ts PANEL_KEY).

// What pi's CLI does before main: the process title, pi's environment markers, the HTTP
// dispatcher. Not exported, so loaded from the file - beside pi's entry point, wherever npm put it.
const setup = pathToFileURL(join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli", "setup.js")).href;
const { setupCli } = (await import(setup)) as { setupCli: () => void };
setupCli();

// pi's terminal - not its print, json or rpc modes, nor a run given its input on stdin - holds several chats, and
// records them for `turri --continue`, which opens them all again: the first as pi's own session, the rest beside it.
const interactive =
  process.stdin.isTTY === true && !args.some((arg) => ["-p", "--print", "--mode", "--help", "-h", "--version", "-v", "--list-models"].includes(arg) || arg.startsWith("--mode="));

// turri's session - one a process - opened before pi's main, on this folder's project. The terminal is its front end: its
// chats made on pi's screen, its questions asked in turri's dialog, regen and the inbox drawn from its events. Print, json
// and rpc modes run one chat with nobody to ask: a session with no front end, whose extension pi builds into its one
// session - no other chat, no sentinel, nothing recorded for `turri --continue`.
let turri: Turri;
if (interactive) {
  let restore = false;
  const asked = args.findIndex((arg) => arg === "--continue" || arg === "-c");
  const saved = asked !== -1 ? lastRun(process.cwd()) : undefined;
  // pi reopens the first of the person's chats as its own; the rest - the sentinel among them - are opened beside it.
  // With none of the person's chats saved - only the sentinel's - pi starts a fresh one, and every saved chat is
  // opened beside it.
  const first = saved?.chats.find((chat) => chat.role === undefined);
  if (saved !== undefined) {
    if (first !== undefined) args.splice(asked, 1, "--session", first.sessionFile);
    else args.splice(asked, 1);
    restore = true;
  }
  const terminal = createTerminal();
  const captured = takeCaptured();
  turri = await createTurri({
    frontend: { ...terminal.frontend, sessions: driveTerminal(terminal, { restore }) },
    client: clientInfo("chat"),
    overrides,
    // Opened again in the project a capture wrote (reopen.ts): its report, told in the first chat.
    ...(captured !== undefined ? { captured } : {}),
  });
  terminal.attach(turri);
} else {
  // pi's own mode, as its arguments name it: json or rpc with --mode, else print.
  const modeAt = args.indexOf("--mode");
  const mode = args.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length) ?? (modeAt !== -1 ? args[modeAt + 1] : undefined) ?? "print";
  turri = await createTurri({ client: clientInfo(mode), overrides, persist: false });
  adoptAsBound(turri);
}
setProcessTurri(turri);

// turri built into pi here, in this process, rather than loaded from a file. An older turri installed into every pi
// loads it itself (extension.ts finds this session): cli.ts says so, and it is not built in twice.
const extensionFactories = process.env[GLOBAL_EXTENSION] === "1" ? [] : [turri.extension];

await main(args, { extensionFactories });
