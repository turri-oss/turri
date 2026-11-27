import type { Job, Notice, NoticeAnswer } from "@turri-dev/core";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSidePanel } from "../src/regenerate/side-panel.ts";
import { notificationView } from "../src/terminal-notifications.ts";
import { openTerminal, type OpenTerminal } from "./terminal-session.ts";

/**
 * The terminal's inbox, as the session's events fill it - a pulse that ended, the sentinel's conclusion and its notices -
 * drawn in the side panel's notifications, where a notice is answered through the session.
 */

let open: OpenTerminal;
beforeEach(async () => {
  open = await openTerminal();
});
afterEach(() => open.close());

/** A pulse as the session tells it as it ends. */
const pulse = (fields: Partial<Job>): Job =>
  ({ id: "j1", kind: "regenerate", status: "succeeded", sequence: 1, queuedAt: 0, startedAt: 0, finishedAt: 0, waitingOn: [], tail: "", activity: [], agents: [], transcript: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, summary: "", ...fields }) as Job;

it("shows evidence beside pulses and answers a notice only on an explicit choice, while it is still open", async () => {
  const { turri, terminal } = open;
  const chat = await turri.chats.open();
  const answers: Array<[string, NoticeAnswer]> = [];
  vi.spyOn(turri.notices, "answer").mockImplementation(async (id, answer) => (answers.push([id, answer]), "done"));

  terminal.inbox.hear({ type: "job", job: pulse({ summary: "change greeting", module: "app", pulse: 1, report: "Greeting updated", details: { passed: true, landed: true } }), final: true });
  expect(terminal.inbox.items.map((item) => item.detail)).toEqual(["Greeting updated"]);
  terminal.inbox.hear({ type: "concluded", chat: chat.id, conclusion: { job: "j1", verdict: "wrong", summary: "No greeting on stdout" } });
  const notice: Notice = {
    id: "n1", chat: chat.id, at: new Date().toISOString(), state: "open",
    module: "app", job: "j1", severity: "warning", summary: "Missing greeting", evidence: ["stdout was empty"], actions: [{ label: "Fix greeting", task: "Restore the greeting" }],
  } as Notice;
  terminal.inbox.hear({ type: "notice", notice });

  const text = (value: string) => value;
  const style = { bold: text, accent: text, muted: text, warning: (value: string) => `\x1b[38;2;255;122;61m${value}\x1b[39m`, button: (value: string) => `\x1b[7m${value}\x1b[27m` };
  const panel = createSidePanel({ jobs: () => [], map: () => [], style: new Proxy({}, { get: () => text }) as never, rows: () => 30, key: "ctrl+h", back() {}, close() {}, notifications: notificationView(terminal, style, () => {}) });
  const width = 70;
  const click = (label: string) => {
    const lines = panel.render(width).map(stripTerminalSequences);
    const y = lines.findIndex((line) => line.includes(label));
    expect(y, label).toBeGreaterThanOrEqual(0);
    const x = lines[y]!.indexOf(label);
    for (const type of ["press", "click"] as const) panel.handleMouse({ type, button: "left", x, y, width, height: 30, screenX: x, screenY: y, shift: false, alt: false, ctrl: false });
  };
  click("notifications 2");
  expect(panel.render(width).join("\n")).toContain(style.button(" mark all as read "));
  expect(panel.render(width).find((line) => line.includes("Missing greeting"))).toContain("\x1b[38;2;255;122;61m");
  click("mark all as read");
  // The notice still waits for an answer.
  expect(terminal.inbox.count).toBe(1);
  click("Missing greeting");
  expect(panel.render(width).join("\n")).toContain("stdout was empty");
  expect(panel.render(width).join("\n")).toContain("No greeting on stdout");
  expect(panel.render(width).join("\n")).toContain(style.button(" Back "));
  click("Back");
  expect(answers).toEqual([]);

  // A newer notice supersedes it, as the session says: its row says so, and it is answered no more.
  click("Missing greeting");
  terminal.inbox.hear({ type: "notice", notice: { ...notice, id: "n2", job: "later-pulse", summary: "Missing prefix" } });
  terminal.inbox.hear({ type: "noticeOver", notice: { ...notice, state: "superseded" } });
  expect(panel.render(width).join("\n")).toContain("[superseded]");
  click("Missing prefix");
  click("1. Fix greeting");
  expect(answers).toEqual([["n2", { action: 0 }]]);
});

it("keeps what turri warned of to read later, but not a provider waited out - the chat says that as it happens", () => {
  const { terminal } = open;
  terminal.inbox.hear({ type: "incident", text: "anthropic is overloaded - trying again in 30s", event: { kind: "provider_retry", job: "j1" } });
  terminal.inbox.hear({ type: "orphansStopped", count: 2 });
  terminal.inbox.hear({ type: "notification", text: "The project's chats were not recorded.", level: "info" });
  expect(terminal.inbox.items).toEqual([]);
  terminal.inbox.hear({ type: "notification", text: "The sentinel could not be opened: no room", level: "warning" });
  expect(terminal.inbox.items.map((item) => [item.title, item.warning])).toEqual([["The sentinel could not be opened: no room", true]]);
  // A pulse run again as another is not over yet.
  terminal.inbox.hear({ type: "job", job: pulse({ status: "failed", summary: "change greeting", replacedBy: "j2" }), final: false });
  expect(terminal.inbox.items).toHaveLength(1);
});
