import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeExport, holderOf, launchLogDir, runningLaunched, shortPath, startLaunched, type ExportedCode } from "./regenerate/launch.ts";
import { machineChange, machineChangeReason } from "./regenerate/command-check.ts";
import { projectDirOf } from "./regenerate/paths.ts";
import { ask, BEGIN, createExecutor } from "./pi.ts";
import type { Launch, LaunchOutcome } from "./launch-track.ts";

/**
 * The launch agent: every launch's - the chat's launch tool, a pulse that landed under `launch-after-pulse`, and
 * `turri launch`. The harness has put the commit's code in dist/<module> already; the agent finds out how it runs - or
 * the project's guidance for launching it, which it follows from the host codebase - installs what it needs, starts what
 * keeps running with activate, and says how it went with submit_launch. It asks no one.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = ToolDefinition<any, any, any>;

/**
 * The person's own shell, in the host codebase: it installs what the launch needs into the project, and runs it. It
 * changes nothing of the machine's - no toolchain installed, no system setting changed: a command that would is refused.
 */
export function launchShell(dir: string): AnyTool {
  const bash: AnyTool = createBashToolDefinition(dir);
  return {
    ...bash,
    description: `${bash.description}\n\nIt runs on the person's own machine, in ${shortPath(dir)}. Never start a server here: activate does. It installs nothing on the machine and changes none of its settings: what the machine lacks, the person installs.`,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const changes = machineChange(String((params as { command?: unknown }).command ?? ""));
      if (changes !== undefined) throw new Error(machineChangeReason(changes));
      return bash.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/** A file tool that writes, refused inside plain_modules: the built code is the ***plain's to change, never a launch's. */
function outsideBuiltCode(tool: AnyTool, dir: string): AnyTool {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const path = resolve(dir, String((params as { path?: unknown }).path ?? ""));
      if (relative(dir, path).split(sep).includes("plain_modules")) {
        throw new Error(`Not written: ${shortPath(path)} is built code. A launch never changes it - a fix belongs in the ***plain.`);
      }
      // The ***plain - a module, a test plain file - is the person's: a launch that finds it wrong says so, never rewrites it.
      if (path.endsWith(".plain")) {
        throw new Error(`Not written: ${shortPath(path)} is ***plain. A launch never changes it - say what is wrong with it instead.`);
      }
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

function shown(file: string, max = 40_000): string {
  const text = readFileSync(file, "utf8");
  const body = text.length > max ? `${text.slice(0, max)}\n… [the rest of ${shortPath(file)} is not shown]` : text;
  return `<file path="${shortPath(file)}">\n${body.trimEnd()}\n</file>`;
}

/**
 * What the project says of itself, for the agent to find launch guidance in: its AGENTS.md and its skills
 * (`.agents/skills`, `.pi/skills`, `.claude/skills`), where turri runs and in the host codebase - once each, whole.
 */
export function projectNotes(dirs: string[]): string[] {
  const roots = [...new Set(dirs.map((dir) => resolve(dir)))];
  const files = new Set<string>();
  for (const root of roots) {
    const agents = join(root, "AGENTS.md");
    if (existsSync(agents)) files.add(agents);
    for (const skills of [".agents/skills", ".pi/skills", ".claude/skills"].map((folder) => join(root, folder))) {
      if (!existsSync(skills)) continue;
      for (const name of readdirSync(skills)) {
        const skill = join(skills, name, "SKILL.md");
        if (existsSync(skill)) files.add(skill);
      }
    }
  }
  return [...files].map((file) => shown(file));
}

function text(value: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: value }], details };
}

/** The folder a command runs in: in dist, or - `from: host` - in the host codebase; a folder inside either. */
function inside(root: string, dir: string | undefined): string {
  const target = resolve(root, dir ?? ".");
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${dir} is outside ${shortPath(root)}: what activate starts runs from there, or a folder inside it.`);
  return target;
}

/**
 * activate: start what keeps running - a backend, a frontend's dev server - owned by the harness: in its own process
 * group, its output kept, stopped on the codebase's next launch, on /halt and when turri exits.
 */
export function activateTool(launch: Pick<Launch, "codebase" | "plainFile" | "hostDir">, code: Pick<ExportedCode, "dir">): AnyTool {
  return defineTool({
    name: "activate",
    label: "Activate",
    description:
      "Start something that keeps running - a backend, a frontend's dev server - on this machine: in the background, its " +
      "output kept, stopped on the next launch, on /halt and when turri exits. With `url`, waits until something answers " +
      "there and says so, or shows the end of its output. A port something else holds is said, and nothing is started.",
    promptSnippet: "start a server of the launched code, and wait for it to answer",
    parameters: Type.Object({
      name: Type.String({ description: "A short name for it: backend, frontend, app" }),
      command: Type.String({ description: "The command that starts it, as run from its folder" }),
      url: Type.Optional(Type.String({ description: "Where it serves, e.g. http://localhost:5173 - it is ready once this answers" })),
      from: Type.Optional(
        Type.Union([Type.Literal("dist"), Type.Literal("host")], {
          description: `Where dir is named from: dist, the launched code (${shortPath(code.dir)}) - the default; host, the host codebase (${shortPath(launch.hostDir)}), when guidance says to start it there.`,
        }),
      ),
      dir: Type.Optional(Type.String({ description: "The folder to run it in, inside the one `from` names - e.g. frontend. Default: that folder itself." })),
    }),
    async execute(_id, params) {
      const root = params.from === "host" ? launch.hostDir : code.dir;
      const started = await startLaunched({
        name: params.name,
        command: params.command,
        dir: inside(root, params.dir),
        root,
        moduleName: launch.codebase,
        logDir: launchLogDir(projectDirOf(launch.plainFile)),
        ...(params.url !== undefined ? { url: params.url } : {}),
      });
      return text(started.text, { ok: started.ok, ...(started.process !== undefined ? { pid: started.process.pid, log: started.process.log } : {}) });
    },
  });
}

/** The ports of the URLs a summary names. */
function portsIn(summary: string): number[] {
  const ports = new Set<number>();
  for (const match of summary.matchAll(/\bhttps?:\/\/[^\s/"'`)<>]+/g)) {
    try {
      const url = new URL(match[0]);
      ports.add(url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80);
    } catch {
      /* not a URL after all */
    }
  }
  return [...ports];
}

/**
 * Why a launch said to be up is not: it says something serves - `serves`, or a URL in its summary - and nothing this
 * launch started with activate still runs. Something else answering there - an earlier build left running, another
 * program - is not this launch. Undefined when it holds.
 */
export function notBacked(launch: Pick<Launch, "codebase" | "serversSince">, outcome: { launched: boolean; summary: string; serves?: boolean }): string | undefined {
  if (!outcome.launched) return undefined;
  const ports = portsIn(outcome.summary);
  if (outcome.serves !== true && ports.length === 0) return undefined;
  const since = launch.serversSince ?? 0;
  if (runningLaunched(launch.codebase).some((item) => item.startedAt >= since)) return undefined;
  const holders = ports.map((port) => ({ port, holder: holderOf(port) })).filter((each) => each.holder !== "");
  return [
    `nothing this launch started with activate is running, so what answers${ports.length > 0 ? ` at port ${ports.join(", ")}` : ""} is not this launch's code${holders.length > 0 ? " - it is held by something else:" : "."}`,
    ...holders.map((each) => `port ${each.port}:\n${each.holder}`),
  ].join("\n");
}

/** submit_launch: how the launch went, once, last - the harness reads its arguments, never the agent's prose. */
function submitLaunchTool(launch: Pick<Launch, "codebase" | "serversSince">, submitted: { outcome?: LaunchOutcome & { serves?: boolean } }): AnyTool {
  return defineTool({
    name: "submit_launch",
    label: "Submit launch",
    description:
      "Say how the launch went - once, last. launched: true when it is running, or in place for the person to try - a CLI " +
      "or a library ready to run from its folder; false when it is not. The summary is what the person is told: where to " +
      "open it, or what to run - or why it did not come up, and what they can do. Something that serves counts as running " +
      "only when you started it with activate and it still runs: something else answering at its port - an earlier build, " +
      "another program - is not it, and is refused.",
    parameters: Type.Object({
      launched: Type.Boolean({ description: "true: it runs, or is in place to try; false: it did not come up" }),
      serves: Type.Boolean({ description: "true: something keeps running for the person to open or call - a backend, a frontend; false: a CLI or a library, tried from its folder" }),
      summary: Type.String({ description: "In a line or three: where it runs - the URL to open, the API's in a line - or the commands to try it; or why it did not come up" }),
    }),
    async execute(_id, params) {
      const why = notBacked(launch, params);
      if (why !== undefined) {
        throw new Error(
          `Not taken: you say it runs, but ${why}\nStart it with activate - stopping nothing turri did not start - or call submit_launch with launched false, saying what holds the port.`,
        );
      }
      submitted.outcome = { launched: params.launched, summary: params.summary, serves: params.serves };
      return text("Taken. You are done: end your turn.");
    },
  });
}

/** What the agent does once the code is in dist: find guidance and follow it from the host, or start it from dist. */
export function launchGuide(code: ExportedCode, hostDir: string): string {
  const dist = shortPath(code.dir);
  const host = shortPath(hostDir);
  const built = shortPath(code.buildDir);
  return [
    "First ask yourself: is there guidance for how this project launches it - what the person said, the project's notes and",
    "skills below, or anything else you find? An integration a host application loads, say, put in place with the host's own",
    "scripts. Then:",
    "",
    `Without guidance - start it from ${dist}, as best it can be:`,
    `1. Find out how it runs: its README, its manifests (package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml, pom.xml, build.gradle, docker-compose.yml) and entry points, in ${dist}.`,
    "2. Check the toolchains it needs are on this machine (`command -v node`, `python3 --version`, `go version`, ...) - under another name too: python where python3 is not, of the version it needs. One missing: you install nothing on the machine and change none of its settings - stop, and say exactly what to install, the command the person runs themselves (`brew install node`), and that launching again picks it up.",
    "3. Install what it needs into the project yourself, in your shell - dependencies into a virtual environment or node_modules, a build that fetches packages, an image pull. Do not ask: do it, and fix what fails - within the project: never a global install, never a system setting.",
    "4. Start anything that keeps running - a backend, a frontend's dev server - with activate, with the URL it serves at: never in the shell with & or nohup. An app with a backend and a frontend: start both, the backend first.",
    "",
    `With guidance - follow it, on this machine, from the host codebase ${host}:`,
    `1. The code to launch is in ${dist}: the commit, whole. Take it from there, never from ${built}, where a pulse may be writing - always: where the guidance's own tooling reads ${built}, point it at ${dist} if it can take another source; if it cannot, do by hand, from ${dist}, what it does.`,
    `2. Read what the guidance leaves open - the scripts, files and commands it names, in ${host} - then do what it says, in its order. Where it says to change the host - a registration, an import, a config entry - change it.`,
    "3. Run the project's scripts and install what it needs into the project yourself, in your shell. A toolchain or system tool the machine lacks you never install, nor change a setting of the machine's: say the command the person runs themselves.",
    "4. Start what keeps running - a start script, a dev server - with activate (from: host when it runs in the host codebase), with the URL it serves at - never in the shell with & or nohup.",
    "",
    `Either way, never change ${built} or ${dist}: they are what was built, and a fix belongs in the ***plain. A config file it needs made from its example (a .env from .env.example) is fine. A port that is taken: say which and by what, and do not move the app to another.`,
    "",
    "Last, call submit_launch once: launched, whether it serves, and in a line or three where to open it - the frontend's URL,",
    "and the API's in one line when there is one - or, a CLI or a library, a few commands to paste, run from its folder, with",
    "what they print; or why it did not come up. Where the guidance does not fit what you find, say so, and do not guess past it.",
    "Something answering at the app's port that you did not start with activate - an earlier build left running, another",
    "program - is not this launch: it is not launched, and you say what holds the port. Never stop a process you did not start.",
  ].join("\n");
}

export interface LaunchAgentInput {
  launch: Launch;
  /** Its code, exported to dist already. */
  code: ExportedCode;
  /** Where turri runs. */
  cwd: string;
  /** The agent's model: the coding model of the codebase. */
  model?: string;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

/** Run the launch agent to its end: how it went, as it submitted it - or, never submitted, its last words as a failure. */
export async function runLaunchAgent(input: LaunchAgentInput): Promise<LaunchOutcome> {
  const { launch, code } = input;
  const dir = launch.hostDir;
  const notes = projectNotes([input.cwd, dir, projectDirOf(launch.plainFile)]);
  const fileTools: AnyTool[] = [
    createReadToolDefinition(dir),
    createLsToolDefinition(dir),
    createGrepToolDefinition(dir),
    createFindToolDefinition(dir),
    // Guidance may say to change the host - a registration, an import.
    outsideBuiltCode(createEditToolDefinition(dir), dir),
    outsideBuiltCode(createWriteToolDefinition(dir), dir),
  ];
  const submitted: { outcome?: LaunchOutcome & { serves?: boolean } } = {};
  const tools = [activateTool(launch, code), submitLaunchTool(launch, submitted)];
  const executor = await createExecutor({
    // Its sessions are kept in the project, not in the folder it launches.
    cwd: projectDirOf(launch.plainFile),
    customTools: [...fileTools, launchShell(dir), ...tools],
    tools: [...fileTools.map((tool) => tool.name), "bash", ...tools.map((tool) => tool.name)],
    ...(input.model !== undefined ? { model: input.model } : {}),
    role: "launch",
    system: [
      "You get software that was just built running on the person's own machine, so they and turri's sentinel can try it. You ask no one: do it.",
      `Your file tools and your shell start in ${dir}. Your shell is the person's own - not a sandbox.`,
    ].join("\n"),
    task: [
      "pulse" in launch.cause
        ? `A pulse of ${launch.codebase} just landed: ${launch.cause.title}. The project launches what every pulse lands: launch it now, whether or not the guidance speaks of launching after a build - what the guidance says is how.`
        : `Launch ${launch.codebase} for the person to try.`,
      "",
      describeExport(code),
      "",
      launchGuide(code, dir),
      ...(launch.inModule !== undefined ? ["", `It is the codebase of module ${launch.inModule}.`] : []),
      ...(launch.guidance !== undefined ? ["", "What the person said of how to launch it:", launch.guidance] : []),
      ...(notes.length > 0 ? ["", "The project's notes and skills:", ...notes] : []),
    ].join("\n"),
  });
  const stop = () => void executor.abort();
  input.signal?.addEventListener("abort", stop, { once: true });
  // What it said is checked again as it ends: a server it started may have exited since.
  const checked = (outcome: LaunchOutcome & { serves?: boolean }): LaunchOutcome => {
    const why = notBacked(launch, outcome);
    return why !== undefined ? { launched: false, summary: `Not launched: the launch agent said it runs, but ${why}` } : { launched: outcome.launched, summary: outcome.summary };
  };
  try {
    const said = await ask(executor, BEGIN, input.onDelta);
    if (submitted.outcome !== undefined) return checked(submitted.outcome);
    // Ended without saying how it went: asked once more, then taken as not launched.
    const again = await ask(executor, "Call submit_launch now: launched or not, and in a line or three where it runs or why it did not come up.", input.onDelta);
    return submitted.outcome !== undefined ? checked(submitted.outcome) : { launched: false, summary: (again.trim() || said.trim() || "The launch agent ended without saying how it went.") };
  } finally {
    input.signal?.removeEventListener("abort", stop);
    executor.dispose();
  }
}
