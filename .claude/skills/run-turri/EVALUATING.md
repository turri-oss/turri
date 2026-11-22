# Evaluating a turri run

The run is judged from what turri recorded. The chat's prose and the agents' own summaries are claims; the ledger, the scripts' exit codes, the commits and the running software are evidence.

## Where the evidence is

| what | where | read it for |
| --- | --- | --- |
| the ledger | `node $SKILL/ledger.mjs summary "$P"`, then `$P/.turri/ledger/*.jsonl` for the raw events | every pulse queued to finished, gate rounds, reviews, retries, turns stopped, provider trouble, refusals, launches, the sentinel, notices, halts |
| why a pulse did not land | `.turri/pulses/<pulse-id>.md` - no folder when none failed | its diagnosis, the last failing test output, the last review, the failed tool calls |
| a pulse's log | `.turri/jobs/*.log` (debug mode) | its agents, its test runs, how it ended |
| an agent's whole conversation | `.turri/debug/` - the coding agents' and planners' logs; `.turri/sessions/` - their saved sessions (debug mode) | what it was told, what it did, where it went wrong |
| any session, read in order | `node $SKILL/ledger.mjs session <file.jsonl> [--grep <text>]` - user messages, replies, tool calls and results, one line each | why an agent did what it did; the full text of a refusal the ledger records only as `rule: path` |
| the chat's and the sentinel's conversations | `.turri/chats.json` names each chat's `sessionFile`, under `~/.pi/agent/sessions/` - the sentinel's latest only; its conversations for earlier pulses are the other files in that folder, by time (debug mode keeps them) | what the chat said and did, in order: each assistant message's `toolCall`s and each `toolResult` |
| the \*\*\*plain | `$P/*.plain`, the test plain files under `tests/` | what was asked for - the yardstick for the code and for the chat |
| each pulse's \*\*\*plain diff | the `job.diff` events | what the pulse was given to build |
| the code and its history | `plain_modules/<module>/code`; `git --git-dir=plain_modules/<module>/.plaingit --work-tree=plain_modules/<module> log --stat` | what landed, commit by commit |
| what you saw and did | `$RUN/run-log.md` | the screen, the dialogs, your tries |

turri's own docs say what *should* have happened: `docs/regenerating.md`, `docs/launch.md`, `docs/sentinel.md`, `docs/chats.md`. A behaviour that contradicts them is a finding, whichever side is wrong.

## Classify every problem

Each pulse that did not land, each retry or turn stopped, each notice, each `trouble:` line and each wrong behaviour from the tries gets exactly one **cause**:

- **turri** - the harness did the wrong thing: a plan that builds the wrong thing or in the wrong order, a pulse stopped or steered when it should not have been (or not when it should), a refusal of something legitimate, a crash, a stuck wait, a launch or sentinel check out of order, records that disagree with the code, a prompt or tool text that sent an agent the wrong way, the chat doing what its rules forbid. These are the findings that matter most.
- **model** - an agent made a mistake on a fair, well-posed task, and turri caught it and recovered (or should have - then it is also turri).
- **\*\*\*plain** - what the chat wrote leaves the behaviour open or says the wrong thing. The chat writing it is turri's chat, so a \*\*\*plain the person's words did not justify leans towards turri.
- **environment** - the provider (`provider.*`), a missing toolchain, the machine. Before blaming the provider for a `provider.stall` or a model call of many minutes, check the machine did not sleep then: `pmset -g log | grep -E ' (Sleep|DarkWake|Wake) '` around the times (the ledger is UTC, pmset local).

For a turri cause, find where it lives: the source file and line in `src/` if you can trace it, else the doc it contradicts. Evidence is a ledger line (the ledger's run id - `.turri/chats.json` keeps an id of its own - and `seq`; seq and pulse numbers start again with each run), a pulse report, a debug-log excerpt or a command and its output - something the person can open.

## The verdict

**Pass** when all three hold:

1. every pulse landed - a pulse stopped or rolled back because the person dropped or changed what it built counts as landing as intended;
2. every behaviour tried in step 6 does what the \*\*\*plain says;
3. no problem is classified **turri**.

Anything else is **fail**, naming which of the three broke. Wall-clock time, pulses, gate rounds and cost are reported, never a reason to fail.

## The report

`$RUN/report.md`:

```markdown
# <example> - <date> - PASS | FAIL

turri <commit><, dirty>; harness <model>, coding <model>; <wall-clock>, <pulses> pulses (<landed> landed); cost: pulses $<x>, model calls in the ledger $<y>, the chat $<z> and the sentinel $<w> (the summary's last line)

## Verdict
<one paragraph: what passed, what broke, which of the three>

## turri bugs
<each: what happened, what should have, evidence, where in turri - or "none">

## Other problems
<each model / ***plain / environment problem in a line, with its cause and evidence>

## Pulses
<the ledger summary's pulse lines, trimmed>

## What was tried
<each behaviour: the try, works / wrong / not built>

## Worth a look
<anything odd that is not a problem yet: a slow stage, a long wait for a lane, a notice that said little>
```
