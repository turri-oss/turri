#!/usr/bin/env node
// Reads a turri project's ledger (.turri/ledger/*.jsonl, gzipped ones too) and screen for the run-turri skills.
//
//   node ledger.mjs summary <project> [--run <id>]
//       every run (or one): pulses with their steers, launches, the sentinel, notices, trouble, and what it cost -
//       the ledger's model calls by role, and the chat's and the sentinel's own (from their pi session files).
//   node ledger.mjs wait <project> --until <cond> [--timeout <s>] [--settle <s>]
//       polls every 5 seconds; exits 0 when <cond> holds, printing the newest run's summary:
//         started:N | landed:N | finished:N   N pulses, counted over every run of the project (restarts included)
//         idle    in the newest run something was queued, and every pulse, launch and sentinel check that
//                 started has ended - for --settle seconds in a row (default 30)
//       exits 3 when the person is needed: a warning or error notice is open, or the work loop halted since
//       the wait began; exits 2 on timeout (default 540). Info notices never stop it - the summary lists them.
//       The ledger cannot see the chat: after idle, wait for its turn with `chat`.
//   node ledger.mjs session <session.jsonl> [--grep <text>]
//       a pi session - an agent's (.turri/sessions/), the chat's or the sentinel's (~/.pi/agent/sessions/) - one line
//       per user message, reply text, tool call and tool result, in order.
//   node ledger.mjs chat <tmux-session> [--timeout <s>]
//       waits until the chat's turn is over - no `Working` line and no `waiting for your answer` - for 6 seconds;
//       exits 3 at once when a dialog is on the screen (a notice or a question: `↑↓` and `enter`), 2 on timeout.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const [command, target, ...rest] = process.argv.slice(2);
const option = (name) => {
  const at = rest.indexOf(name);
  return at === -1 ? undefined : rest[at + 1];
};
if (!["summary", "wait", "chat", "session"].includes(command) || target === undefined) {
  console.error("usage: ledger.mjs summary <project> [--run <id>] | wait <project> --until <cond> [--timeout <s>] [--settle <s>] | chat <tmux-session> [--timeout <s>]");
  process.exit(64);
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the screen ----

if (command === "chat") {
  const deadline = Date.now() + Number(option("--timeout") ?? 540) * 1000;
  let quietSince;
  for (;;) {
    let screen = "";
    try {
      screen = execFileSync("tmux", ["capture-pane", "-p", "-t", target], { encoding: "utf8" });
    } catch {
      console.log(`no tmux session ${target} - turri has exited`);
      process.exit(1);
    }
    const lines = screen.split("\n").filter((l) => l.trim() !== "");
    const tail = lines.slice(-14).join("\n");
    if (/↑↓/.test(tail) && /enter/.test(tail)) {
      console.log(`a dialog is on the screen - read it and answer it:\n${tail}`);
      process.exit(3);
    }
    const busy = /──\s*\S?\s*Working/.test(tail) || /waiting for your answer/.test(tail);
    quietSince = busy ? undefined : (quietSince ?? Date.now());
    if (quietSince !== undefined && Date.now() - quietSince >= 6000) {
      console.log("the chat's turn is over");
      process.exit(0);
    }
    if (Date.now() > deadline) {
      console.log(`timed out - the chat is still working:\n${tail}`);
      process.exit(2);
    }
    await pause(2000);
  }
}

// ---- a pi session file: what an agent, the chat or the sentinel did, in order ----

if (command === "session") {
  const grep = option("--grep");
  for (const line of readFileSync(target, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const m = e.message;
    const at = (e.timestamp ?? "").slice(11, 19);
    let out = [];
    if (e.type === "custom" && e.customType) out.push(`${at} [${e.customType}]`);
    if (m?.role === "user") out.push(`${at} USER ${JSON.stringify(m.content).slice(0, 300)}`);
    if (m?.role === "assistant") {
      for (const c of m.content ?? []) {
        if (c.type === "text" && c.text.trim()) out.push(`${at} SAYS ${c.text.replace(/\s+/g, " ").slice(0, 300)}`);
        if (c.type === "toolCall") out.push(`${at} CALL ${c.name} ${JSON.stringify(c.arguments).slice(0, 300)}`);
      }
    }
    if (m?.role === "toolResult") out.push(`${at} RESULT ${m.toolName}${m.isError ? " ERROR" : ""} ${JSON.stringify(m.content).slice(0, 300)}`);
    for (const o of out) if (grep === undefined || o.includes(grep)) console.log(o);
  }
  process.exit(0);
}

// ---- the ledger ----

const project = resolve(target);

function readRuns() {
  const dir = join(project, ".turri", "ledger");
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") || f.endsWith(".jsonl.gz")).sort();
  } catch {
    return [];
  }
  const runs = new Map();
  for (const file of files) {
    const raw = readFileSync(join(dir, file));
    const text = file.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a line being written
      }
      if (!runs.has(entry.run)) runs.set(entry.run, { id: entry.run, file, pid: /-p(\d+)\.jsonl/.exec(file)?.[1], events: [] });
      runs.get(entry.run).events.push(entry);
    }
  }
  for (const run of runs.values()) run.events.sort((a, b) => a.seq - b.seq);
  return [...runs.values()];
}

/** What the chats and the sentinel spent: their pi session files, which the ledger does not cover. */
function chatCosts() {
  const dir = join(homedir(), ".pi", "agent", "sessions", `-${project.replaceAll("/", "-")}--`);
  if (!existsSync(dir)) return undefined;
  let chats = [];
  try {
    chats = JSON.parse(readFileSync(join(project, ".turri", "chats.json"), "utf8")).runs.flatMap((r) => r.chats);
  } catch {}
  const sentinelFiles = new Set(chats.filter((c) => c.role === "sentinel").map((c) => c.sessionFile));
  const chatFiles = new Set(chats.filter((c) => c.role !== "sentinel").map((c) => c.sessionFile));
  const sum = { chat: 0, sentinel: 0, other: 0 };
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const path = join(dir, file);
    let cost = 0;
    let sentinel = sentinelFiles.has(path);
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const e = JSON.parse(line);
        cost += e.message?.role === "assistant" ? (e.message.usage?.cost?.total ?? 0) : 0;
        // A sentinel conversation chats.json no longer names: turri marks each with its pulse.
        if (e.customType === "turri_sentinel_pulse") sentinel = true;
      } catch {}
    }
    sum[chatFiles.has(path) ? "chat" : sentinel ? "sentinel" : "other"] += cost;
  }
  return sum;
}

const secs = (ms) => (ms === undefined ? "?" : ms >= 60000 ? `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s` : `${Math.round(ms / 1000)}s`);
const time = (ts) => ts.slice(11, 19);

function analyse(run) {
  const pulses = new Map();
  const pulse = (id) => {
    if (!pulses.has(id)) pulses.set(id, { id, run: run.id, diffs: 0, retries: [], rounds: {}, reviews: [], stopped: [], provider: 0, refused: [], sentinel: [] });
    return pulses.get(id);
  };
  const launches = new Map();
  const notices = new Map();
  const trouble = [];
  let sentinelChat;
  let cost = 0;
  const byRole = {};
  for (const e of run.events) {
    const p = e.job !== undefined ? pulse(e.job) : undefined;
    switch (e.kind) {
      case "run.started": run.started = e; break;
      case "run.ended": run.ended = e; break;
      case "chat.opened": if (e.role === "sentinel") sentinelChat = e.chat; break;
      case "job.queued": Object.assign(p, { module: e.module, number: e.pulse, title: e.title ?? e.summary, jobKind: e.jobKind, queued: e.ts, waitingOn: e.waitingOn }); break;
      case "job.diff": p.diffs += 1; break;
      case "job.started": p.started = e.ts; break;
      case "job.retried": p.retries.push(e.failure); break;
      case "job.finished": Object.assign(p, { finished: e.ts, status: e.status, landed: e.landed, ms: e.ms, cost: e.usage?.cost ?? 0, stoppedBy: e.stoppedBy, error: e.error, failedForGood: e.failedForGood }); cost += e.usage?.cost ?? 0; break;
      case "gate.round": if (p) p.rounds[e.gate] = Math.max(p.rounds[e.gate] ?? 0, e.round); break;
      case "review.verdict": p?.reviews.push(e.pass ? "pass" : `${e.problems} problems`); break;
      case "turn.stopped": p ? p.stopped.push(`${e.agent?.role ?? "?"}: ${e.reason}`) : trouble.push(`${time(e.ts)} turn stopped outside a pulse: ${e.reason}`); break;
      case "provider.retry": case "provider.stall": if (p) p.provider += 1; break;
      case "model.call": {
        const role = e.agent?.role ?? (e.chat !== undefined && e.chat === sentinelChat ? "sentinel" : "no role");
        byRole[role] = (byRole[role] ?? 0) + (e.usage?.cost ?? 0);
        break;
      }
      case "provider.error": trouble.push(`${time(e.ts)} provider error${e.transient ? " (transient)" : ""}: ${e.error}`); break;
      case "guard.refused": case "command.refused": (p ? p.refused : trouble).push(`${time(e.ts)} seq ${e.seq} ${e.kind} ${e.rule}${e.tool ? ` ${e.tool}` : ""}`); break;
      case "launch.started": launches.set(e.launch, { id: e.launch, module: e.module, commit: e.commit, pulse: e.pulse, started: e.ts, chat: e.chat }); break;
      case "launch.finished": {
        // A launch out already - or one halted while waiting - ends with no launch.started.
        if (!launches.has(e.launch)) launches.set(e.launch, { id: e.launch, module: e.module, commit: e.commit, chat: e.chat, noStart: true });
        Object.assign(launches.get(e.launch), { status: e.status, ms: e.ms, finished: e.ts, seq: e.seq });
        break;
      }
      case "launch.left-behind": trouble.push(`${time(e.ts)} seq ${e.seq} left behind, stopped: ${e.stopped.map((s) => `${s.module}/${s.name} pid ${s.pid}${s.url ? ` ${s.url}` : ""}`).join(", ")}`); break;
      case "sentinel.checking": case "sentinel.paused": case "sentinel.resumed": case "sentinel.refused": case "sentinel.concluded":
        (p ?? { sentinel: [] }).sentinel.push(`${time(e.ts)} ${e.kind.slice(9)}${e.verdict ? ` ${e.verdict}` : ""}${e.launch ? ` ${e.launch}` : ""}${e.why ? `: ${e.why}` : ""}`);
        if (e.kind === "sentinel.refused") trouble.push(`${time(e.ts)} seq ${e.seq} sentinel refused (turri's own error): ${e.why}`);
        break;
      case "notice.put": notices.set(e.notice, { id: e.notice, severity: e.severity, module: e.module, put: e.ts, seq: e.seq }); break;
      case "notice.over": Object.assign(notices.get(e.notice) ?? {}, { state: e.state }); break;
      case "loop.halted": trouble.push(`${time(e.ts)} seq ${e.seq} loop halted (${e.track}): ${e.why}`); break;
      case "loop.stopped": trouble.push(`${time(e.ts)} seq ${e.seq} loop stopped: ${e.why}`); break;
      case "planner.failed": trouble.push(`${time(e.ts)} planner ${e.step} failed: ${e.error}`); break;
      case "planner.fellBack": trouble.push(`${time(e.ts)} planner ${e.step} fell back: ${e.why}`); break;
      case "healer.failed": trouble.push(`${time(e.ts)} healer ${e.healer} failed: ${e.error}`); break;
      case "history.reset": trouble.push(`${time(e.ts)} seq ${e.seq} history reset: ${e.undone} undone (${(e.paths ?? []).slice(0, 5).join(", ")})`); break;
      case "history.failed": trouble.push(`${time(e.ts)} history failed (${e.subject}): ${e.said}`); break;
      case "history.rolledBack": trouble.push(`${time(e.ts)} seq ${e.seq} history rolled back: ${e.why}`); break;
      case "environment.error": trouble.push(`${time(e.ts)} environment: ${e.missing} missing (${e.source})`); break;
    }
  }
  const list = [...pulses.values()].filter((p) => p.queued !== undefined || p.finished !== undefined);
  return { pulses: list, launches: [...launches.values()], notices: [...notices.values()], trouble, cost, byRole, sentinelChat };
}

function render(run) {
  const a = analyse(run);
  const out = [];
  const s = run.started;
  out.push(`run ${run.id} pid ${run.pid ?? "?"} (${run.file})${s ? ` turri ${s.version ?? "?"} ${s.commit?.slice(0, 7) ?? "?"}${s.dirty ? " dirty" : ""}, mode ${s.mode}` : ""}${run.ended ? `, ended after ${secs(run.ended.ms)}` : ", no run.ended (still running, or killed)"}`);
  out.push(`pulses: ${a.pulses.length}, landed ${a.pulses.filter((p) => p.landed).length}, pulses' cost $${a.cost.toFixed(3)}`);
  const roles = Object.entries(a.byRole).sort((x, y) => y[1] - x[1]).map(([r, c]) => `${r === "no role" ? "no role (background skills)" : r} $${c.toFixed(3)}`).join(", ");
  if (roles) out.push(`model calls in the ledger: ${roles}`);
  for (const p of a.pulses) {
    const state = p.finished === undefined ? (p.started ? "RUNNING" : "waiting") : `${p.status}${p.landed ? " landed" : " not landed"}${p.stoppedBy ? ` stopped by ${p.stoppedBy}` : ""}${p.failedForGood ? " FAILED FOR GOOD" : ""}`;
    out.push(`  ${p.id} ${p.module ?? "?"} #${p.number ?? "?"} ${p.jobKind ?? ""} "${p.title ?? ""}" - ${state}, ${secs(p.ms)}, $${(p.cost ?? 0).toFixed(3)}`);
    if (p.diffs > 1) out.push(`      steered ${p.diffs - 1} time(s) (job.diff events after the first)`);
    const rounds = Object.entries(p.rounds).map(([g, r]) => `${g} ${r}`).join(", ");
    if (rounds) out.push(`      gate rounds: ${rounds}`);
    if (p.reviews.length) out.push(`      reviews: ${p.reviews.join(", ")}`);
    if (p.retries.length) out.push(`      retried: ${p.retries.join(" | ")}`);
    if (p.stopped.length) out.push(`      turns stopped: ${p.stopped.join(" | ")}`);
    if (p.provider) out.push(`      provider retries/stalls: ${p.provider}`);
    if (p.refused.length) out.push(`      refused: ${p.refused.join(" | ")}`);
    if (p.error) out.push(`      error: ${p.error}`);
    if (p.sentinel.length) out.push(`      sentinel: ${p.sentinel.join(" -> ")}`);
  }
  if (a.launches.length) {
    out.push("launches:");
    for (const l of a.launches) out.push(`  ${l.id} ${l.module ?? ""} ${l.commit ?? ""} for pulse ${l.pulse ?? "-"} - ${l.status ?? "RUNNING"} ${secs(l.ms)}${l.noStart ? " (no launch.started - out already, or halted)" : ""}`);
  }
  if (a.notices.length) {
    out.push("notices:");
    for (const n of a.notices) out.push(`  ${n.id} ${n.severity} ${n.module ?? ""} at ${time(n.put)} seq ${n.seq} - ${n.state ?? "OPEN"}`);
  }
  if (a.trouble.length) out.push("trouble:", ...a.trouble.map((t) => `  ${t}`));
  return { text: out.join("\n"), a };
}

if (command === "summary") {
  const runs = readRuns().filter((r) => option("--run") === undefined || r.id === option("--run"));
  if (runs.length === 0) {
    console.log(`no ledger in ${project}/.turri/ledger`);
    process.exit(1);
  }
  console.log(runs.map((r) => render(r).text).join("\n\n"));
  const chats = chatCosts();
  if (chats) console.log(`\nthe chats' own cost, from their pi sessions (not in the ledger): chat $${chats.chat.toFixed(2)}, sentinel $${chats.sentinel.toFixed(2)}${chats.other ? `, other $${chats.other.toFixed(2)}` : ""}`);
} else {
  const until = option("--until") ?? "idle";
  const deadline = Date.now() + Number(option("--timeout") ?? 540) * 1000;
  const [what, n] = until.split(":");
  const settle = Number(option("--settle") ?? 30);
  let known; // notices and halts there before the wait began
  let idleSince;
  for (;;) {
    const runs = readRuns();
    const run = runs.at(-1);
    if (run !== undefined) {
      const { text, a } = render(run);
      const all = runs.flatMap((r) => analyse(r).pulses);
      const seen = [...a.notices.map((x) => `notice ${x.id}`), ...a.trouble.filter((t) => t.includes("loop halted"))];
      known ??= new Set(runs.flatMap((r) => { const b = analyse(r); return [...b.notices.map((x) => `notice ${x.id}`), ...b.trouble.filter((t) => t.includes("loop halted"))]; }));
      const fresh = seen.filter((x) => !known.has(x));
      // Any warning or error notice still open stops the wait, whenever it opened - one that opened between two waits
      // included. An info notice may be a note with nothing to answer (what the sentinel fixed itself): it never does.
      const open = a.notices.find((x) => x.state === undefined && x.severity !== "info");
      const halt = fresh.find((x) => x.includes("loop halted"));
      if (open || halt) {
        console.log(`the person is needed: ${open ? `notice ${open.id} is open - wait for the chat's turn (ledger.mjs chat), then read it on the screen and answer it` : halt}\n${text}`);
        process.exit(3);
      }
      const count = { started: all.filter((p) => p.started).length, landed: all.filter((p) => p.landed).length, finished: all.filter((p) => p.finished).length }[what];
      const idle = a.pulses.length > 0 && a.pulses.every((p) => p.finished) && a.launches.every((l) => l.status) && a.pulses.every((p) => !p.sentinel.length || /concluded|refused/.test(p.sentinel.at(-1)));
      // idle must hold for --settle seconds: between a message and the pulse it plans, nothing is queued yet.
      idleSince = idle ? (idleSince ?? Date.now()) : undefined;
      const settled = idleSince !== undefined && Date.now() - idleSince >= settle * 1000;
      if (what === "idle" ? settled : count >= Number(n)) {
        console.log(`${until} holds\n${text}`);
        process.exit(0);
      }
    }
    if (Date.now() > deadline) {
      console.log(`timed out waiting for ${until}${run ? `\n${render(run).text}` : ""}`);
      process.exit(2);
    }
    await pause(5000);
  }
}
