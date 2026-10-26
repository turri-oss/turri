import { randomUUID } from "node:crypto";
import type { Job } from "./regenerate/jobs.ts";

/**
 * The sentinel's name and its notices - what it puts to the person - with nothing else: the session's chats (chats.ts)
 * hold them, and load early, before the sentinel's tools and what they need (sentinel.ts) can be.
 */

/** Its name in the strip, the host's chat list, and the ledger. */
export const SENTINEL = "sentinel";

export type ChatRole = typeof SENTINEL;

// ---------------------------------------------------------------------------------------------
// Notices: what the sentinel puts to the person.

export type NoticeSeverity = "error" | "warning" | "info";

/** One thing the person can do about a notice: accepted, the focused chat's agent is started on `task`. */
export interface NoticeAction {
  label: string;
  task: string;
}

export interface NoticeInput {
  /**
   * `sentinel-start`: not something wrong but a question turri puts before the sentinel first opens in a session - its
   * actions start it, or not, and are turri's to carry out, not the chat's agent's (SENTINEL_START). None: the sentinel's.
   */
  kind?: "sentinel-start";
  severity: NoticeSeverity;
  /** What is wrong, in a line. */
  summary: string;
  /** What shows it: a step that failed, a log's lines, a test's output. */
  evidence: string[];
  actions: NoticeAction[];
  module?: string;
  /** The pulse it is about: its job id. */
  job?: string;
  /** Its number among its module's pulses. */
  pulse?: number;
  /**
   * The person may leave it as the build has it, for good (`{ ignore: true }`): a gap in the ***plain the build settled
   * with an assumption - never something broken, a pulse that went wrong, a release that did not come up, nor the
   * question whether to start the sentinel.
   */
  ignorable?: boolean;
}

export type NoticeState = "open" | "accepted" | "steered" | "dismissed" | "ignored" | "superseded";

export interface Notice extends NoticeInput {
  id: string;
  /** The chat it is put in: the one the person looks at, never the sentinel's. */
  chat: string;
  state: NoticeState;
  at: string;
}

/** The answers to the question put before the sentinel first opens: the actions of a `sentinel-start` notice, in order. */
export const SENTINEL_START = {
  start: "Start the sentinel",
  always: "Start it, and don't ask again",
  notNow: "Not this session",
  never: "Turn it off for this project",
} as const;

export type SentinelStartChoice = keyof typeof SENTINEL_START;

/**
 * How the person answered a notice: one of its actions (by index or label), their own words, not at all this once
 * (`dismiss`) - or, on an ignorable one, not at all and not again (`ignore`): left as the build has it.
 */
export type NoticeAnswer = { action: number | string } | { steer: string } | { dismiss: true } | { ignore: true };

export function newNotice(input: NoticeInput, chat: string): Notice {
  return { ...input, id: randomUUID().slice(0, 8), chat, state: "open", at: new Date().toISOString() };
}

/** The choice an answer to a `sentinel-start` notice makes: dismissed, or answered in the person's own words, it is not now. */
export function sentinelStartChoice(notice: Notice, answer: NoticeAnswer): SentinelStartChoice {
  if (!("action" in answer)) return "notNow";
  const label = typeof answer.action === "number" ? notice.actions[answer.action]?.label : answer.action;
  return (Object.keys(SENTINEL_START) as SentinelStartChoice[]).find((choice) => SENTINEL_START[choice] === label) ?? "notNow";
}

/** What the focused chat's agent is asked to do once the person answered a notice - undefined when they dismissed it. */
export function noticeTask(notice: Notice, answer: NoticeAnswer): string | undefined {
  if ("dismiss" in answer || "ignore" in answer) return undefined;
  const head = [
    `The sentinel put this to the person, about ${notice.module !== undefined ? `${notice.module}${notice.pulse !== undefined ? ` pulse ${notice.pulse}` : ""}` : "the work"}:`,
    describeNotice(notice),
    "",
  ];
  if ("steer" in answer) return [...head, `The person answered it in their own words - do what they say:`, answer.steer.trim()].join("\n");
  const action = typeof answer.action === "number" ? notice.actions[answer.action] : notice.actions.find((candidate) => candidate.label === answer.action);
  if (action === undefined) return undefined;
  return [...head, `The person chose: ${action.label}. Do it now:`, action.task.trim()].join("\n");
}

/**
 * What the sentinel keeps of a notice the person ignored, in its guidance: what was left as it is - its module, the gap,
 * what the build does - and why, so a fresh conversation does not raise it again.
 */
export function ignoredGuidance(notice: Notice): string {
  const about = notice.module !== undefined ? ` in ${notice.module}` : "";
  const shows = notice.evidence.length > 0 ? ` (${notice.evidence.join("; ")})` : "";
  return `The person chose to leave this${about} as the build has it - do not raise it again unless the build no longer does what they accepted: ${notice.summary}${shows}`;
}

/** A notice in words: its summary, its evidence and what can be done - for the agent, the log and a chat without a card. */
export function describeNotice(notice: NoticeInput): string {
  return [
    `${notice.severity === "error" ? "✗" : notice.severity === "warning" ? "!" : "·"} ${notice.summary}`,
    ...notice.evidence.map((line) => `  ${line}`),
    ...(notice.actions.length > 0 ? ["What can be done:", ...notice.actions.map((action, index) => `  ${index + 1}. ${action.label}`)] : []),
  ].join("\n");
}

/** Whether a pulse went wrong: failed, stopped, or ran to its end with what it built not passing. */
export function wentWrong(job: Job): boolean {
  return job.status !== "succeeded" || (job.details as { passed?: unknown } | undefined)?.passed === false;
}

/** The sentinel done with a pulse: whether what it checked holds, and what it checked and found, in a line or two. */
export interface Conclusion {
  /** The pulse: its job id. */
  job: string;
  verdict: "holds" | "wrong";
  summary: string;
  module?: string;
  pulse?: number;
}
