import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readProjectConfig, type SentinelSetting } from "./config.ts";
import { confinedTools } from "./regenerate/confine.ts";
import { describeSpecConflict } from "./regenerate/stop-report.ts";
import { didNotPass } from "./regenerate/job-panel.ts";
import { formatDuration, pulseName, type Job } from "./regenerate/jobs.ts";
import { readLedger } from "./regenerate/ledger.ts";
import { describePulseView, pulseView } from "./regenerate/ledger-view.ts";
import { MODULES_DIR, ensureInScratch } from "./regenerate/paths.ts";
import type { DeployedProcess } from "./regenerate/release.ts";
import { SENTINEL, SENTINEL_START, wentWrong, type Conclusion, type Notice, type NoticeInput } from "./notice.ts";

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
 * that would open it and what it does - so a tab that starts working on its own is not a surprise - and whether to start it.
 */
export function sentinelStartNotice(job: Job, cwd: string): NoticeInput {
  let released = false;
  try {
    released = readProjectConfig(cwd).releaseAfterPulse === true;
  } catch {
    /* a config that cannot be read releases nothing */
  }
  return {
    kind: "sentinel-start",
    severity: "info",
    summary: `${pulseName(job)} finished - start the sentinel, a background tab that reviews each finished pulse${released ? " and tries to use what was released" : ""}?`,
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
export function landedNote(job: Job, released: DeployedProcess[]): string {
  const wasReleased = (job.details as { released?: unknown } | undefined)?.released === true;
  const where = released.map((item) => `${item.name} at ${item.url ?? item.command}`).join(", ");
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
    "with turri. Every pulse that finishes comes to you, each in a conversation of its own: this one is for the pulse in",
    "the message turri writes first - what the pulse was, how it ended,",
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
    "   does not do what its ***plain says - find out why, and call notify_person once: what is wrong, what shows it,",
    "   and what the person can do about it, each a task the agent of their chat can carry out once they accept it - a",
    "   change to the ***plain, a setting, a credential to provide, a pulse to regenerate again. Be exact: the task is",
    "   all that agent is given.",
    "   When it is a gap in the ***plain the build settled with an assumption - something the person may reasonably leave",
    "   as it is - say so with ignorable: the gap in the summary, what the build does in the evidence. Never for",
    "   something broken, a pulse that went wrong, or a release that did not come up.",
    "4. When all is well, notify no one.",
    "5. Last, call conclude once for it - holds or wrong, and in a line or two what you checked and what you found:",
    "   the chat the person is in is told, whether all is well or not. Then say the same here, in a line or two.",
    "",
    "You change nothing. Your file tools read the whole project and write nothing; your shell runs with the project",
    "read only. You never regenerate, steer, release or change ***plain yourself, and never ask the person questions -",
    "a notice is how you reach them.",
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
    lines.push("", "It was released, as its last stage (release-after-pulse). What runs now:");
    if (context.released.length === 0) lines.push("  nothing is running for it: the release did not leave anything running.");
    for (const item of context.released) lines.push(`  ${item.name}: ${item.url ?? item.command} - in ${item.dir}, its output in ${item.log}`);
    lines.push("Test it.");
  } else if (job.status === "succeeded" && !didNotPass(job)) {
    lines.push("", context.releaseAfterPulse ? "Nothing was released after it." : "release-after-pulse is off: nothing was released, and you test nothing running - check the pulse alone.");
  }
  if (job.specConflict !== undefined) {
    lines.push("", "It stopped on two functional specs that contradict each other: turri has put that to the person itself. Notify no one about it.");
  } else if (wentWrong(job)) {
    lines.push(
      "",
      "It went wrong: find out why, and notify the person. What the chat would have been told to do about it - each step of it",
      "that changes or installs something is a task for a notice's action, not yours:",
      context.reaction,
    );
  }
  lines.push("", `When you are done with it, call conclude for ${job.id} - whether all is well or not.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Its tools.

/** The tools the sentinel's agent may call: what reads, its notices and its guidance - and what a host gives it. */
export const SENTINEL_TOOLS = ["read", "ls", "grep", "find", "bash", "read_output", "ledger", "pulses", "diagnose", "validate", "doctor", "web_search", "web_fetch", "notify_person", "conclude", "keep_guidance"];

/**
 * Its file tools and shell: the whole project to read and nothing to write - the shell behind the command check, the OS
 * sandbox where one is up, and the audit, with the network open. Its home and temporary folder are its own, in the
 * modules' scratch.
 */
export function sentinelFileTools(cwd: string): ToolDefinition[] {
  return confinedTools({ workdir: cwd, read: [cwd], write: [], shellHome: join(cwd, MODULES_DIR, `.${SENTINEL}`) }).tools as unknown as ToolDefinition[];
}

export function notifyTool(notify: (input: NoticeInput) => Notice | undefined): ToolDefinition {
  return defineTool({
    name: "notify_person",
    label: "Notify",
    description:
      "Put what is wrong with a finished pulse to the person, in the chat they are in: what is wrong, what shows it, and what " +
      "they can do about it. Each action is a task the agent of their chat carries out once they accept it. Only when they " +
      "need to act - never for a pulse that went well.",
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
        ...(params.module !== undefined ? { module: params.module } : {}),
        ...(params.pulse !== undefined ? { job: params.pulse } : {}),
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
      "Say you are done with a pulse - whether what you checked holds, and in a line or two what you checked and found. The chat " +
      "the person is in is told, whether all is well or not. Once a pulse, last - after notify_person, when something is wrong.",
    parameters: Type.Object({
      pulse: Type.String({ description: "The pulse's id" }),
      verdict: Type.Union([Type.Literal("holds"), Type.Literal("wrong")], { description: "holds: it does what its ***plain says; wrong: it does not, or it went wrong" }),
      summary: Type.String({ description: "What you checked and what you found, in a line or two: \"GET /api/ping answers pong; the new alias route redirects\"" }),
    }),
    async execute(_id, params) {
      const chat = conclude({ job: params.pulse, verdict: params.verdict, summary: params.summary });
      return {
        content: [{ type: "text" as const, text: chat !== undefined ? "The chat the person is in is told." : "There is no chat to tell: say it here." }],
        details: {},
      };
    },
  });
}

/** What the chat the person is in is told when the sentinel is done with a pulse: to say so, and do nothing more. */
export function concludedNote(conclusion: Conclusion): string {
  const about = conclusion.module !== undefined ? `${conclusion.module}${conclusion.pulse !== undefined ? ` pulse ${conclusion.pulse}` : ""}` : `pulse ${conclusion.job}`;
  return [
    `The sentinel is done with ${about} (${conclusion.job}): ${conclusion.verdict === "holds" ? "it holds" : "something is wrong"}.`,
    conclusion.summary.trim(),
    "",
    conclusion.verdict === "holds"
      ? "Tell the person, in a line, that the sentinel checked it and it holds - and what it checked. Do nothing else about it."
      : "Tell the person, in a line, that the sentinel found something wrong, and that its notice in this chat says what and what can be done. Do nothing else about it until they answer the notice.",
  ].join("\n");
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
