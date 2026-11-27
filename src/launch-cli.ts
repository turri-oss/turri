import { resolve } from "node:path";
import { createTurri, launchText } from "@turri-dev/core";
import { readProjectConfig } from "@turri-dev/core/project";
import { clientInfo } from "./cli-root.ts";
import { c } from "./module-report.ts";

const USAGE = `usage: turri launch [file.plain] [options]

Launches the module on top of the spec's requires chain, which holds the code of the ones below, and
has an agent start it here, on this machine. The module's code, as its last commit has it, always
goes in dist/<module> first. The agent looks for guidance on how this project launches it - what
--guidance says, the project's AGENTS.md - and follows it from there when there is some: an
integration its host application takes with the host's own scripts, say. When there is none, it
reads how the code in dist runs, installs what it needs, and starts what serves. Either way it asks
nothing, and stays in the foreground with the servers' output; Ctrl-C stops them.

The project's config.turri.yaml gives the defaults: module (the file when none is given) and
coding-model (the agent's model).

  --in-module <module>     the codebase to take, when modules built on this one branch
  --guidance <text>        how this project launches it: the scripts to run, in order
  --model <provider/id>    the agent's model (default: coding-model)`;


const PROBLEMS = "If you are having problems, launch it from the chat: run turri and ask to try it.";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let model: string | undefined;
  let inModule: string | undefined;
  let guidance: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--model" || arg === "--harness-model") model = argv[++i];
    else if (arg === "--in-module") inModule = argv[++i];
    else if (arg === "--guidance") guidance = argv[++i];
    else if (arg.startsWith("-")) {
      console.error(`unknown option: ${arg}\n\n${USAGE}`);
      process.exit(1);
    } else positional.push(arg);
  }
  return { plainFile: positional[0], model, inModule, guidance };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const named = args.plainFile ?? readProjectConfig(process.cwd()).module;
  if (named === undefined) {
    console.error(`${USAGE}\n\nNo file given, and config.turri.yaml names no module.`);
    process.exit(1);
  }
  const plainFile = resolve(named);
  // A session with no front end: the launch agent runs on its coding model - the config's, or --model.
  const turri = await createTurri({ client: clientInfo("launch"), ...(args.model !== undefined ? { overrides: { codingModel: args.model } } : {}) });
  // ctrl+c: everything the launch started stopped - and the launch itself, while it is under way - and turri leaves.
  const stopping = new AbortController();
  process.on("SIGINT", () => {
    if (stopping.signal.aborted) process.exit(130);
    stopping.abort();
    void turri.work
      .halt({ launched: "all" })
      .then((said) => console.log(c.dim(`\n${said}`)))
      .finally(() => void turri.dispose().then(() => process.exit(0)));
  });

  try {
    console.log(c.dim(`\nworking out how to start it${args.model !== undefined ? ` (${args.model})` : ""}…\n`));
    // The code exported first, then the agent, its words as they come.
    let streamed = "";
    const ended = await turri.launches.launch(plainFile, {
      ...(args.inModule !== undefined ? { inModule: args.inModule } : {}),
      ...(args.guidance !== undefined ? { guidance: args.guidance } : {}),
      onOutput(text) {
        streamed += text;
        process.stdout.write(text);
      },
      signal: stopping.signal,
    });
    // What the agent said as it went is on the screen already: its summary only when it said nothing - what turri stopped
    // for it, always.
    const text = launchText(streamed.trim() === "" ? ended : { ...ended, summary: undefined });
    const said = text !== "" ? `\n${text}` : "";
    console.log(`\n\n${ended.status === "launched" ? c.success(`Launched.${said}`) : c.error(`It did not come up.${said}`)}`);
    if (ended.status !== "launched") console.log(`\n${c.dim(PROBLEMS)}`);

    if (turri.launches.running().length === 0) return ended.status === "launched" ? 0 : 1;
    console.log(c.success(c.bold("\nRunning - Ctrl-C stops it.")) + c.dim(" Its output follows.\n"));
    await turri.launches.followLogs((name, line) => console.log(`${c.accent(`[${name}]`)} ${line}`), { signal: stopping.signal });
    if (stopping.signal.aborted) return new Promise<never>(() => {});
    console.log(c.dim("Everything it started has ended."));
    return 0;
  } catch (error) {
    if (stopping.signal.aborted) return new Promise<never>(() => {});
    console.error(error instanceof Error ? error.message : error);
    console.error(`\n${PROBLEMS}`);
    return 1;
  } finally {
    // Leaving with ctrl+c, the handler above lets the session go once what it started is stopped.
    if (!stopping.signal.aborted) await turri.dispose();
  }
}

process.exit(await main());
