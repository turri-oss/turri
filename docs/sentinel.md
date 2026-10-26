# The sentinel

The sentinel is a chat of turri's own, beside the chats you talk to. Every pulse that finishes goes to it: it checks how the pulse went - and, with `release-after-pulse` on, tests what was released - and when something needs you, it says so in the chat you are in, with what can be done about it. You go on talking about the software, and building it, while it watches what lands.

`sentinel:` in `config.turri.yaml` says whether there is one: `ask`, as it is unset - you are asked before it first opens in a session (below); `true` - it opens without asking; `false` - none. It is there in the terminal and in a host such as turri-desktop - wherever turri holds [chats](chats.md) - and not in pi's print, json or rpc modes, nor on the command line (`turri regenerate`, `turri change-plain`), which have no chat to tell: there a pulse is told as it is without it.

## Starting it

Under `sentinel: ask`, a tab that starts working on its own is not sprung on you. When the first pulse of a session finishes, turri asks first - a notice of its own in the chat you are in, before the sentinel opens, in one sentence: `app · regenerate pulse 3 finished - start the sentinel, a background tab that reviews each finished pulse and tries to use what was released?` - the release left out with `release-after-pulse` off. In the terminal it is a dialog once that chat is not mid-turn, with how to switch to the sentinel once it is open - `Use "/chat 2" to open the sentinel.`, the number the one it will have in the strip; in a host, a notice with `kind: "sentinel-start"` (see [in a host](#in-a-host)). You answer:

- **Start the sentinel** - it opens, and checks this pulse and each after it this session;
- **Start it, and don't ask again** - the same, and `sentinel: true` is written to `config.turri.yaml`;
- **Not this session**, or `esc` - no sentinel until turri starts again: each pulse is told to the chat that asked for it, as without one;
- **Turn it off for this project** - `sentinel: false` is written.

Nothing goes to the sentinel, or to your chat, until you answer: the pulses that finish meanwhile are held, and go to it - or to their chats - as you say. You are asked once a session: a sentinel closed and opened again by the next pulse is not asked for again, nor one `turri --continue` reopened. Close the chat it was asked in, and it is asked again in the one you look at.

`/sentinel` sets it from the chat - `/sentinel ask`, `/sentinel on`, `/sentinel off`, or `/sentinel` alone to pick - written to `config.turri.yaml` as `/turri-config sentinel` does.

## What you see

- **In the chat you are in**, a pulse that finishes shows as it always has - `✓ app · regenerate pulse 3 finished after 4m 10s`, and for one that went wrong, where to see why. A pulse that landed is told to the chat's agent, which tells you in a line or two what landed and what the sentinel is doing with it - and again, in a line, when the sentinel is done with it - checking it, testing what was released - and does nothing else about it: it does not test, release or open it, nor do what the project's guidance says to do once a pulse finishes. The pulse is the sentinel's. A pulse that went wrong is not told to it: the sentinel looks into it, and you hear of it as a notice.
- **The sentinel** opens with the first pulse that finishes - once you said to start it, under `sentinel: ask` - in the background: it never takes the screen, and you stay in your chat. It is a tab in the strip like any other chat - `sentinel` - marked while it works and when it has something new. Switch to it to read what it checked.
- **A notice**, when something needs you: a card in the chat you are in - what is wrong, what shows it, and what can be done, numbered - and, in the terminal, once that chat is not mid-turn, a dialog on it:
  - `enter` on an action accepts it: the chat's agent is started on it - a change to the \*\*\*plain, a pulse regenerated again, a credential to provide, a setting to change;
  - **Say what to do instead…** - your own words, and the agent does that;
  - **Dismiss**, or `esc`: nothing is done.

  Nothing is done without your answer. A notice goes to the chat you are in; while you are in the sentinel's, to the chat that asked for the pulse. There is one open notice a module: a newer one about the same module supersedes the older one, whose call to action would be stale, and the card says so.

## What it does

For each pulse that finishes, turri writes the sentinel what it was and how it ended - its stages, rounds and failures as the [ledger](using.md#the-ledger) has them, its \*\*\*plain diff, its log, the chat that asked for it, the chat you are in, and what was released and where it runs. Then it:

1. **checks the pulse** - from what it is told, and when that is not enough, from the pulse's log, the ledger (`ledger`, `pulses`), `diagnose`, the code and the \*\*\*plain;
2. **tests the release**, with `release-after-pulse` on: what was released is running where it is told, and it tries it - in the terminal with its shell (`curl`, the program itself, the logs), in a host also with what the host gives it, a browser say. How far it tests is its own judgement, from what the pulse changed and what the \*\*\*plain says it now does. With `release-after-pulse` off nothing is running, and it checks the pulse alone;
3. **finds out why**, when something is wrong - the pulse failed or stopped, it did not pass, the release did not come up, the software does not do what its \*\*\*plain says - and puts it to you as a notice, each action a task your chat's agent can carry out once you accept it;
4. **notifies no one** when all is well;
5. **concludes**, last, whether all is well or not: what it checked and what it found, in a line or two. The chat you are in shows it - `✓ sentinel · app · pulse 3 · checked, it holds` - and its agent tells you so in a line, and does nothing more; when something was wrong, that its notice says what.

A pulse that went well is checked until a newer pulse of its module finishes: that one is checked instead. A pulse that went wrong is looked into to its end. Two functional specs that contradict each other stop a pulse in a way only you can settle: turri puts that notice itself, with an action that starts your chat on working it out with you.

## What it may do

Nothing that changes the project. Its file tools - `read`, `ls`, `grep`, `find` - read the whole project, its \*\*\*plain among them, and write nothing; its shell runs [behind the walls](sandbox.md) every agent's does - the command check, the OS sandbox where one is up, the audit - with the project read only and the network open, its home and temporary folder its own. It has `ledger`, `pulses`, `diagnose`, `validate`, `doctor` and the web, `notify_person` for its notices, `conclude` for when it is done with a pulse, `keep_guidance`, and what a host gives it. Whatever else it calls is refused: it never regenerates, steers, releases or changes \*\*\*plain, and never asks you a question - a notice is how it reaches you. What it found to do is yours to accept.

## Talking to it

Switch to its chat and say how to check your software - *test the sign-up flow at a phone's width*, *ignore the styling*, *the API runs on port 8080*. What should hold from now on it keeps with `keep_guidance`, in `.turri/sentinel.md`, and it is in its prompt from then on - after it is closed and opened again too.

## Closing it

It closes like any chat (`/chat close`, `alt+w`, a host's `closeChat`), and that does not turn it off: the next pulse that finishes opens it again, with a fresh conversation - and your guidance. `turri --continue` reopens it with the other chats, as it was. `sentinel: false` - in `config.turri.yaml`, or with `/sentinel off` or `/turri-config` - turns it off: from the next pulse that finishes, a pulse is told to the chat that asked for it, whose agent reacts to it, as without one.

It has a slot of its own: with it on, you open up to eight chats, and the ninth is the sentinel's, open or not.

## Its model

The `sentinel` role in `models:` - else the chat's model, `models.chat` else `harness-model`, with its thinking - see [models](config.md#models). A `sentinel` entry that gives only `thinking` runs on the chat's model, thinking as it says. It is set as the sentinel's chat opens, in the terminal and in a host alike - never the model its session started on, which in a host is [pi](https://pi.dev)'s default and may not be one the project's provider has. What the person then picks in its chat stands. Judging behaviour against \*\*\*plain, and driving a browser, want a capable model; point it at a cheaper one if it costs too much for every pulse.

## In a host

A host sees the sentinel as one of its chats - `role: "sentinel"` in `chats()` and `onChats` - and never has focus moved to it. Under `sentinel: ask`, the question before it first opens comes as a notice like the others, with `kind: "sentinel-start"`, its actions the four answers: `answer(id, { action })` answers it - by index or label - and `{ dismiss: true }` is not this session. Each notice comes as `onNotice(notice)` - `{ id, chat, module, pulse, job, severity, summary, evidence, actions, state }`, `chat` the one to draw it in - and `onNoticeOver(notice)` when it is answered or superseded; `notices()` lists those open. `answer(id, { action } | { steer } | { dismiss: true })` answers one, as the terminal's dialog does. `onConcluded({ job, verdict: "holds" | "wrong", summary, module, pulse, chat })` comes as it is done with a pulse, all well or not - told to the chat `chat` too. The sentinel's own tools - a browser - are given with `createTurri({ sentinel: { tools } })`, and it is told it has them. `sentinel: { surface }` says, in the host's words, where the person watches it use them: then it tries a release with them, where the person can watch, and keeps its shell for what they cannot show - logs, exit codes, files. Without it, the person does not watch the sentinel, and the host's tools are only to test with as well. See [running turri in a host](hosting.md#the-sentinel).

## In the ledger

`chat.opened` carries `role: "sentinel"` for its chat; `notice.put` and `notice.over` record each notice - the question before it opens among them - - its severity and module, and how it ended: `accepted`, `steered`, `dismissed`, `superseded` - and `sentinel.concluded` each pulse it is done with, `holds` or `wrong`.
