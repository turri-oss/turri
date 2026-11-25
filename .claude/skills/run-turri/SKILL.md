---
name: run-turri
description: Run turri end to end on an example - a real terminal chat in tmux, debug mode on, the example's messages sent as a person would - then evaluate the run from what turri recorded and say whether it was good and what looks like a turri bug. Use when asked to run, try, smoke-test or evaluate turri on an example (guestbook, tidy, shorty) or on a scenario the person gives.
---

# Run and evaluate turri

You are the person at the keyboard, and then the **evaluator**. You drive the real `turri` terminal in tmux, exactly as a person would, so steering, launch and the sentinel run as they do for people. Then you judge the run from what turri **recorded** - the ledger, the pulse reports, the debug logs, the sessions, the code - never from the chat's own account of itself. The chat is part of what is under test.

Every command below runs from the turri clone (this repo). `$SKILL` is this skill's folder, `.claude/skills/run-turri`; `$RUN` is the run folder made in step 2 and `$P` the project inside it, `$RUN/project`; `$S` is the tmux session name. Shell variables do not carry from one command to the next: write them out as absolute paths and names in every command.

## Steps

### 1. Settle what to run

- **The example**: one from [EXAMPLES.md](EXAMPLES.md) - its table says what each exercises; guestbook when none is named - or a scenario the person gives. Read its whole entry, and the script it points to in the repo's own `examples/` folder: the `>` messages are what you send, and the entry and the script say *when* to send each one and what to try once it lands.
- **The models**: the harness and coding models the person names, as `provider/model-id`. With none named, ask once - a run costs money.
- **turri under test**: `git rev-parse --short HEAD` and `git status --short` in this repo - the version you are evaluating, uncommitted changes included. `turri` on the PATH is this clone (`npm link`); check `readlink -f "$(which turri)"` points here.
- **Ports**: every stdlib backend listens on `PORT`, 8000 when unset (`stdlib/backend/common.plain`) - so two backends on this machine at once meet on 8000. For an example that serves, `lsof -nP -iTCP -sTCP:LISTEN` and note what already holds 8000, 8001 and the frontend ports (5173, 4173). A port held by something you did not start is the person's - never stop it; it will meet the first launch, which is a test of its own (`docs/launch.md`: the launch fails and says what holds it).

Done when the example, both models, the commit and the held ports are written down.

### 2. Make the run folder

The project goes in a folder of its own inside the run folder, so turri's agents - which read the whole project - never read your run log or report:

```bash
RUN=~/turri-runs/$(date +%Y-%m-%d-%H%M)-<example>; P=$RUN/project
mkdir -p "$P" && cd "$P"
git rev-parse --is-inside-work-tree 2>/dev/null && echo "INSIDE A REPO - pick another folder"
turri init-config --harness-model <harness> --coding-model <coding>
sed -i '' -e 's/^sentinel: ask/sentinel: true/' -e 's/^debug: false/debug: true/' config.turri.yaml
grep -n '^debug\|^sentinel\|^launch-after-pulse' config.turri.yaml    # all three true
```

init-config writes `launch-after-pulse: true`, `sentinel: ask` and `debug: false`; the `sed` turns on the sentinel without its start-up dialog, and debug mode, which keeps every agent's log (`.turri/debug/`), each pulse's log (`.turri/jobs/`) and the agents' sessions (`.turri/sessions/`). Leave every other key as init-config wrote it - defaults are what people get.

Run `turri doctor` in `$P`. Done when it shows no `✗`; a `✗` you cannot fix stops the run - tell the person what it says. Doctor checks a toolchain is there, not its version or its extra tools: check those in step 4, once the chat has picked a stack.

The run folder lives outside every repo, and nothing from it is ever committed or copied into a repo or the vault: it is studied, then left behind.

### 3. Start turri in tmux

```bash
S=turri-<example>
tmux new-session -d -s "$S" -x 220 -y 60 -c "$P" 'caffeinate -is turri'
```

`caffeinate` keeps the Mac awake for as long as turri runs. Without it the machine idle-sleeps mid-run while nobody types, every model call freezes, and the ledger shows provider stalls and quarter-hour model calls that are the machine's, not the provider's.

Tell the person they can watch with `tmux attach -r -t <session>` (read-only). Read the screen with `tmux capture-pane -p -t "$S" | grep -v '^\s*$' | tail -40` - the pane is mostly blank lines; `-S -300` adds scrollback. What the screen holds, bottom up: the model and context line, with the chat's cost (`$1.02`); the folder; the editor between two rules; then `── ⠋ Working ──` while the chat's turn runs, or `── waiting for your answer ──`; above it a running pulse's line (`⠸ textstats · regenerate pulse 1 · 21s`) with its agent's latest call. The chat tabs are below the banner's rule, or at the top once the banner scrolls away; `▸` marks the one shown. The chat's thinking is drawn as plain lines too and reads like its reply - what it said is its session, not the screen. A warning that tmux `extended-keys` is off is harmless. Done when `node $SKILL/ledger.mjs chat "$S" --timeout 60` exits 0 - turri is up and idle.

**turri's process** is not the pane's: the ledger file's name ends in its pid - `.turri/ledger/<time>-<run>-p<pid>.jsonl`, the newest one (`ledger.mjs summary` prints it). That is the pid to `kill -9` for a crash.

### 4. Send the messages

Each `>` block of the example is one message: join its lines into one line, then

```bash
tmux send-keys -t "$S:0" -l "<message>"
tmux send-keys -t "$S:0" Enter
```

(`:0` - the first window - so a window you opened for something else never gets the keys.) Send each at the moment the example's prose says. Waiting has two helpers:

```bash
node $SKILL/ledger.mjs wait "$P" --until started:1     # a pulse is running - "don't wait for the first pulses"
node $SKILL/ledger.mjs wait "$P" --until landed:2      # counted over every run, restarts included
node $SKILL/ledger.mjs wait "$P" --until idle          # every pulse, launch and sentinel check ended, for 30 s
node $SKILL/ledger.mjs chat "$S"                       # the chat's turn is over - the ledger cannot see it
```

Where your harness re-invokes you when a background command ends, run them with `run_in_background: true` (and register it with a background-wait tool where there is one, such as T3's `t3_background_wait`). Where it does not - a subagent - run them in the foreground with `--timeout 540` and the Bash timeout at 600000, and run them again while they exit 2. Foreground `sleep` is blocked either way.

A message meant for "while X regenerates" goes once X has started and before it finishes - and, unless the example means to interrupt the chat, once `chat` exits 0 as well. Every other message waits for `chat` to exit 0: a message sent mid-turn reaches the chat in that turn, not as the person's next one. After `idle`, run `chat` too.

**Exit codes**: 3 means **the person is needed** - `wait`: a warning or error notice is open, or the work loop halted; `chat`: a dialog is on the screen. 2 means it timed out. Go to step 5, then come back.

**Once the chat has picked a stack** - the `.plain` imports `stdlib/<kind>/<stack>` - check the machine has what that stack pins: the version in `stdlib/lang/<language>.plain` (`go version`, `python3 --version`, `node --version`, `java -version`, `rustc --version`) and the tools its unit testing script runs (`rustup component list --installed` for rustfmt and clippy). A mismatch is an environment finding, and so is doctor not catching it. To fix one, install for the user only, never machine-wide, then `/quit` and start turri again with the new toolchain first on the PATH and its home set (`PATH=~/sdk/go1.25.4/bin:$PATH GOROOT=~/sdk/go1.25.4 caffeinate -is turri --continue`; `JAVA_HOME` for a JDK) - turri's environment is fixed when it starts, and the OS sandbox lets agents read a toolchain under the home folder only through what that environment names - and tell the chat what changed.

Done when every message is sent, in order, each at its moment, and after the last one `wait --until idle` and `chat` have both exited 0.

### 5. Answer as the person would

Two kinds of dialog come up, at the bottom of the screen:

- **A notice** - the sentinel's, or turri's: a card in the chat first, a dialog once the chat's turn is over. Its options: the numbered actions, `Ignore - leave it as the build has it` (only on a notice the sentinel marked ignorable), `Say what to do instead…`, `Dismiss`. `Escape` is `Dismiss` (`ctrl+c` too).
- **A question the chat asks** (`ask_user`): `› option … ↑↓ choose · enter picks · esc dismisses`, and free text where it offers it.
- **A picker a slash command opens** - `/halt` lists what it can halt (`↑↓`, `Enter`). Send a slash command as text with `-l`, then `Enter` on its own.

`Say what to do instead…` opens a text prompt (`>` and `enter submit`) that the blank-line filter can hide - read the last lines plainly (`capture-pane -p | tail -8`), type with `send-keys -l`, then `Enter`. Read the whole card with `capture-pane`, and answer as a person following the example would: accept the action that keeps the example on course; a notice repeating what you already settled with the chat, `Dismiss`; plainly noise, `Dismiss`. Move with `Up`/`Down` and `Enter` (`tmux send-keys -t "$S:0" Down Enter`); type free text with `send-keys -l`. A notice of severity `info` that says what the sentinel fixed itself may stay open with nothing to answer (`wait` does not stop for info notices) - note it and carry on; if the chat says it is waiting on one, tell it in a message what to do. A question the chat asks in prose that the example does not answer: answer it the way that keeps to the example's intent if one is plain, else leave it and note it.

Keep a **run log** in `$RUN/run-log.md` - beside the project, never in it - as you go: each message sent and when, each dialog with its text and your answer, anything on the screen that surprised you. It is your evidence later; the screen scrolls away. Pulse numbers and launch ids start again at 1 after a restart: name the run id with them.

A pulse running over 30 minutes, the same failure three times, or a halt you cannot answer from the example: write it in the run log, stop driving, and evaluate what you have.

### 6. Try what landed

With launch-after-pulse on, each landed pulse is launched; ask the chat where (`Where is it running?`) or read the last launch in the ledger, then **try it yourself** against what the example and the module's `.plain` say it does. Use inputs on which a wrong reading of the \*\*\*plain gives a different answer. Write each try and its result in the run log.

- **A server**: `curl` the URL the launch gave - `.turri/launch/running/*.json` has each one's url, command and pid.
- **A CLI or a library**: nothing runs - the launch exports the code to `dist/<module>` and says how to run it. Follow that from `dist/<module>`; where it needs a build the launch did not leave, build it yourself into a folder of your own under `$RUN`, and note an unbuilt `dist/<module>` as a finding. Run a CLI from a neutral folder (`cd /tmp`), never from the project: code that reads files relative to where it runs passes there and fails anywhere else.
- **A frontend**: there is no browser here. Fetch the page it serves, grep the built JS for the backend URL or path it calls, and call that path through the frontend's server (a dev or preview proxy) to see the backend answer; what only a browser shows (a form, a counter) you can still drive: build a copy of the frontend under `$RUN` and run the built bundle in jsdom from the project's own `node_modules`; otherwise check it in the code and the sentinel's session, and mark it so.

A launch the chat asks for - after a notice, `again` - is never tested by the sentinel: your tries are the only test of it.

Done when every behaviour the example asked for has been tried once, and each is marked works / wrong / not built.

### 7. Stop turri

Send `/quit`; the tmux session closes by itself once turri exits (`tmux has-session -t "$S"` fails). A `tmux new-session … turri-<x>` line left in `ps` is the shared tmux server, which keeps the first session's command line - not turri. Then check `ls "$P/.turri/launch/running/"` is empty or missing - whatever is listed there was left running, a finding of its own.

### 8. Evaluate

Read [EVALUATING.md](EVALUATING.md) and go through it whole. Done when every pulse that did not land, every retry, every notice, every entry under `trouble:` and every wrong behaviour from step 6 has a **cause** - turri, model, \*\*\*plain or environment - with the evidence that shows it.

### 9. Report

Write `$RUN/report.md` in the shape EVALUATING.md gives (where the Write tool refuses, write it with a Bash heredoc), then tell the person in chat: the verdict, each suspected turri bug in a line with its evidence, and the path to the report. The report stays in the run folder - never committed, never copied into a repo or the vault.
