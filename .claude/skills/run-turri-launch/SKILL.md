---
name: run-turri-launch
description: Run turri on an example with launch-after-pulse and the sentinel on, provoke the launch track's hard cases (a port held by another program, turri killed outright and restarted), and check launch and the sentinel against what docs/launch.md and docs/sentinel.md promise - a pass / fail checklist with the ledger lines that show each. Use when asked to evaluate, test or check launch, launch-after-pulse, left-behind servers or the sentinel in a real run.
---

# Evaluate launch and the sentinel

A run of [run-turri](../run-turri/SKILL.md) with two provocations added, judged against a fixed **checklist** instead of a general verdict. The promises checked are those of `docs/launch.md` and `docs/sentinel.md` - read both before step 1; when the code and the docs disagree, the checklist follows the docs and the disagreement is a finding.

Paths and helpers are run-turri's: `$SKILL` is `.claude/skills/run-turri`, `ledger.mjs` and `EVALUATING.md` are there, and shell variables do not carry between commands.

## Steps

### 1. Run the example

Follow run-turri's steps 1 to 5 - run folder, `debug: true`, `sentinel: true`, `launch-after-pulse: true`, tmux, the example's messages at their moments, dialogs answered. With **squatter**, the example's own first launch is step 2's held port - skip step 2. Pick from run-turri's [EXAMPLES.md](../run-turri/EXAMPLES.md): a served one tests the most - **shorty** (one backend, the default) or **guestbook** (a backend and a frontend, two codebases launched side by side); **textstats** covers a library with nothing to serve, **squatter** a port held from the first launch. Done when `ledger.mjs wait --until idle` exits 0 after the example's last message, with at least two pulses landed and launched.

### 2. Provoke a port held by another program

1. Read the port the last launch serves on (the chat's launch message, or `.turri/launch/running/*.json`).
2. Send `/halt launched <module>` and check the port is free (`lsof -nP -iTCP:<port> -sTCP:LISTEN` shows nothing).
3. Hold it yourself, in a second tmux window that does not take the keys: `tmux new-window -d -t <session> -n squatter 'python3 -m http.server <port>'` - keep sending to `<session>:0`.
4. Ask the chat `Launch <module> again.` - naming the module, so it does not read the line as part of `/halt`'s output - and wait for the launch to finish (`launch.finished` in the ledger).
5. Expected: that launch is `failed`, the chat is told what holds the port, nothing of the app was started on another port, and the squatter is still running untouched.
6. Kill the squatter window (`tmux kill-window -t <session>:squatter`), ask `Launch <module> again.` once more, and check it comes up.

Write each observation in the run log.

### 3. Kill turri outright and restart

1. With a launch up and serving, note its pid and URL from `.turri/launch/running/`.
2. `kill -9 <pid>` - turri's own process: the pid at the end of the newest ledger file's name (`.turri/ledger/<time>-<run>-p<pid>.jsonl`; `ledger.mjs summary` prints it), not the pane's (`ps` shows it as `pi`). Its servers live on in their own process groups. Confirm the server still answers.
3. Start turri again in the project folder - the kill closed the tmux session with it, so in a new one: `tmux new-session -d -s <session>-2 -x 220 -y 60 -c <run>/project 'caffeinate -is turri --continue'`.
4. Expected: as the session starts, a `launch.left-behind` event names that server and it is stopped (the URL stops answering, the pid is gone). Nothing else is stopped - check a process you started yourself on another port survives.
5. Ask the chat `Launch <module>.` before any pulse lands: the summary of the codebase's next launch should open with `Stopped what an earlier turri session left running of <module>: ...` - with the sentinel on, a launch after a pulse is never told to the chat, so this is the one place to see it.
6. After `--continue`, nothing resumes until the person speaks: tell the chat what happened (`turri was killed and restarted - carry on.`). Then send one more small change from the example (or `Regenerate <module>:<func-id> again`) so a pulse lands and launches in the new session.

### 4. Stop and gather

Run-turri's steps 6 and 7: try what runs now, `/quit`, check `.turri/launch/running/` is empty. Then `node $SKILL/ledger.mjs summary <project>` - it shows every run, the killed one and the restarted one; a launch out already has no `launch.started`, and the summary marks it.

### 5. Check every item

Go through the checklist below, item by item. Each gets **pass**, **fail** or **not exercised**, with its evidence: ledger lines (run id and `seq`), a command and its output, a run-log entry. Done when no item is left blank. A fail is classified and traced as EVALUATING.md says - most are turri's.

### 6. Report

`<run>/report.md`: EVALUATING.md's shape, with the checklist table in place of "What was tried". Tell the person the pass / fail count, each fail in a line with its evidence, and the report's path. Never committed, never copied into a repo or the vault.

## Checklist

**The launch track**

1. **Every landed pulse is launched.** For each `job.finished` with `landed: true`, a `launch.started` carries its pulse - or a later launch's commit holds the pulse's commit (it was `superseded`): `git --git-dir=plain_modules/<m>/.plaingit merge-base --is-ancestor <pulse-commit> <launch-commit>`.
2. **One at a time.** No two launches of one codebase overlap: each `launch.started` comes after the previous one's `launch.finished`.
3. **Out already does nothing.** A launch whose commit's code was already running ends `already`, at once, with nothing restarted - the server's pid unchanged.
4. **Nothing waits on a launch.** The next pulse of a codebase starts without waiting for its launch: a `job.started` between a `launch.started` and its `launch.finished`, whenever work was waiting.
5. **Launched means serving.** Every launch that ended `launched` and serves had a process in `.turri/launch/running/` while it ran, and its URL answered when tried.
6. **A held port fails the launch** - step 2's expectations, all of them.
7. **The code comes from dist.** What runs was started in `dist/<module>` (the record's folder), never in `plain_modules`.

**What a dead turri left**

8. **Left-behind servers are stopped** - step 3's expectations: `launch.left-behind` names the server, it is gone, the next launch says so, and nothing turri did not record was touched.
9. **Nothing left on a clean exit.** After `/quit`, `.turri/launch/running/` is empty and every launched port is free.

**The sentinel**

10. **Checked once, in order.** Every landed pulse has one `sentinel.checking` and one `sentinel.concluded`, in the order the pulses finished.
11. **Briefed only on what runs.** Each `sentinel.checking` comes after a launch that ended `launched`, `already` or `failed` (a launch that did not come up is told to it - `docs/sentinel.md`) and whose commit holds the pulse's. A landed pulse with no launch for it at all is a fail. No `sentinel.refused` - each is turri's own error.
12. **Paused and resumed.** Where a codebase was launched again mid-check, `sentinel.paused` and `sentinel.resumed` bracket it and the check concludes in the same conversation. (Not exercised when no launch overlapped a check.)
13. **Tests what runs.** Its conversation (the sentinel's `sessionFile` in `.turri/chats.json`) shows it trying the running software - `curl` against the URL, the CLI from `dist/` - on what the pulse changed, not only reading code.
14. **Never runs plain_modules, never launches.** No command in its conversation runs code from `plain_modules`; its session has no `launch` call (it has no such tool - a call refused for it still shows the attempt). A `command.refused` from it shows the guard holding - pass, but list it.
15. **Notices are actionable.** Each `notice.put`: its card on the screen said what is wrong, what shows it and numbered actions a chat's agent can carry out; at most one was open per module; the problem it named was real (check it yourself).
16. **The chat stays out of it.** After a pulse lands, the chat's agent says what landed and that the sentinel has it, in a line or two, and neither tests, launches nor opens it (the run log and the chat's session).
