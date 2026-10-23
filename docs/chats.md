# Chats

One `turri` is one session on one project, and a session holds up to nine chats: conversations with turri side by side, each working while you look at another. Ask one chat to regenerate the backend and open another to talk the frontend's \*\*\*plain through; the first goes on with its turn, its tools and its pulses meanwhile.

## What each chat keeps, and what they share

Each chat has its own:

- **history** - what was said in it, and nothing said in another; a chat asked about another's says so and asks;
- **turns** - a hidden chat keeps working, and starts a turn of its own when a pulse it asked for ends;
- **model and thinking level** - [pi](https://pi.dev)'s `/model`, and `/turri-config harness-model` in that chat;
- **stack** - `/stack` and the chat's `stack` tool choose it for that chat alone; a new chat starts with `--stack`'s, or none (see [stacks](config.md#stacks));
- **questions** - what it asks waits in it until you look at it.

The session's, shared by every chat:

- **the pulses and their plan** - one job registry and one work loop on the project: a pulse any chat starts is in every chat's side panel and `pulses`, and two chats asking for the same module get one plan, not two;
- **the coding model** chosen with `engine` or `--coding-model`, and `parallel-jobs`;
- **steering** - what `steer` was told, every plan follows;
- **conformance** chosen with `conform`, module by module;
- **what `activate` started** - it runs until turri ends or `/halt activated <name>`, whatever chats are opened or closed;
- **the ledger** - one run, each event with the id of the chat its work was asked for in (`chat`), and `chat.opened` and `chat.closed` as they happen.

A pulse's end is told to the chat that asked for it, shown or not - its agent reacts to it there; the chat's mark in the strip says it has something new. When that chat has been closed, the chat shown is told. Closing a chat stops its turn, never its pulses.

## In the terminal

| | |
| --- | --- |
| `/chat new`, `alt+n` | a fresh chat, with the session's settings and an empty history, shown at once |
| `/chat 2`, `alt+2` | chat 2, shown - `alt+1` … `alt+9` |
| `/chat close`, `alt+w` | the chat shown, closed - and the next one shown; `/chat close 3` closes chat 3 |
| `/chat` | a list of the chats, to pick one - or a new one |
| `/new` | the same as `/chat new` |
| `/resume` | a saved chat, opened as a chat of its own beside the others - or shown, when it is open |
| `ctrl+c` | what the chat shown is doing, stopped - its turn, a skill or a tool in it, a `!` command, a compaction; in a chat doing nothing, a draft in the editor cleared, else turri left, every chat with it |

A line above the editor names each chat once there are two, a `│` between them: its number, its title - "new chat" until something is said in it, then its first message, until `/name` gives it one - and, after it, what it is doing: a spinner while it works, `?` while a question waits in it, `•` when it said something since you last looked. The chat shown is in the accent colour.

A message you send while a chat's agent works is shown under the chat at once, shaded and marked `not read yet`, and stays under what the agent writes and the tools it calls until the agent reads it - at the end of its current step - when it goes into the chat as a normal message, where it was read. `alt+up` takes the messages waiting back into the editor (`src/chat-waiting.ts`). While a skill runs in the chat - `/brood`, `/spawn`, `/bud` - its own agent is the one at work, and the chat's waits for the whole run: what you type then goes to the skill's agent, shown waiting until it reads it, at the end of its current step - and is in the chat from then, where it was read. The chat's agent is told what you said to the skill when the run ends. A message the skill's agent has not read when the run ends goes to the chat's agent instead.

On macOS, `alt` is Option (⌥), and reaches turri only when the terminal sends Option as Meta - otherwise ⌥N is the dead key for ñ and ⌥1 types `¡`, and nothing reaches turri. turri says so as a session's second chat opens. To turn it on: Ghostty, `macos-option-as-alt = true` in its config; iTerm2, Profiles → Keys → Left Option key: Esc+; Terminal.app, Profiles → Keyboard → Use Option as Meta key; Kitty, `macos_option_as_alt yes`; WezTerm, `send_composed_key_when_left_alt_is_pressed = false`. `/chat` works without it.

- **A hidden chat's questions** wait until you show it, then come up one after another. What it says in passing is said as you show it; what it keeps on the screen - a skill's progress, the job panel - is put back each time; what you had typed in its editor and not sent is still there.
- **The side panel** (`ctrl+h`) is the session's, not a chat's: docked beside the chat or over it, it stays as another chat is shown, and opening it from any chat finds it as it was left.
- **A long command** - `/regenerate`, planning a module from scratch - does its work in the background once it is under way: the chat, and switching to another, stay free while the planner plans.
- **`ctrl+c`** reaches the chat shown and nothing else: another chat's turn and skill go on, and so do the pulses - `/halt` stops one. A skill stopped keeps its run, for the model to continue with `resume`. At a question - the chat's `ask_user`, a skill's interview - `ctrl+c` declines it, and the asker is told so and goes on - each question it is pressed at, however many in a row. A skill is stopped by `ctrl+c` with no question open. A second press straight after one that stopped something does nothing, so pressing twice to be sure does not leave turri; once the chat is doing nothing, the next one does - with what every other chat is doing. A host has the same as `interrupt(id)`, and `decline(id)` for a question ([hosting](hosting.md)).
- **The last chat** is not closed: `/quit` leaves turri.
- **`/fork`** and **`/reload`** work on the chat shown, as [pi](https://pi.dev)'s do: the chat's history forked, or turri's extension rebuilt in it.
- **A chat shown mid-turn** draws its reply as far as it is written, and follows it from there.

## Coming back

`turri --continue` (`-c`) opens every chat of the last session here again, in their order - the first shown, the others beside it. A plain `turri` starts with one fresh chat and deletes nothing: the chats of the sessions before stay on disk, and `--continue` opens the most recent one's - the last session that recorded a chat.

turri records which chats are open in `.turri/chats.json` - a run a session, each chat with its title and [pi](https://pi.dev)'s saved conversation - and keeps it from piling up:

- **a chat closed** is gone: out of the record, its conversation deleted - it cannot be resumed;
- **a chat nothing was said in** is never recorded;
- **a session's chats** are kept until five newer sessions have recorded theirs, then deleted with their record;
- a session still running is never reopened by another turri.

In [debug mode](config.md#debug-mode) nothing is deleted. The `engine`'s choices come back too: the coding model a reopened chat chose, when it is newer than the session's.

## Where there is one chat

[pi](https://pi.dev)'s print, json and rpc modes - `turri -p "…"`, `--mode json`, `--mode rpc` - and a `turri` given its input on stdin have one chat and record none. So does `npm run chat`, pi with turri's extension loaded from its file. The command line's `turri regenerate`, `conform` and the rest have no chat.

## In a host

A host - turri's desktop app - runs the same session with `createTurri`, opening, closing and showing chats in its own windows: see [running turri in a host](hosting.md#the-session-in-a-host).

## How it works

`src/chats.ts` is the session: its chats, their status, which chat a pulse is reported to, and the record (`src/chat-records.ts`). turri's extension is built into each chat's [pi](https://pi.dev) session and links itself to its chat; every tool, command and handler it registers runs inside the chat's scope (`src/chat-scope.ts`), which carries the chat's id - onto the pulses it queues and the ledger's events - and its stack.

In the terminal (`src/chat-terminal.ts`), [pi](https://pi.dev)'s screen shows one session at a time, and replaces it - disposing the old one - on `/new` and `/resume`. turri instead puts the chosen chat's live session in pi's runtime and has the screen drawn from it again, nothing disposed. A hidden chat draws on a stand-in for the screen (`src/chat-ui.ts`) that holds its dialogs, notices and widgets until it is shown. pi has no hooks for this: its classes are patched where `pi-launch.ts` starts it, and `tests/chat-terminal.test.ts` checks they still have what is patched.
