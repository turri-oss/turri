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
}

export type NoticeState = "open" | "accepted" | "steered" | "dismissed" | "superseded";

export interface Notice extends NoticeInput {
  id: string;
  /** The chat it is put in: the one the person looks at, never the sentinel's. */
  chat: string;
  state: NoticeState;
  at: string;
}

/** How the person answered a notice: one of its actions (by index or label), their own words, or not at all. */
export type NoticeAnswer = { action: number | string } | { steer: string } | { dismiss: true };

export function newNotice(input: NoticeInput, chat: string): Notice {
  return { ...input, id: randomUUID().slice(0, 8), chat, state: "open", at: new Date().toISOString() };
}

/** What the focused chat's agent is asked to do once the person answered a notice - undefined when they dismissed it. */
export function noticeTask(notice: Notice, answer: NoticeAnswer): string | undefined {
  if ("dismiss" in answer) return undefined;
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
