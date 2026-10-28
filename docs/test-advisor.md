# The test advisor

Which functional specs need explicit testing scenarios is not obvious, and not every one should be tested - only the functionality that matters. The test advisor decides for you: when a functional spec is new or its text changed and it has no scenarios, turri checks in the background whether it needs testing, and when it does, writes what testing it takes itself - the \*\*\*test reqs\*\*\*, the conformance testing script and its scenarios - so the module's conformance pulse runs once its code is built. You are never asked anything.

## When it runs

**Only in the chat and a host.** Never in a headless command - `turri regenerate`, `conform`, `change-plain` and the rest change no \*\*\*plain in any way - and never in [pi](https://pi.dev)'s print, json and rpc modes (`turri -p`), which end when the answer is printed. That is decided where the session starts: the terminal's chat and a host's session have one, nothing else does.

**What it looks at:** a functional spec, in any module, that is new or whose text changed since its code was built - measured against the code record, what the code was built from: text that differs from the record, or a functional spec not built yet. Then against the advisor's file: a text already looked at, under its hash, is not looked at again. So a fresh project's first functional specs are looked at, and a project already built that has no advisor file gets no backlog: only what changes from now on is.

**What it leaves alone:**
- a functional spec with scenarios of yours - [today's review](regenerating.md#conformance-tests) of its scenarios covers it when its text changes
- the standard library's templates, which have no functional specs

**When:** as soon as the work loop sees a \*\*\*plain change - a `change_plain`, a `regenerate`, a pulse ending - beside the code pulse it plans. The functional spec is marked `pending` in the advisor's file there and then, so quitting loses nothing: the next start in the chat or a host picks up every `pending` entry.

**Two at a time at most,** outside `parallel-jobs` and the lanes: it never takes a pulse's slot, no pulse waits for it, and it never steers or stops one.

**A text that changes while it runs throws the work away,** whoever changed it - you, the chat's `change_plain`, a skill: what it had judged or written for the old text is dropped (`advisor.dropped`), and the new text starts again.

A failure - a model error, a call that never answered - is dropped quietly: the entry says `failed` and why, `advisor.failed` goes into the ledger, and the same text is not tried again. Nothing is shown.

## What you see

Nothing while it runs. When scenarios land, one line in the chat you are looking at, after the fact, the way a pulse that landed is mentioned:

> I added 3 scenarios to core:add-task - a wrong implementation could look right. They're tested once its code is built.

The reason is the first question that made the verdict a yes, and the line says when the \*\*\*test reqs\*\*\* or a conformance testing script were written with them. The conformance pulse then shows in the panel like any other. A "no" shows nothing: it is only in the advisor's file and the ledger. The map shows turri's scenarios like yours, with no mark.

The chat's agent is told the report's gist with the line - the questions that were a yes, with their evidence - so it can answer "why are there tests on add-task?". It starts no turn over it, and it never re-does or extends the advisor's scenarios unless you ask. It knows the other path too: asked for scenarios, it decides and writes them itself, as a \*\*\*plain change you see.

A host hears the `advisor.*` events through `onLedgerEvent`, and the line the way the chat has it - see [hosting](hosting.md). Nothing else is new for it.

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

1. **Probes:** one call writes 5 to 10 concrete boundary inputs - limits, empty and missing values, the cases the wording leaves open - and the divergence's input joins them. Only inputs the functional spec bears on: never a command, flag or alias it does not name.
2. **Readers:** each predicts every probe's output. There are three - a literal reader, an edge-case hunter, and a reader from another domain - the same call on the same model, differing only by their system prompt. Two run first; when they already disagree on a probe, the third is spared. A reader answers `unspecified` for an input the functional spec says nothing about.
3. **Comparing,** in code: the outputs are compared with whitespace and case left aside, and any disagreement makes the input a candidate - the union of the readers, never a majority.
4. **Verifying:** one last call keeps, of each candidate, the readings a reasonable person could hold. A candidate left with one is an agreed input; one left with none is dropped. An input whose `unspecified` holds - every reader's, or one the verifier keeps - is left out: a scenario on it would pin a guess, testing more than the functional spec says.

The **report** is what the advisor's file keeps: the questions that were a yes with their evidence, and each input, either agreed - with the readers' output - or split, with its readings.

## What it writes on a yes

What the [step-7 guard](regenerating.md#the-steps-of-adding-tests) would refuse the scenarios for, in turn - only what is missing:

1. **The \*\*\*test reqs\*\*\*, in the tip** - the module at the top of the chain, where its conformance tests live. When the tip's stack has a conformance template in the standard library, `stdlib/<kind>/conformance/<stack>`, turri adds its import to the tip's frontmatter itself. Otherwise one call on the advisor's model writes a `***test reqs***` section, each req a line about `:ConformanceTests:`.
2. **The conformance testing script,** for the tip's stack: the `implement-conformance-testing-script` skill. It is accepted unread, as a script the chat writes is - it runs on this machine, unfenced, like every testing script (see [the sandbox](sandbox.md)).
3. **The scenarios:** the `write-test-scenarios` skill, from the report, into `tests/<module>/<func-id>.plain`. It covers each input of the report, an agreed input with the readers' output, and settles a split one by the reading most consistent with the functional spec, its module and the project's conventions, saying why. Its gate's judge - the `judge` role - checks that each scenario covers an input of the report, that an agreed input gets the readers' output, that a split one carries the writer's reading and why, that the scenario-ids are unique, and that the test plain file passes `validate`.

A test reqs section and a script already there are left as they are.

**In the background, with no sign of it:** no pulse in the panel, no spinner, no chat turn. The skills are started by turri itself rather than by `cultivate`, with nobody to ask: a gate that cannot be satisfied is not let through. They work on a copy of the project's \*\*\*plain - its `.plain` files, test plain files, linked resources, testing scripts and `config.turri*.yaml` - in `.turri/advisor/work/`, and everything lands at the end as one \*\*\*plain change, brought up through the work loop as any change is. Test plain files and \*\*\*test reqs\*\*\* are not in the code record, so landing never steers or stops a code pulse: the module's conformance pulse follows once its code is built, as for scenarios you write. Stopped - its text changed, turri quits - the copy is thrown away, and nothing half-written reaches the project. A text, or a file the change touches, that changed in the project while it wrote drops the work instead of landing it, and the functional spec is looked at again as it now is. In [debug mode](config.md#debug-mode) the copy is kept, with its agents' sessions and logs.

**Your edits win.** A scenario stays turri's only while its scenario-id and text hash match what the advisor's file has for it. When a functional spec's text changes and its scenarios are all still turri's, it is looked at again, and its writer may replace them; one you changed, or wrote beside them, makes them yours, and the functional spec is left to [today's review](regenerating.md#conformance-tests) from then on. One you deleted stays deleted while the text is the same; once the text changes, the functional spec is looked at as one with no scenarios of yours.

A failed gate or a model error writes nothing, records `failed` and `advisor.failed`, and is tried again only once the functional spec's text changes.

**`write-test-scenarios` is not how the chat writes scenarios.** Asked for scenarios - "write conformance scenarios for core:add-task" - the chat decides and writes them itself, as a \*\*\*plain change you see, whatever `test-advisor` says. The skill runs in the foreground only when you ask for it by name, through `cultivate`.

## The setting and its model

`test-advisor: true | false` in `config.turri.yaml`, `true` when it is left out - `/turri-config` sets it. `false` turns off only the advisor's own work: asked for scenarios, the chat writes them as it always has, whatever the setting says.

Every call the advisor makes, and every agent it starts, runs on `models.advisor` - see [models per role](config.md#models-per-role). Without one it runs on `default`'s model, else the coding model alone, thinking low. The judges of its scenarios are the `judge` role's.

## What it keeps

What the advisor made of each functional spec is in `.turri/advisor/<module>.json`, in the project - local to this machine, as all of `.turri/` is: another machine starts with none, and looks only at what changes there. One entry a functional spec, by its func-id:

| | |
| --- | --- |
| `hash` | a hash of the functional spec's text: the entry is about that text, and stale once it changes |
| `state` | `pending` - seen, not finished; `yes`; `no`; or `failed` |
| `report` | the verdict, the questions that were a yes with their evidence, and on a yes the inputs to cover |
| `model`, `at` | what it ran on, and when |
| `scenarios` | the scenarios turri wrote for this text, each with its kind, scenario-id and a hash of its text |
| `tip` | the module its chain's \*\*\*test reqs\*\*\* and conformance testing script are in |

Deleting the folder loses only what the advisor knows: an entry that is not there is a functional spec it has not looked at.

## In the ledger

Four facts go into [the ledger](using.md#the-ledger), the report staying in the advisor's file:

| event | |
| --- | --- |
| `advisor.classified` | the functional spec, `module:func-id`, its verdict and the questions that were a yes |
| `advisor.wrote` | the scenario-ids written, and whether \*\*\*test reqs\*\*\* or a conformance testing script were written with them |
| `advisor.dropped` | the work on a functional spec thrown away, its text changed while it ran |
| `advisor.failed` | why it failed |
