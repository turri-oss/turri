import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTurriCore } from "@turri-dev/core/terminal";
import { createSidePanel } from "../src/regenerate/side-panel.ts";
import { terminalView } from "../src/terminal-view.ts";
import { notificationView } from "../src/terminal-notifications.ts";

const cwd = process.cwd();
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "turri-notifications-")); process.chdir(dir); });
afterEach(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });

async function terminal(setting: "ask" | "false") {
  writeFileSync("config.turri.yaml", `sentinel: ${setting}\n`);
  const core = createTurriCore({}, { view: terminalView() });
  const appendEntry = vi.fn();
  const sendMessage = vi.fn();
  const pi = new Proxy({ appendEntry, sendMessage }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ExtensionAPI;
  core.setDriver({ terminal: true, async create() { core.extension(pi); }, async dispose() {} });
  await core.open();
  const job = core.jobs.start({ kind: "regenerate", summary: "change greeting", module: "app", pulse: 1, run: async () => ({ report: "Greeting updated", details: { passed: true, landed: true } }) });
  await core.jobs.wait(job.id);
  return { core, appendEntry, sendMessage, job };
}

it("shows evidence beside pulses and only starts the chat on an accepted, still-open action", async () => {
  const { core, appendEntry, sendMessage, job } = await terminal("false");
  expect(core.notifications.items.map((item) => item.detail)).toEqual(["Greeting updated"]);
  core.concluded({ job: job.id, verdict: "wrong", summary: "No greeting on stdout" });
  const input = { module: "app", job: job.id, severity: "warning" as const, summary: "Missing greeting", evidence: ["stdout was empty"], actions: [{ label: "Fix greeting", task: "Restore the greeting" }] };
  const notice = core.notice(input)!;
  const text = (value: string) => value;
  const style = { bold: text, accent: text, muted: text, warning: (value: string) => `\x1b[38;2;255;122;61m${value}\x1b[39m`, button: (value: string) => `\x1b[7m${value}\x1b[27m` };
  const panel = createSidePanel({ jobs: () => [], map: () => [], style: new Proxy({}, { get: () => text }) as never, rows: () => 30, key: "ctrl+h", back() {}, close() {}, notifications: notificationView(core, style, () => {}) });
  const width = 70;
  const click = (label: string) => {
    const lines = panel.render(width).map(stripTerminalSequences);
    const y = lines.findIndex((line) => line.includes(label));
    expect(y).toBeGreaterThanOrEqual(0);
    const x = lines[y]!.indexOf(label);
    for (const type of ["press", "click"] as const) panel.handleMouse({ type, button: "left", x, y, width, height: 30, screenX: x, screenY: y, shift: false, alt: false, ctrl: false });
  };
  click("notifications 2");
  expect(panel.render(width).join("\n")).toContain(style.button(" mark all as read "));
  expect(panel.render(width).find((line) => line.includes("Missing greeting"))).toContain("\x1b[38;2;255;122;61m");
  click("mark all as read");
  expect(core.notifications.count).toBe(1);
  click("Missing greeting");
  expect(panel.render(width).join("\n")).toContain("stdout was empty");
  expect(panel.render(width).join("\n")).toContain("No greeting on stdout");
  expect(panel.render(width).join("\n")).toContain(style.button(" Back "));
  click("Back");
  expect(notice.state).toBe("open");
  click("Missing greeting");
  core.notice({ ...input, job: "later-pulse", summary: "Missing prefix" });
  expect(notice.state).toBe("superseded");
  expect(panel.render(width).join("\n")).toContain("[superseded]");
  click("Missing prefix");
  expect(sendMessage.mock.calls.every(([, options]) => options.triggerTurn === false)).toBe(true);
  expect(appendEntry).not.toHaveBeenCalled();
  click("1. Fix greeting");
  expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ customType: "turri_notice_answer", content: expect.stringContaining("Restore the greeting") }), expect.objectContaining({ triggerTurn: true }));
  expect(core.notices()).toHaveLength(0);
  expect(appendEntry).not.toHaveBeenCalled();
});
