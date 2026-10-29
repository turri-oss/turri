import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { chatBusy } from "./chat-idle.ts";
import type { ChatLink } from "./chats.ts";
import type { ScriptKind } from "./regenerate/test-scripts.ts";

/**
 * A skill that runs in the background (`metadata.background: true`, docs/skills-and-gates.md): in the chat, cultivate
 * starts it and returns at once, nothing shows while it runs, and nobody is asked anything. Its end comes back to the
 * chat it was started from once that chat is idle - never interrupting it: one line drawn by turri when it did its work,
 * a message that starts a turn when it did not, for the chat to tell the person and decide what next.
 */

/** How a background run ended, for the chat it was started from. */
export interface SkillRunEnd {
  skill: string;
  /** It did its work: a line, starting no turn. */
  ok: boolean;
  /** The line it is drawn as. */
  line: string;
  /** When it did not do its work: what the chat's agent is told, in a turn of its own. */
  task?: string;
  /** The testing script it writes, when it writes one. */
  kind?: ScriptKind;
  /** The module it is for, relative to the project, when it was given one. */
  plainFile?: string;
}

/**
 * What a host is told of a background run, besides its skill: the testing script it writes and the module it is for,
 * each when there is one - in cultivate's result as it starts, and in the message a run that did not do its work sends.
 */
export function runDetails(kind: ScriptKind | undefined, plainFile: string | undefined): { kind?: ScriptKind; plainFile?: string } {
  return { ...(kind !== undefined ? { kind } : {}), ...(plainFile !== undefined ? { plainFile } : {}) };
}

/** What the agent of a background run is told, besides what the chat passed on. */
export const BACKGROUND_NOTE =
  "You run in the background: nobody can be asked anything, and nobody watches. Where the module's stack, its ***plain and the project " +
  "leave something open, decide it - the reading most consistent with them - and say what you decided in your result. If what you are " +
  "to make cannot be told at all - no language, no test framework to go by - write nothing, and say why.";

const WHAT: Record<ScriptKind, string> = { unit: "unit testing script", conformance: "conformance testing script" };

/** What cultivate says as it starts a background run. */
export function startedText(skill: string, options: { model?: string; plainFile?: string; kind?: ScriptKind }): string {
  const what = options.kind !== undefined ? `the ${WHAT[options.kind]}${options.plainFile !== undefined ? ` for ${options.plainFile}` : ""}` : "its work";
  return [
    `${skill} is writing ${what} in the background${options.model !== undefined ? `, on ${options.model}` : ""}. What it did comes back to this chat when it ends.`,
    "Do not wait for it, and do not tell the person to: go on with the turn.",
    ...(options.kind !== undefined
      ? [
          options.kind === "unit"
            ? "Regenerate now if there is more to do: a module's pulses wait for its unit testing script while it is written, and start once it is."
            : "Write the scenarios now if they are next: the module's conformance tests wait for the script while it is written, and are written once it is.",
        ]
      : []),
  ].join("\n");
}

/**
 * What a background run changed of the files that changed in the project while it ran: the chat goes on meanwhile, and
 * what it writes - its ***plain, its test plain files - is not the run's. A run that writes a testing script changes
 * the script, a prepare script beside a conformance one, and a config file naming them; any other run, all of them.
 */
export function ownChanges(changed: string[], kind?: ScriptKind): string[] {
  if (kind === undefined) return changed;
  const scripts = kind === "unit" ? ["run_unittests"] : ["run_conformance_tests", "prepare_environment"];
  const name = (path: string) => path.split("/").at(-1) ?? path;
  return changed.filter((path) => scripts.some((script) => name(path).startsWith(script)) || /^config(\.turri)?(\.[^.]+)?\.yaml$/.test(name(path)));
}

/** The line a background run that did its work is drawn as. */
export function doneLine(skill: string, changed: string[], kind?: ScriptKind): string {
  const files = changed.join(", ");
  if (kind === undefined) return `${skill} finished in the background: ${files}.`;
  const what = WHAT[kind];
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} written: ${files}.`;
}

/** What the chat's agent is told when a background run did not do its work: why, and what is left to it. */
export function failedTask(skill: string, why: string, output: string | undefined, kind?: ScriptKind): string {
  return [
    `${skill}, which you started in the background, ${why}.`,
    "",
    ...(output !== undefined && output.trim() !== "" ? ["<artifact>", output.trim(), "</artifact>", ""] : []),
    "Tell the person in a line or two what went wrong" +
      (kind === undefined
        ? "."
        : kind === "unit"
          ? ", and that the module's pulses cannot be built until it has a unit testing script."
          : ", and that the module's conformance tests cannot be written until it has a conformance testing script."),
    "Start it again with cultivate only when you can change what went wrong - the context you pass it, the module it is for; otherwise say what the person can do. Ask the person nothing.",
  ].join("\n");
}

/** The line drawn for a background run, in the transcript and in no model's context. */
const SKILL_RUN_ENTRY = "turri_skill_run";

/** How long an end waits before the chat is looked at again, while the person types or it cannot be told yet. */
const RECHECK_MS = 2000;

/** A chat's background runs' ends: held until it is idle - its agent done, nothing typed - then told together. */
export function skillRunDelivery(pi: ExtensionAPI, link: ChatLink, context: () => ExtensionContext | undefined): { put(end: SkillRunEnd): void } {
  const waiting: SkillRunEnd[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  pi.registerEntryRenderer(SKILL_RUN_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { text: string } | undefined;
    if (data === undefined) return undefined;
    const box = new Box(1, 0);
    box.addChild(new Text(theme.fg("muted", data.text), 0, 0));
    return box;
  });

  const later = (ms: number) => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      deliver();
    }, ms);
    timer.unref?.();
  };

  const deliver = () => {
    if (waiting.length === 0) return;
    if (chatBusy(link, context)) {
      later(RECHECK_MS);
      return;
    }
    const now = waiting.splice(0);
    const failed = now.filter((end) => !end.ok && end.task !== undefined);
    try {
      for (const end of now.filter((end) => end.ok)) pi.appendEntry(SKILL_RUN_ENTRY, { text: end.line });
      if (failed.length > 0) {
        // A follow-up, never a steer: should a turn start in between, this waits for it to end.
        void pi.sendMessage(
          { customType: SKILL_RUN_ENTRY, content: failed.map((end) => end.task!).join("\n\n---\n\n"), display: false, details: { skills: failed.map((end) => end.skill), runs: failed.map((end) => ({ skill: end.skill, ...runDetails(end.kind, end.plainFile) })) } },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }
    } catch {
      // Not bound to its session yet: kept, and tried again.
      waiting.unshift(...now);
      later(RECHECK_MS);
    }
  };

  pi.on("agent_settled", () => deliver());
  pi.on("session_start", () => later(0));

  return {
    put(end) {
      waiting.push(end);
      later(0);
    },
  };
}
