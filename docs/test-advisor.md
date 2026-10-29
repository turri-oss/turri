# The test advisor

Which functional specs need explicit testing scenarios is not obvious, and not every one should be tested - only the functionality that matters. The test advisor decides for you: when a functional spec is new or its text changed and it has no scenarios - or when the chat asks - turri checks in the background whether it needs testing. When it does, the chat you are looking at tells you so and writes what testing it takes - the \*\*\*test reqs\*\*\*, the conformance testing script and its scenarios - so the module's conformance pulse runs once its code is built. The advisor decides; the chat is the only writer of the \*\*\*plain. You are never asked anything.

## When it runs

**Two ways in.** By itself, for every new or changed functional spec without scenarios, as below - what `test-advisor: false` turns off. And when the chat asks, with `evaluate_tests`, whatever the setting - see [asking for an evaluation](#asking-for-an-evaluation).

**Only in the chat and a host.** Never in a headless command - `turri regenerate`, `conform`, `change-plain` and the rest - and never in [pi](https://pi.dev)'s print, json and rpc modes (`turri -p`), which end when the answer is printed. That is decided where the session starts: the terminal's chat and a host's session have one, nothing else does.

**What it looks at by itself:** a functional spec, in any module, that is new or whose text changed since its code was built - measured against the code record, what the code was built from: text that differs from the record, or a functional spec not built yet. Then against the advisor's file: a text already looked at, under its hash, is not looked at again. So a fresh project's first functional specs are looked at, and a project already built that has no advisor file gets no backlog: only what changes from now on is.

**What it leaves alone:**
- a functional spec with scenarios of any kind - [today's review](regenerating.md#conformance-tests) of its scenarios covers it when its text changes
- the standard library's templates, which have no functional specs

**When:** by itself, as soon as the work loop sees a \*\*\*plain change - a `change_plain`, a `regenerate`, a pulse ending - beside the code pulse it plans. The functional spec is marked `pending` in the advisor's file there and then, so quitting loses nothing: the next start in the chat or a host picks up every `pending` entry.

**Two at a time at most,** outside `parallel-jobs` and the lanes: it never takes a pulse's slot, no pulse waits for it, and it never steers or stops one.

**A text that changes while it runs throws the work away,** whoever changed it - you, the chat's `change_plain`, a skill: what it had judged for the old text is dropped (`advisor.dropped`), and the new text starts again.

A failure - a model error, a call that never answered - is dropped quietly: the entry says `failed` and why, `advisor.failed` goes into the ledger, and the same text is not tried again. Nothing is shown.

## What you see

**Being evaluated.** A change's result - `regenerate`'s, `change_plain`'s - names the functional specs the advisor has just taken up, as `evaluate_tests` names the ones it was asked for, and the chat says in a line that testing scenarios are being evaluated for them, and goes on: there is nothing to wait for.

**A yes** comes back to the chat you are looking at as a message that starts a turn. It holds the report - the questions that were a yes with their evidence, and the inputs to cover - and the chat, asking you nothing, tells you in a line:

> core:clear-tasks needs testing scenarios - a wrong implementation could look right. Writing them now.

Then it writes, with `change_plain`, whatever the [step-7 guard](regenerating.md#the-steps-of-adding-tests) would refuse the scenarios for, in turn and only what is missing: the \*\*\*test reqs\*\*\* of the module it is tested in - the top of its chain, where its conformance tests live - the stack's conformance template, `stdlib/<kind>/conformance/<stack>`, imported, or the module's own; the conformance testing script for its stack, with `implement-conformance-testing-script`; then the scenarios, in `tests/<module>/<func-id>.plain`. They cover the report's inputs that are this functional spec's - an agreed one with the readers' output, never a placeholder - and a split one is settled by the reading most consistent with the functional spec and its module, the chat saying which it took. The change is visible as any is, and the conformance pulse follows once the code is built.

**A no** is one line turri draws itself, starting no turn and reaching no model:

> core:list-tasks doesn't need testing scenarios - nothing silent to get wrong.

**Never an interruption.** A verdict that arrives while the chat is busy - its agent working, or you typing - waits until it is idle; verdicts that arrive meanwhile come together, as one turn for every yes and a line for each no. One whose functional spec changed meanwhile, or was given scenarios, is let go. A yes is kept in the advisor's file until a chat has it: one that arrives with no chat open, or whose session ends first, is delivered at the next start, as `pending` work is picked up.

Asked for scenarios - "write conformance scenarios for core:add-task" - the chat decides and writes them itself, as a \*\*\*plain change you see, whatever `test-advisor` says.

A host gets the verdicts in its chats the same way - see [hosting](hosting.md).

## Asking for an evaluation

The chat has a tool of its own, `evaluate_tests`: the functional specs as `module:func-id`s - or func-ids, with `plain_file` - and an optional `reason`. It returns at once - "Testing scenarios for core:add-task are being evaluated in the background; the verdict comes back to this chat." - and the verdict comes back as any verdict does. The chat calls it:

- when you ask whether something needs tests - "does add-task need tests?";
- on its own, as another way of saying what a functional spec means: when pulses keep failing on a complicated one, say, scenarios may pin down what it should do.

It evaluates even a text the advisor already judged. A functional spec being evaluated already is not started twice, and one that has scenarios is answered at once as such and not evaluated. It works whatever `test-advisor` says. The `reason` - "the coding agent failed three times to implement it" - reaches the classifier as context, never as evidence.

## How it decides

Every step is a plain model call on the advisor's model, answered through one tool and checked by turri - none of them is a skill, and none can touch the project. Each is given the functional spec, its module whole - and for a module below, the tip its scenarios are tested in, whose own functional specs show in the same commands - and the project's own words on what matters: its `AGENTS.md`, and what you said in the conversation about how the work is to be planned. There is no keyword filter and no confidence score.

**Classifying** is one call with four questions, each yes backed by evidence:

| question | a yes needs |
| --- | --- |
| silent failure: could a wrong implementation give output that looks right? | one such wrong output |
| divergence: is there an input two reasonable readings answer differently? | the input, and both outputs |
| revisited: is it likely to be changed or built on later? | what would change |
| cost: would a bug cost money, expose something, lose data or harm users' trust? | the consequence |

A yes whose evidence is empty or malformed - two readings that are the same - counts as no. The verdict is **yes** when silent failure, divergence or cost is a yes; revisited alone, or all four no, is **no**: the coding agent's unit tests are the regression protection there. A no costs one call, and ends there.

**On a yes, the inputs** the scenarios are to cover are picked by readers that disagree on purpose:

1. **Probes:** one call writes concrete boundary inputs, as many as the functional spec has real boundaries - one to ten, never padded to a number - limits, empty and missing values, the cases the wording leaves open - and the divergence's input joins them. Only inputs the functional spec bears on: never a command, flag or alias it does not name.
2. **Readers:** each predicts every probe's output. There are three - a literal reader, an edge-case hunter, and a reader from another domain - the same call on the same model, differing only by their system prompt. Two run first; when they already disagree on a probe, the third is spared. A reader answers `unspecified` for an input the functional spec says nothing about.
3. **Comparing,** in code: the outputs are compared with whitespace and case left aside, and any disagreement makes the input a candidate - the union of the readers, never a majority.
4. **Verifying:** one last call keeps, of each candidate, the readings a reasonable person could hold. A candidate left with one is an agreed input; one left with none is dropped. An input whose `unspecified` holds - every reader's, or one the verifier keeps - is left out: a scenario on it would pin a guess, testing more than the functional spec says.

The **report** is what the advisor's file keeps: the questions that were a yes with their evidence, and each input, either agreed - with the readers' output - or split, with its readings.

## The setting and its model

`test-advisor: true | false` in `config.turri.yaml`, `true` when it is left out - `/turri-config` sets it. `false` turns off only the advisor's own start: `evaluate_tests` still works, and asked for scenarios, the chat writes them as it always has, whatever the setting says.

Every call the advisor makes runs on `models.advisor` - see [models per role](config.md#models-per-role). Without one it runs on `default`'s model, else the coding model alone, thinking low.

## What it keeps

What the advisor made of each functional spec is in `.turri/advisor/<module>.json`, in the project - local to this machine, as all of `.turri/` is: another machine starts with none, and looks only at what changes there. One entry a functional spec, by its func-id:

| | |
| --- | --- |
| `hash` | a hash of the functional spec's text: the entry is about that text, and stale once it changes |
| `state` | `pending` - seen, not finished; `yes`; `no`; or `failed` |
| `report` | the verdict, the questions that were a yes with their evidence, and on a yes the inputs to cover |
| `model`, `at` | what it ran on, and when |
| `tip` | the module at the top of its chain, where its scenarios are tested |
| `undelivered` | a yes no chat has had yet: delivered at the next start |
| `asked` | pending at the chat's asking, with its reason: picked up at the next start whatever `test-advisor` says |

Deleting the folder loses only what the advisor knows: an entry that is not there is a functional spec it has not looked at.

## In the ledger

Three facts go into [the ledger](using.md#the-ledger), the report staying in the advisor's file:

| event | |
| --- | --- |
| `advisor.classified` | the functional spec, `module:func-id`, its verdict, the questions that were a yes, and whether the chat asked for it (`asked: true`) or a change started it |
| `advisor.dropped` | the work on a functional spec thrown away, its text changed while it ran |
| `advisor.failed` | why it failed |
