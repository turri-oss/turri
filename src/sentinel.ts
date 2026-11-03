import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readConfigFile, readProjectConfig, type SentinelSetting } from "./config.ts";
import { confinedTools } from "./regenerate/confine.ts";
import { describeSpecConflict } from "./regenerate/stop-report.ts";
import { didNotPass } from "./regenerate/job-panel.ts";
import { formatDuration, pulseName, type Job } from "./regenerate/jobs.ts";
import { readLedger } from "./regenerate/ledger.ts";
import { describePulseView, pulseView } from "./regenerate/ledger-view.ts";
import { MODULES_DIR, ensureInScratch } from "./regenerate/paths.ts";
import type { DeployedProcess } from "./regenerate/release.ts";
import { SENTINEL, SENTINEL_START, wentWrong, type Conclusion, type Notice, type NoticeInput, type SentinelCheck } from "./notice.ts";
import type { CheckedSpec } from "./sentinel-check.ts";

export * from "./notice.ts";

/**
 * The sentinel: a chat of the session's own that every finished pulse goes to (docs/sentinel.md). It checks how each
 * pulse went - and, with `release-after-pulse` on, tests what was released - finds out why when something is wrong, and
 * puts it to the person as a notice in the chat they look at, with what they can do about it. It changes nothing: its
 * file tools only read, its shell runs with the project read only, and it has none of the tools that change ***plain or
 * start work. The chat the person talks to is never interrupted for a pulse that went well.
 */

/** Whether the project wants a sentinel: `sentinel:` in config.turri.yaml - true, false, or ask, as it is unset. */
export function sentinelSetting(cwd: string): SentinelSetting {
  try {
    return readProjectConfig(cwd).sentinel ?? "ask";
  } catch {
    return "ask";
  }
}

/**
 * What the person is asked before the sentinel first opens in a session, under `sentinel: ask`, in one sentence: the pulse
 * - or the host's check - that would open it and what it does - so a tab that starts working on its own is not a surprise
 * - and whether to start it.
 */
export function sentinelStartNotice(about: Job | SentinelCheck, cwd: string): NoticeInput {
  let released = false;
  try {
    released = readProjectConfig(cwd).releaseAfterPulse === true;
  } catch {
    /* a config that cannot be read releases nothing */
  }
  const what = `a background tab that reviews each finished pulse${released ? " and tries to use what was released" : ""}`;
  if (!("kind" in about)) {
    return {
      kind: "sentinel-start",
      severity: "info",
      summary: `Checking ${about.funcIds.join(", ")} of ${about.module} needs the sentinel, ${what} - start it?`,
      evidence: [],
      actions: [
        { label: SENTINEL_START.start, task: "The sentinel is started for this session: this check, and each pulse after it, go to it." },
        { label: SENTINEL_START.always, task: "The sentinel is started, and sentinel: true written to config.turri.yaml: it opens without asking from now on." },
        { label: SENTINEL_START.notNow, task: "No sentinel this session: the check is not done. turri asks again next time." },
        { label: SENTINEL_START.never, task: "sentinel: false written to config.turri.yaml: no sentinel, and no asking." },
      ],
      module: about.module,
      check: about.id,
    };
  }
  const job = about;
  return {
    kind: "sentinel-start",
    severity: "info",
    summary: `${pulseName(job)} finished - start the sentinel, ${what}?`,
    evidence: [],
    actions: [
      { label: SENTINEL_START.start, task: "The sentinel is started for this session: this pulse and each after it go to it." },
      { label: SENTINEL_START.always, task: "The sentinel is started, and sentinel: true written to config.turri.yaml: it opens without asking from now on." },
      { label: SENTINEL_START.notNow, task: "No sentinel this session: each pulse is told to the chat that asked for it. turri asks again next time." },
      { label: SENTINEL_START.never, task: "sentinel: false written to config.turri.yaml: no sentinel, and no asking." },
    ],
    job: job.id,
    ...(job.pulse !== undefined ? { pulse: job.pulse } : {}),
  };
}

/** A pulse that stopped on ***plain that contradicts itself: put to the person by turri itself, the way out the chat's to work out. */
export function specConflictNotice(job: Job, task: string): NoticeInput {
  return {
    severity: "warning",
    summary: `${pulseName(job)} stopped: two functional specs contradict each other`,
    evidence: describeSpecConflict(job.specConflict!).split("\n").filter((line) => line.trim() !== ""),
    actions: [{ label: "Work out the conflict with me", task }],
    ...(job.module !== undefined ? { module: job.module } : {}),
    job: job.id,
    ...(job.pulse !== undefined ? { pulse: job.pulse } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// The person's guidance: what they told the sentinel, kept apart from its conversation.

export function guidanceFile(cwd: string): string {
  const scratch = join(cwd, ".turri");
  ensureInScratch(scratch, scratch);
  return join(scratch, "sentinel.md");
}

export function readGuidance(cwd: string): string {
  try {
    const file = join(cwd, ".turri", "sentinel.md");
    return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  } catch {
    return "";
  }
}

export function keepGuidance(cwd: string, text: string): void {
  const line = text.replace(/\s+/g, " ").trim();
  if (line === "") return;
  appendFileSync(guidanceFile(cwd), `- ${line} (${new Date().toISOString().slice(0, 16).replace("T", " ")})\n`);
}

// ---------------------------------------------------------------------------------------------
// What the sentinel is told.

/**
 * What a chat of the person's is told of the pulses that end: told itself, of those asked for in it - or, with the
 * sentinel on, nothing, the sentinel telling the person what needs them.
 */
export function pulseEndsBlock(sentinel: boolean): string {
  return sentinel
    ? [
        "<pulse-ends>",
        "The sentinel - a chat of my own, beside this one - checks every pulse that finishes and tests what was released.",
        "When a pulse lands, the chat the person is in is told, to tell them it landed and what the sentinel does with it -",
        "and nothing more: the pulse is the sentinel's. A pulse that went wrong you are not told of. What needs the person, the",
        "sentinel puts to them as a notice in the chat they are in: what is wrong, and what can be done. When they accept",
        "one, you are given it, and what they chose: do it.",
        "</pulse-ends>",
      ].join("\n")
    : "<pulse-ends>\nWhen a pulse asked for in this chat ends, you are told, and react to it.\n</pulse-ends>";
}

/**
 * What the chat the person is in is told of a pulse that landed, with the sentinel on: that it landed, what the sentinel
 * does with it - and to tell the person so, and do nothing else about it.
 */
export function landedNote(job: Job, released: DeployedProcess[], options: { shown?: boolean } = {}): string {
  const wasReleased = (job.details as { released?: unknown } | undefined)?.released === true;
  const where = released.map((item) => `${item.name} at ${item.url ?? item.command}`).join(", ");
  // The host showed the person the pulse's end itself: what happened, for when they ask - nobody is told anything now.
  if (options.shown === true) {
    return [
      `Pulse ${job.id} - ${pulseName(job)} - landed, after ${formatDuration(job)}.`,
      "",
      (job.report ?? "").trim(),
      "",
      `The sentinel - a chat of my own beside this one - checked it after it landed${wasReleased ? `, and tested what was released${where !== "" ? ` (${where})` : ""}` : ""}; the person was shown that it landed. The pulse is the sentinel's: nothing is to be tested, released, opened or run for it here.`,
    ].join("\n");
  }
  return [
    `Pulse ${job.id} - ${pulseName(job)} - landed, after ${formatDuration(job)}.`,
    "",
    (job.report ?? "").trim(),
    "",
    `The sentinel - a chat of my own beside this one - is checking it now${wasReleased ? `, and testing what was released${where !== "" ? ` (${where})` : ""}` : ""}. If it finds something wrong, it puts it to the person in the chat they are in, with what can be done; when it is done, you are told.`,
    "",
    `Tell the person, in a line or two, what landed and that the sentinel is checking it${wasReleased ? " and testing the release" : ""}. Do nothing else about it: the pulse is the sentinel's now. Do not test it, release it, open it, run anything for it, or start other work because of it - whatever the project's guidance says to do when a pulse finishes.`,
  ].join("\n");
}

/**
 * Its identity and its task, in its system prompt in place of the conversation's. A host's `surface` - where the person
 * watches it, in the host's words - stands in place of their not watching, and has it try a release with the host's tools.
 */
export function sentinelPrompt(cwd: string, options: { extraTools?: string[]; surface?: string } = {}): string {
  const guidance = readGuidance(cwd);
  const tools = options.extraTools ?? [];
  const surface = options.surface?.trim() ?? "";
  const theirs = tools.length > 0 ? tools.join(", ") : "the host's tools";
  return [
    "<sentinel>",
    "You are turri's sentinel: a chat of turri's own, beside the chats the person talks to while they build their software",
    "with turri. Every pulse that finishes comes to you, each in a conversation of its own - and functional specs the person",
    "asks you to check. This conversation is for the pulse, or the check, in the message turri writes first. For a pulse:",
    "what it was, how it ended,",
    ...(surface === ""
      ? ["its ***plain diff, its log, and what was released. The person does not watch you: they are in another chat, and", "hear from you only through notify_person."]
      : [
          "its ***plain diff, its log, and what was released. The person can watch you try a release, where the host shows it;",
          "they talk to you in another chat, and hear what you find only through notify_person.",
        ]),
    "",
    "For the pulse:",
    "1. Check how it went, from what turri tells you - and, when that is not enough, its log, the ledger (ledger, pulses),",
    "   diagnose, and the code and the ***plain, which you read.",
    "2. When it was released (the message says so - release-after-pulse is on), test what was released: it is running",
    "   where the message says. How far you test is yours to judge, from what the pulse changed and what the ***plain says",
    "   it should do: that it came up, answers, and does what its ***plain diff says it now does.",
    "3. When something is wrong - the pulse failed or stopped, it did not pass, the release did not come up, the software",
    "   does not do what its ***plain says - find out why. Then:",
    "   - When it is the project's tooling - a testing script, or where config.turri.yaml says the scripts are and which",
    "     toolchain folders the agents may read (toolchains:) - fix it yourself, with edit: a script calling python3 where",
    "     this machine has python of the version the ***plain names, a path that moved, a flag the tool's version does not",
    "     take. Check what you rely on in your shell first (`command -v python`, `python --version`). Then call resume for",
    "     the module, so the work runs again with the fix - and notify_person once, fixed: true, severity info, no actions:",
    "     what you changed and why, the lines before and after in the evidence.",
    "   - Anything else, call notify_person once: what is wrong, what shows it, and what the person can do about it, each",
    "     a task the agent of their chat can carry out once they accept it - a change to the ***plain, a credential to",
    "     provide, a pulse to regenerate again. Be exact: the task is all that agent is given. What the machine lacks - a",
    "     toolchain, a tool, a system library - and any setting of the machine's or the person's shell: say exactly what",
    "     the person runs themselves (`brew install node`), and make the action resuming once they have.",
    "   When it is a gap in the ***plain the build settled with an assumption - something the person may reasonably leave",
    "   as it is - say so with ignorable: the gap in the summary, what the build does in the evidence. Never for",
    "   something broken, a pulse that went wrong, or a release that did not come up.",
    "4. When all is well, notify no one.",
    "5. Last, call conclude once for it - holds or wrong, and in a line or two what you checked and what you found:",
    "   the chat the person is in is told, whether all is well or not. Then say the same here, in a line or two.",
    "",
    "For a check: the person picked functional specs of a module for you to test in its release, which runs where the",
    "message says. Test those - what each says and its scenarios - not the module's other functional specs. Notify the",
    "person of what does not do what its ***plain says, as for a pulse, and call conclude once for the check, by its id.",
    "",
    "You fix the project's tooling and nothing else. Your file tools read the whole project; write and edit reach only the",
    "testing scripts and config.turri.yaml - and in it only where the scripts are, and toolchains:. Your shell runs with",
    "the project read only. You never change ***plain - it is the person's intent, never yours to fix - and never steer,",
    "release, or regenerate but by resume after a fix of yours. You install nothing on this machine and change none of",
    "its settings, nor the person's shell - under no circumstances: that is always the person's, said in a notice. You",
    "never ask the person questions - a notice is how you reach them.",
    "",
    "The person can talk to you here. When they tell you how to check - what to test, what to leave alone, where things",
    "run - keep it with keep_guidance, in their words, so it holds from now on: this conversation ends with its pulse,",
    "and the next pulse's starts afresh, with only what you kept. What the person chose to leave as the build has it is",
    "in your guidance too: do not raise it again, unless the build no longer does what they accepted.",
    ...(surface !== ""
      ? [
          "",
          "Where the person watches you, in the host's words:",
          "<surface>",
          surface,
          "</surface>",
          `Try a release with ${theirs}, where the person can watch. Keep your shell for what those cannot show - logs, exit`,
          "codes, files.",
        ]
      : tools.length > 0
        ? ["", `The host gives you ${theirs} to test with as well.`]
        : []),
    "</sentinel>",
    ...(guidance !== "" ? ["", "<guidance>", "What the person told you to keep in mind:", guidance, "</guidance>"] : []),
  ].join("\n");
}

/** What the sentinel is told of one finished pulse: the ledger's facts, the chats, and what was released. */
export function sentinelBrief(
  job: Job,
  context: { project: string; asked?: string; focused?: string; released: DeployedProcess[]; releaseAfterPulse: boolean; reaction: string },
): string {
  const view = (() => {
    try {
      const entries = readLedger(context.project, { job: job.id });
      const found = pulseView(job.id, entries);
      return found !== undefined ? describePulseView(found) : undefined;
    } catch {
      return undefined;
    }
  })();
  const ended =
    job.status === "succeeded"
      ? didNotPass(job)
        ? "ran to its end, and what it built did not pass"
        : "finished, and landed what it built"
      : job.status === "stopped"
        ? "was stopped"
        : "failed";
  const lines = [`Pulse ${job.id} - ${pulseName(job)} - ${ended}, after ${formatDuration(job)}.`];
  if (context.asked !== undefined) lines.push(`It was asked for in the chat "${context.asked}".`);
  if (context.focused !== undefined) lines.push(`The person is in the chat "${context.focused}": a notice goes there.`);
  lines.push("", job.status === "succeeded" ? (job.report ?? "").trim() : (job.error ?? job.note ?? "").trim());
  if (view !== undefined) lines.push("", "What the ledger has of it:", view);
  else if (job.diff !== undefined && job.diff.trim() !== "") lines.push("", "Its ***plain diff:", job.diff.trimEnd());
  if (job.logFile !== undefined) lines.push("", `Its log: ${job.logFile}`);
  const released = (job.details as { released?: unknown } | undefined)?.released === true;
  if (released) {
    lines.push("", "It was released, as its last stage (release-after-pulse). What runs now:", ...whatRuns(context.released), "Test it.");
  } else if (job.status === "succeeded" && !didNotPass(job)) {
    lines.push("", context.releaseAfterPulse ? "Nothing was released after it." : "release-after-pulse is off: nothing was released, and you test nothing running - check the pulse alone.");
  }
  if (job.specConflict !== undefined) {
    lines.push("", "It stopped on two functional specs that contradict each other: turri has put that to the person itself. Notify no one about it.");
  } else if (wentWrong(job)) {
    lines.push(
      "",
      "It went wrong: find out why. A testing script, or where the config says the scripts are, is yours to fix - then resume",
      "the module, and tell the person what you changed. Anything else, notify the person. What the chat would have been told",
      "to do about it - each step of it that is not a fix to the tooling is a task for a notice's action, not yours, and an",
      "install is never anyone's but the person's:",
      context.reaction,
    );
  }
  lines.push("", `When you are done with it, call conclude for ${job.id} - whether all is well or not.`);
  return lines.join("\n");
}

/** What runs of a release, a line each: where, from where, its output - or that nothing was left running. */
function whatRuns(released: DeployedProcess[]): string[] {
  if (released.length === 0) return ["  nothing is running for it: the release did not leave anything running."];
  return released.map((item) => `  ${item.name}: ${item.url ?? item.command} - in ${item.dir}, its output in ${item.log}`);
}

/**
 * What the sentinel is told of a host's check: the module and its release - what runs, and where - and the functional
 * specs to test, with what each says and its scenarios, as turri reads them now.
 */
export function sentinelCheckBrief(
  check: SentinelCheck,
  context: { specs: CheckedSpec[]; released: DeployedProcess[]; commit?: string; releasedNow: boolean; focused?: string },
): string {
  const lines = [
    `Check ${check.id}: the person asked you to check ${check.funcIds.length === 1 ? "a functional spec" : `${check.funcIds.length} functional specs`} of ${check.module}, in its release.`,
  ];
  if (context.focused !== undefined) lines.push(`The person is in the chat "${context.focused}": a notice goes there.`);
  lines.push(
    "",
    `${check.module}'s release holds its code and that of every module its requires chain builds on: its last commit${context.commit !== undefined ? `, ${context.commit}` : ""}, which landed whole - never what a pulse is writing now.`,
    context.releasedNow ? "It was released for this check. What runs now:" : "What runs was released from that commit already, and is left as it is. What runs now:",
    ...whatRuns(context.released),
    "",
    `Test these functional specs of ${check.module} - only these, not its others, though they are in the release too:`,
  );
  for (const spec of context.specs) {
    lines.push("", `# ${spec.funcId}`, spec.text);
    for (const [title, scenarios] of [["Conformance scenarios", spec.conformance], ["Acceptance scenarios", spec.acceptance]] as const) {
      if (scenarios.length === 0) continue;
      lines.push(`${title}:`, ...scenarios.map((scenario) => `- ${scenario.id}: ${scenario.text.replace(/\n+/g, " ")}`));
    }
  }
  lines.push(
    "",
    "How far you test each is yours to judge, from what it says and its scenarios. When one does not do what its ***plain says, find out why and notify the person, as for a pulse, naming the check.",
    `When you are done, call conclude for check ${check.id} - whether all is well or not.`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Its tools.

/**
 * The tools the sentinel's agent may call: what reads, write and edit for the project's tooling alone, resume, its
 * notices and its guidance - and what a host gives it.
 */
export const SENTINEL_TOOLS = ["read", "ls", "grep", "find", "write", "edit", "bash", "read_output", "ledger", "pulses", "diagnose", "parse", "doctor", "web_search", "web_fetch", "resume", "notify_person", "conclude", "keep_guidance"];

/** A testing script by its name - `run_unittests_python.sh`, `prepare_environment_node.sh` - and a config file of turri's. */
const SCRIPT_FILE = /^(run_|prepare_environment).*\.(sh|ps1|bat|cmd)$/;
const CONFIG_FILE_NAME = /^config\.turri(\..+)?\.yaml$/;

/** The keys of config.turri.yaml the sentinel may change: where the testing scripts are, and the toolchains' folders. */
export const SENTINEL_CONFIG_KEYS = ["unittests-script", "conformance-tests-script", "prepare-environment-script", "toolchains"];

/**
 * The project's tooling, which the sentinel fixes itself: its testing scripts - `test_scripts/`, a `run_*.sh` or
 * `prepare_environment*.sh` at its root, and each script its config names - and its `config.turri*.yaml` files. In the
 * project, and in a project one folder down (***plain kept in plain/). Never a .plain file: the ***plain is the person's.
 */
export function sentinelTooling(cwd: string): string[] {
  const root = resolve(cwd);
  const projects = [root, ...listDirs(root).filter((dir) => listFiles(dir).some((name) => CONFIG_FILE_NAME.test(name)))];
  return [
    ...new Set(
      projects.flatMap((project) => {
        const configs = listFiles(project).filter((name) => CONFIG_FILE_NAME.test(name));
        const named = configs.flatMap((name) => {
          const config = readConfigFile(join(project, name));
          return [config.unittestsScript, config.conformanceTestsScript, config.prepareEnvironmentScript].filter((path): path is string => typeof path === "string").map((path) => resolve(project, path));
        });
        return [
          join(project, "test_scripts"),
          ...listFiles(project).filter((name) => SCRIPT_FILE.test(name)).map((name) => join(project, name)),
          ...configs.map((name) => join(project, name)),
          ...named,
        ];
      }),
    ),
  ].filter((path) => !path.endsWith(".plain"));
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== MODULES_DIR && entry.name !== "node_modules").map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Its file tools and shell: the whole project to read, and to write only its tooling (`sentinelTooling`) - in a config
 * file, only the keys of SENTINEL_CONFIG_KEYS. Its shell runs behind the command check, the OS sandbox where one is up,
 * and the audit, with the project read only and the network open - and changes nothing of the machine's. Its home and
 * temporary folder are its own, in the modules' scratch.
 */
export function sentinelFileTools(cwd: string): ToolDefinition[] {
  const tooling = sentinelTooling(cwd);
  const { tools } = confinedTools({ workdir: cwd, read: [cwd], write: tooling, shellHome: join(cwd, MODULES_DIR, `.${SENTINEL}`), fixesScripts: true });
  const shell = confinedTools({ workdir: cwd, read: [cwd], write: [], shellHome: join(cwd, MODULES_DIR, `.${SENTINEL}`) }).tools;
  return tools.map((tool) => {
    // Its shell writes nothing in the project: only write and edit reach the tooling.
    if (tool.name === "bash") return shell.find((each) => each.name === "bash")!;
    if (tool.name !== "write" && tool.name !== "edit") return tool;
    return {
      ...tool,
      async execute(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) {
        const path = resolve(cwd, String((params as { path?: unknown }).path ?? ""));
        if (!CONFIG_FILE_NAME.test(basename(path))) return (tool.execute as (...args: unknown[]) => unknown)(toolCallId, params, signal, onUpdate, ctx);
        // A config file: only where the testing scripts are, and the toolchains, may change - anything else is put back.
        const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
        const result = await (tool.execute as (...args: unknown[]) => Promise<unknown>)(toolCallId, params, signal, onUpdate, ctx);
        const changed = changedKeys(before ?? "", existsSync(path) ? readFileSync(path, "utf8") : "").filter((key) => !SENTINEL_CONFIG_KEYS.includes(key.replace(/_/g, "-")));
        if (changed.length > 0) {
          if (before === undefined) rmSync(path, { force: true });
          else writeFileSync(path, before);
          throw new Error(`Put back: in ${basename(path)} the sentinel changes only ${SENTINEL_CONFIG_KEYS.join(", ")} - not ${changed.join(", ")}. A setting of any other kind is the person's: put it to them with notify_person.`);
        }
        return result;
      },
    };
  }) as unknown as ToolDefinition[];
}

/** The top-level keys whose values differ between two config texts - one that does not parse differing in every key. */
function changedKeys(before: string, after: string): string[] {
  const parse = (text: string): Record<string, unknown> | undefined => {
    try {
      const value = loadYaml(text);
      return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : value === undefined || value === null ? {} : undefined;
    } catch {
      return undefined;
    }
  };
  const [was, now] = [parse(before), parse(after)];
  if (was === undefined || now === undefined) return ["the file as a whole - it no longer reads as YAML"];
  return [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((key) => JSON.stringify(was[key]) !== JSON.stringify(now[key]));
}

export function notifyTool(notify: (input: NoticeInput) => Notice | undefined): ToolDefinition {
  return defineTool({
    name: "notify_person",
    label: "Notify",
    description:
      "Put what is wrong with a finished pulse to the person, in the chat they are in: what is wrong, what shows it, and what " +
      "they can do about it. Each action is a task the agent of their chat carries out once they accept it. Only when they " +
      "need to act - never for a pulse that went well - or, severity info and no actions, to say what you fixed yourself in " +
      "the testing scripts or their config, and why.",
    parameters: Type.Object({
      severity: Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info")], { description: "error: it is broken; warning: it works but not as its ***plain says, or something is missing; info: worth their knowing" }),
      summary: Type.String({ description: "What is wrong, in one line" }),
      evidence: Type.Array(Type.String(), { description: "What shows it, a line each: a step that failed, a log's lines, a request and its answer" }),
      actions: Type.Array(
        Type.Object({
          label: Type.String({ description: "What the person accepts, in a few words: \"Change the ***plain to …\", \"Regenerate fs 3 again\"" }),
          task: Type.String({ description: "Exactly what their chat's agent does once they accept it - all it is given" }),
        }),
        { description: "What can be done, the best first" },
      ),
      module: Type.Optional(Type.String({ description: "The module it is about" })),
      pulse: Type.Optional(Type.String({ description: "The pulse's id" })),
      check: Type.Optional(Type.String({ description: "The check's id, when it is about a check the person asked for" })),
      fixed: Type.Optional(Type.Boolean({ description: "true when this says what you fixed yourself in a testing script or its config - severity info, no actions: a note, nothing to answer" })),
      ignorable: Type.Optional(
        Type.Boolean({
          description:
            "true when the person may reasonably leave it as the build has it, for good: chiefly a gap in the ***plain the build settled with an " +
            "assumption - then say the gap in the summary and what the build does in the evidence (the ***plain does not say what happens to " +
            "passwords over 72 bytes; the build refuses them with 422). Never for something broken, a pulse that went wrong, or a release that did not come up.",
        }),
      ),
    }),
    async execute(_id, params) {
      const notice = notify({
        severity: params.severity,
        summary: params.summary,
        evidence: params.evidence,
        actions: params.actions,
        ...(params.ignorable === true ? { ignorable: true } : {}),
        ...(params.fixed === true ? { kind: "fixed" as const } : {}),
        ...(params.module !== undefined ? { module: params.module } : {}),
        ...(params.pulse !== undefined ? { job: params.pulse } : {}),
        ...(params.check !== undefined ? { check: params.check } : {}),
      });
      return {
        content: [{ type: "text" as const, text: notice !== undefined ? `Put to the person, in the chat they are in (notice ${notice.id}).` : "There is no chat to put it in: say it here." }],
        details: { notice: notice?.id },
      };
    },
  });
}

export function concludeTool(conclude: (conclusion: Conclusion) => string | undefined): ToolDefinition {
  return defineTool({
    name: "conclude",
    label: "Conclude",
    description:
      "Say you are done with a pulse - or a check the person asked for - whether what you checked holds, and in a line or two what " +
      "you checked and found. The chat the person is in is told, whether all is well or not. Once a pulse or check, last - after " +
      "notify_person, when something is wrong. Name the pulse, or the check.",
    parameters: Type.Object({
      pulse: Type.Optional(Type.String({ description: "The pulse's id" })),
      check: Type.Optional(Type.String({ description: "The check's id, for a check the person asked for - in place of pulse" })),
      verdict: Type.Union([Type.Literal("holds"), Type.Literal("wrong")], { description: "holds: it does what its ***plain says; wrong: it does not, or it went wrong" }),
      summary: Type.String({ description: "What you checked and what you found, in a line or two: \"GET /api/ping answers pong; the new alias route redirects\"" }),
    }),
    async execute(_id, params) {
      if ((params.pulse === undefined) === (params.check === undefined)) throw new Error("Name the pulse, or the check - one of them.");
      const chat = conclude({ ...(params.pulse !== undefined ? { job: params.pulse } : { check: params.check! }), verdict: params.verdict, summary: params.summary });
      return {
        content: [{ type: "text" as const, text: chat !== undefined ? "The chat the person is in is told." : "There is no chat to tell: say it here." }],
        details: {},
      };
    },
  });
}

/** What the chat the person is in is told when the sentinel is done with a pulse: to say so, and do nothing more. */
export function concludedNote(conclusion: Conclusion, options: { shown?: boolean } = {}): string {
  const about =
    conclusion.check !== undefined
      ? `the check you asked for${conclusion.module !== undefined ? ` of ${conclusion.module}` : ""}`
      : conclusion.module !== undefined
        ? `${conclusion.module}${conclusion.pulse !== undefined ? ` pulse ${conclusion.pulse}` : ""}`
        : `pulse ${conclusion.job}`;
  if (conclusion.verdict === "unchecked") {
    if (options.shown === true) return [`The sentinel did not do ${about} (${conclusion.check ?? conclusion.job}).`, conclusion.summary.trim()].join("\n");
    return [`The sentinel did not do ${about} (${conclusion.check ?? conclusion.job}).`, conclusion.summary.trim(), "", "Tell the person, in a line, that it was not checked and why. Do nothing else about it."].join("\n");
  }
  // The host showed the person the conclusion itself: what the sentinel found, for when they ask.
  if (options.shown === true) {
    return [
      `The sentinel is done with ${about} (${conclusion.check ?? conclusion.job}): ${conclusion.verdict === "holds" ? "it holds" : "something is wrong"}.`,
      conclusion.summary.trim(),
      ...(conclusion.verdict === "wrong" ? ["", "Its notice in this chat says what is wrong and what can be done; nothing is done about it until the person answers it."] : []),
    ].join("\n");
  }
  return [
    `The sentinel is done with ${about} (${conclusion.check ?? conclusion.job}): ${conclusion.verdict === "holds" ? "it holds" : "something is wrong"}.`,
    conclusion.summary.trim(),
    "",
    conclusion.verdict === "holds"
      ? "Tell the person, in a line, that the sentinel checked it and it holds - and what it checked. Do nothing else about it."
      : "Tell the person, in a line, that the sentinel found something wrong, and that its notice in this chat says what and what can be done. Do nothing else about it until they answer the notice.",
  ].join("\n");
}

/** Bring a module up again once the sentinel fixed what stopped its pulse: what is left there is regenerated, its scripts run. */
export function resumeTool(resume: (plainFile: string) => Promise<string>): ToolDefinition {
  return defineTool({
    name: "resume",
    label: "Resume",
    description:
      "Bring a module up again after you fixed what stopped its pulse - a testing script, a toolchains: entry: what is left to " +
      "regenerate there runs again, its testing scripts with it, as when the person asks for it. Only after a fix of yours, " +
      "never to try again what nothing was changed for. What it starts comes back to you as a pulse that finished.",
    parameters: Type.Object({ plain_file: Type.String({ description: "The module's .plain file, from the project's folder: app.plain" }) }),
    async execute(_id, params) {
      return { content: [{ type: "text" as const, text: await resume(params.plain_file) }], details: {} };
    },
  });
}

export function keepGuidanceTool(cwd: string): ToolDefinition {
  return defineTool({
    name: "keep_guidance",
    label: "Keep guidance",
    description: "Keep what the person told you about how to check their software, in their words: it is in your prompt from now on, after you are closed and opened again too.",
    parameters: Type.Object({ text: Type.String({ description: "What to keep in mind, as they said it" }) }),
    async execute(_id, params) {
      keepGuidance(cwd, params.text);
      return { content: [{ type: "text" as const, text: "Kept." }], details: {} };
    },
  });
}
