# Capture

Capture takes an existing codebase and captures what it does into \*\*\*plain. From then on you work on the \*\*\*plain: the code is regenerated from it, and the original codebase is abandoned.

```bash
cd ~/my-app
turri capture                     # this folder, into ./plain
turri capture ../other-app --harness-model anthropic/claude-opus-4-5 --coding-model anthropic/claude-sonnet-4-5
```

In the chat, `/capture [path]` does the same in the background. Only you start it: the chat can tell you about it, but cannot run it, since a capture turns conformance tests on in the project it writes (`src/capture/`).

While it runs, the lines above the input show how far it is and what is left (`src/capture/progress.ts`):

```
capture shorty  ✓ survey ━ ✓ outline ━ ⠋ features ─ ○ concepts ─ ○ readability ─ ○ interface ─ ○ trial ─ ○ scripts  phase 3 of 8
  ██████████▓▓▓▓▓▓▓▓▓▓▓▓▓▓  1 of 3 features captured, 2 at work · 2m 10s · $0.84
    feature shorty#shorten-link     40s  ○ read app/api/links.py · thinking
    feature shorty#follow-link      15s  ○ read app/repositories/sqlite.py · waiting for the model
  captured shorty#service-info: 1 functional spec
```

- **The phases** of the selected pipeline: those done ticked, the current one spinning and those to come. Compact captures have five; staged captures have eight.
- **Under them, the phase's own work,** where it is counted, as the regen panel draws functional specs: done in green, at work in the accent colour, waiting `▓`. Then that work in words - while outlining, the features outlined so far and the areas still to outline; then the features captured of those to capture - how long the capture has taken, and what its models have cost.
- **A line for each agent at work:** what it captures, for how long, the last file it read or searched, and what it is doing now.
- **The last line:** what the capture said last.

`turri capture` prints a line as each step ends.

When it ends, turri asks whether to open the captured project. A chat works on the project of the folder it was opened in, and `plain/` is a project of its own. So on yes, the chat closes and `turri` starts it again in `plain/`, as it started the first - turri's theme, its screen, that folder's config - on the chat's model and thinking (`src/reopen.ts`). There, `ctrl+h` shows its \*\*\*plain, `/regenerate` builds it, and the chat tells you its report. On no, the chat tells you the report where you are, and `cd plain && turri` opens it later. A host - a desktop app - opens projects itself, so it is not asked.

## What it aims for

**The interface, whole and exact.** What a user, a client or a script calls is the contract the regenerated software must keep, call for call: every command and subcommand; every option with each name it has, its value, choices and default; every route with its method, path, parameters, fields and status codes; every environment variable and configuration key; every message, output format and exit code a script sees. It is never guessed, never left out as obvious or as the stack's - a stack says how errors are shaped, never which options exist - and never cut for readability. So it is not left to prose at all. It is taken from the code as data - each entry checked against the code it cites - into each part's **interface reference**, a linked resource beside the \*\*\*plain (`resources/interface/<part>.md`) that every functional spec about it carries, through the part's interface concept (`:HttpieInterface:`), to every agent that regenerates or tests the code: the details exact there, the prose free to name them and say what each does. Then capture holds the \*\*\*plain to it: the conventions every feature follows are checked against the code before any feature is written; each writer works from the reference's entries in its feature's files; what no functional spec names goes to a writer of its own; and each module's \*\*\*plain is checked against the reference and the code at the end (steps 3, 4, 8, 9 and 13 below).

**Scenarios that hold on the original.** The scenarios are what the regenerated code's conformance tests check, so one the original itself fails is wrong twice: a coding agent builds to it, or its module's tests fail for good. They are written by agents that read the original and never run it, so before the \*\*\*plain is written each is run against a copy of the original, as its conformance test will run it, and corrected to what the original does (step 14). And each module is a concern of its own, never one that holds everything, put in the order its behaviour is built in, so its scenarios need only the modules before it (step 10).

**Readable \*\*\*plain, not a transcript of the code** - about everything else. An agent that reads code tends to write every detail down, and \*\*\*plain nobody can read is \*\*\*plain nobody reviews. Every capture agent is told (`genome/capture/capture.md`):

- **What someone sees, not what the code does.** A line stays when a user or client would notice the difference and care. Function names, file layout, helpers and internal data shapes are left out.
- **Only where the code departs from the default.** The default is the stack's conventions, the domain's conventions, and the functional specs before this one. An odd rule is written exactly; cookie-cutter behaviour takes a line or none.
- **Exact where exactness is the contract.** Endpoints, fields, status codes, flags and formats are captured exactly.
- **Edge cases go in scenarios.** A functional spec states the rule - `the url is an absolute http or https URL` - and its scenarios pin the edges with concrete values. An example, or what one wrong input answers (`nope` answers 422 `validation_error`), is a scenario's, never said again in the functional spec. How a wrong input is answered is the stack's, unless the original answers otherwise.

**About 80% right.** Capture tries its scenarios on the original, but does not regenerate and compare. You close the gap afterwards: regenerate, run the original's tests (or the conformance tests written from the scenarios) against the result, and capture what is missing as ordinary \*\*\*plain changes.

**Offline.** No capture agent can ask anything. Whatever the code leaves open, each agent decides itself, and says so. The [report](#the-report) collects every such decision.

## How capture scales

For Python libraries the interface reference also records statically declared package exports, import paths used in the original tests, callable signatures and fields of their result types. When Python 3 is available, a helper reads syntax trees without importing the project. Dynamic exports still need the agents' source check. These literal details belong in the linked reference, leaving the functional specs to describe behaviour. A survey that already found distinct concerns too large for a single module can hand that decision directly to the staged writers.

Capture chooses a pipeline automatically, before the first model call. The CLI says which it chose and why; the report records the choice. It uses the map rather than asking an agent to estimate the work.

Size selects **staged** if **any one** of three counts exceeds its limit: **more than 64** source, test and contract files, **more than 4,000** lines across those files, or **more than 24** interface entries outside tests. Otherwise capture starts **compact**. A count exactly at its limit does not exceed it. Bytes, assets, docs and dependency lock files do not enter the decision.

- **Compact:** after the survey and interface reference, **one writer** reads the program and its tests and writes one module directly. There is no separate feature outline, writer per feature, module planner, concept reconciliation or readability pass. The conventions and reference still get checked, a fresh agent verifies the module against the code, and the scenarios are still tried on the original. Testing scripts and the parser check are the same on both paths.
- **Staged:** the code is outlined by area, written by feature and checked by module. `TURRI_CAPTURE_LEAF_LINES` controls splitting within this pipeline. Division runs only across multiple leaves, reconciliation only for conflicting definitions. Reference and trial work is batched and independent writers run up to `--parallel` at a time.

A short program need not be simple. A compact capture checks the same three limits again using the discovered interface. Independently of size, it switches to staged if the survey finds multiple parts, or the writer cannot fit the behaviour and scenarios into one module of up to eight functional specs. A writer can ask to expand rather than omit behaviour; an invalid draft that still fails the normal checks after retries also expands. Capture reuses the survey, conventions and reference. The choice is saved with its checkpoints; captures started before compact mode resume on the staged path.

## How it works

Both pipelines share the map, survey, interface reference and final checks. The numbered steps below describe the staged pipeline in full.

1. **The map** (`src/capture/map.ts`), with no model. Every file the codebase holds, read through git when it is a repo, so what git ignores is left out. Also left out: dependencies, caches, capture's own output folder, and any turri project inside the codebase (a folder with a `config.turri.yaml`, an earlier capture's among them), since its \*\*\*plain is not the code. Each file gets:
   - its kind: source, test, doc, asset, contract, manifest
   - its lines
   - the surfaces patterns find in it: routes, commands, options with every name each has (`-v, --verbose`), screens, the environment variables it reads, tables and models, test names, exports. A file keeps its whole interface - seventy options are seventy - and a sample of the rest.
   - the codebase's own files it imports

   The patterns cover common frameworks:
   - **Python:** Flask, FastAPI, Django, click, typer, argparse
   - **JavaScript and TypeScript:** Express, Fastify, NestJS, React Router, Vue Router, file-routed Next.js and SvelteKit, commander
   - **Go:** net/http, gin, echo, chi, cobra
   - **Java:** Spring, picocli
   - **Rust:** axum, actix, clap
   - **Ruby:** Rails
   - **SQL:** tables in schema and migration files

   A file no pattern fits is still on the map, by its size.
2. **The survey.** One agent is shown the map of the whole codebase, folded to its budget, with the manifests, the README and the standard library's catalogue. It names the parts: software on one stack each, like a backend and a frontend. For each part it gives:
   - the stack - a `stdlib/` template only when the original agrees with it, otherwise written out as implementation reqs
   - its conventions: what every feature does the same way and a user or a script relies on - how an error is written, the exit code or status of each kind of failure, what changes without a terminal. For software that talks to other software, also what reaches the other side on every call, whichever feature makes it: the headers it adds of its own, how bodies and header values are encoded - JSON's separators, non-ASCII escaped or not, the charset - and when a body is sent or read whole, streamed, or not read at all. No feature's writer looks at the wire. Each is settled from the code that does it, never from a declaration or a framework's default, and names the files that decide it. They go into the part's import module as implementation reqs, and every feature's agent is handed them as settled, so no two features decide an exit code differently.
   - how its black-box tests run, from the original's own tests and the harness they run under: what standard input is, the environment, the servers they start - a conformance test run otherwise tests another program. Then what every test sets up so the software acts the same on every run and machine: what it fetches or checks on its own (an update check, telemetry) off or pointed at a local stand-in; a home and a configuration folder of the test's own; the terminal width fixed (`COLUMNS`) where its output wraps; a pseudo-terminal where it prompts on one; local servers, never the internet
   - its core concepts

   It also names what is not the software (vendored, generated, tooling). It may never leave out the original's tests, which are the evidence of what the software does.
3. **The conventions checked.** Before any writer is given them, an agent per part checks each convention against the code it names - the entry point, where errors are caught, written and exited, where a request is built and sent or a response written - and corrects what does not hold, saying why. Every feature follows them, so one that is wrong is wrong everywhere. A check that never holds leaves them as surveyed, and the report says so.
4. **The interface reference.** The interface is taken from the code as data, before any feature is outlined (`src/capture/interface.ts`, `genome/capture/reference.md`). The files where the map found it are given to agents, up to 4000 lines and 12 files each, and each agent lists every command, argument, option, route and environment variable they define - and any the map missed - as entries: the name exactly as the code has it, every other name, the command it belongs to, what it takes, its choices, its default, whether it repeats, is required or is hidden, its help word for word, a route's parameters, fields and statuses, and where it is defined. The harness checks each entry against the code with no model (`referenceProblems`): its `where` is a line of a file of the map, and every literal it gives - each name, alias, choice, default and the start of its help - is in that file or in the files it names as where one is worked out. A literal the code does not have sends the entry back, and so does any surface the map found in the files that is neither listed nor excluded with why. Then a fresh agent checks it against the code, as the conventions are - what checking literals cannot see: a help text cut to its first line, choices left out or worked out when the program runs, an environment variable read through a constant - and corrects or adds each, citing the line that shows it, its answer checked again as the first was; what it changed is in the report, to read first: a checker can be wrong too. The entries become the part's interface reference, `resources/interface/<part>.md`, linked from the part's interface concept, defined in what every module of the part imports: every functional spec that uses it carries the reference, whole, to its coding and conformance agents. A part none of whose entries held has no reference, and its writers work from the map, as do those of files whose agent never held.
5. **The split.** An area of more than 6000 lines (`TURRI_CAPTURE_LEAF_LINES`) goes to an agent that splits it into smaller areas by what they do. Each smaller area that is still too large is split again, so depth grows only slowly with size. The harness puts the areas in the order of their code: an area whose files import another's comes after it. The modules are gathered by concern and put in the order their behaviour is built in once the features are written (step 10).
6. **The outline.** An area that fits is outlined by one agent into features, in build order. Each feature is something a user can do, with the files where it is built. The agent sees the stack's templates too: infrastructure they settle - settings, logging, error bodies, middleware - is no feature, and is left out as settled by the stack, unless a user would notice the original does it differently.
7. **The features divided.** Once every area of a part is outlined, one agent sees all its features, area by area, with what each is about and where it is built, and gives each behaviour to one feature. The outlines are made area by area from each area's own files, so the same behaviour can be outlined twice - an option parsed in one area and acted on in another, a message printed in a third - and written twice it reads twice, in different words, and contradicts itself. Each feature that stays gets a line of what it alone owns; a feature that is a slice of another's behaviour is merged into it, its files the other's, and not written. A part outlined as one area is not divided: one agent saw all of it. A division that never holds leaves each feature owning what it was outlined for.
8. **The features, side by side.** One agent per feature, up to `--parallel` (8 by default) at once. Each is given the full text of the `stdlib/` templates its part is built on - the stack, its kind's `common`, its language's - as the default it never restates, the part's conventions, every feature of the part with what it owns, and the reference's entries in its feature's files, with what the map found there that the reference does not list: it captures what each piece its feature owns does, by its exact name, using the part's interface concept - what one takes, its choices, its default and its help left to the reference, said only where a behaviour turns on them and never otherwise - and never another feature's behaviour, even where its code or tests touch it. Each follows the feature's surfaces through the code, reads the original's tests of it, then writes:
   - at most 8 functional specs
   - the concepts they need beyond the part's
   - its scenarios, mimicking the original's black-box tests - a test that runs the software through its interface, in its own process or the test's - and spent where those are densest: a functional spec the original tests twenty ways gets several, error cases no larger share than the original gives them. Where the original has no test of a spec, it gets scenarios only when it can fail silently, can be read two ways, or is costly when wrong. A feature may have 8 scenarios, and one more for every 50 lines of the original's tests in its files, up to 30; its agent is shown those test files, their lines and their tests' names. Each scenario expects what the original does under the test reqs: output that is not a terminal unless they give one, a local server rather than the internet - never a unit test that mocks a library, recast.
9. **The interface no feature captured.** Once every feature is written, the harness matches the interface - the reference's entries, and what the map found in the parts' files that the reference neither lists nor excludes - against the \*\*\*plain: an option, command or variable as a word of its own, a route by its path under any prefix, its parameters written any way. What no feature names goes to a writer of its own, as a feature added to the area whose files define it, up to 30 surfaces a writer. It captures each exactly - or, for one that is not the software's interface, such as a development script's option, names it in `dropped` with why - and is sent back until every one is settled. A capture leaves no interface out by accident.
10. **The modules, by concern and in build order** (`genome/capture/modules.md`). A module is a concern of its own - what a person looks for in one file: request sending, output formatting, sessions, downloads. One module that holds everything is as hard to read as the code, and every change to it regenerates all of it. The code's areas are gathered into modules by size alone (see [modules](#what-it-writes)), so a small codebase's every concern can land in one. And a module is built on the code of the modules before it, its scenarios run as soon as it is built, with nothing after it there - yet the areas are in the order of their code's imports, which is not the order behaviour is built in: the code that runs everything imports everything - httpie's request sending imports its output formatting and its sessions - so output formatting's scenarios, which send a request and print the answer, could not pass before it. So for each part of more than one feature, an agent is shown every feature, area by area, with what it owns, its functional specs and scenarios, and the modules as the areas make them, and gathers the features into modules by concern - a feature with another only when it is part of that concern, a concern past about 40 functional specs two modules - and puts them in the order they are built, naming for each the modules before it that its functional specs build on and its scenarios run. A scenario that needs a module after its own whatever the order - two modules each needing the other - is rewritten to check the same with only those before it, never merged away. The harness checks that every feature is in one module, that one module never holds a part larger than a module, that none holds more than twice that, and that each module needs only those before it. It runs once, before anything is done module by module; an answer that never holds leaves the modules as the areas make them, in the order of their code, and the report says so.
11. **Concepts reconciled.** A concept two features defined in different words is given one definition by an agent that sees the definitions and the specs that use it.
12. **The readability pass.** For each module, an agent reads its \*\*\*plain - each functional spec with its scenarios - and the stack's templates, never the code. It rewrites the functional specs that read as code, or restate the stack, an earlier spec, or a case one of their scenarios pins. It must keep every fact the stack and the scenarios do not keep - every interface fact, however obvious - and may never make a spec longer. Like the unit review, it improves; it is not a gate.
13. **The interface checked against the code.** For each module, an agent is given its \*\*\*plain - functional specs with their scenarios - the reference's entries in its features' files, and the options the \*\*\*plain names that the reference does not have, found mechanically, and checks every interface fact against the reference and the code that decides it: each option's names, value, choices and default; each route's method, path, fields and status codes; each message, format and exit code. It corrects what is wrong or left out, a functional spec's text or a scenario's, citing the code - over the readability pass, which never sees the code. A correction that never holds is not made.
14. **The scenarios tried on the original** (`src/capture/trial.ts`, `genome/capture/trial.md`). Every agent before this one read the original and never ran it, so a scenario can expect a terminal its test will not give, a site on the internet, output wrapped at a width nobody set, or a message the original never prints. For each module, a copy of the original - the files the map has, so none of its installed dependencies, nor turri's own config files, and the lock files beside its manifests, so it installs what the original pins - is made under `.turri/capture/trial/<module>/`, and agents with a shell on it, 20 scenarios each, one after another, install the original there and run each scenario as its conformance test will: from outside, through its interface, under the part's test reqs and its stack's conformance template. Their shell is a coding agent's - the command check, a home, temporary folder and package caches of its own, the OS sandbox and the audit - fenced to the copy. Each scenario comes back `held`, with what was run and what the original answered; `corrected` to what the original does, keeping what it checks - a local server for a site on the internet, the option that forces colour where the test's output is no terminal; `removed`, when nothing outside can check it; or `untried`, with why, when the original would not run here - kept as written. A functional spec the original contradicts is corrected with its scenario, and what every test must set up for the original to act as the scenarios say - `COLUMNS`, a configuration folder of its own, an update check off - joins the part's test reqs. What only some scenarios need - a file one sends, a server answering one exact body, a pseudo-terminal for one prompt - is never a test req, which every conformance test of every module is written under: those scenarios are corrected to say it themselves, and a test req that names a scenario or a functional spec is sent back. The harness checks that every scenario has one result and that each held or corrected one says what was run. The copy is removed once the module's agents are done. An agent that never holds leaves its scenarios as written, and the report says so.
15. **The files.** The modules, their scenarios, the interface references and the config are written, once.
16. **The testing scripts.** turri's own skills write each part's unit and conformance testing scripts for the \*\*\*plain just written - `implement-unit-testing-script` and `implement-conformance-testing-script` (`src/capture/scripts.ts`), side by side, on the coding model with its configured thinking. They run as the chat runs them in the background: nobody is asked, and a review gate that cannot be satisfied stands. So the captured project can be regenerated at once. A script that is not written does not stop the capture: the report says why, and which skill to ask for.
17. **The check and the report.** The parser checks every module.

The harness checks every answer before keeping it, and sends it back with what is wrong, twice at most (`src/capture/checks.ts`). It checks:
- paths that are not in the codebase
- a convention that names no file deciding it
- ids that are not kebab-case
- concepts used and never defined
- a feature over its budget: functional specs, and scenarios past what the original's tests give it
- a line the parser would read as a heading
- a link, such as `<https://...>`: the parser refuses any link but one to a file of the project, so a URL is written as code
- a split that leaves files nowhere
- a division that leaves a feature with no owner, or merges one into itself, into nothing or into one merged too
- an entry of the interface reference with a literal the code it cites does not have, or a surface of the map neither listed nor excluded
- a writer of the interface no feature captured that leaves a surface neither captured nor dropped with why
- modules that leave a feature out or hold it twice, one module holding a part too large for one, or a module before one it needs
- a correction to a functional spec or scenario that is not there, or with no why
- a trial that leaves a scenario it was given with no result, says a scenario held or is corrected without saying what it ran against the original, or adds a test req that names a scenario or a functional spec - one scenario's setup, which its own text says

An answer that never holds does not stop the capture:
- **A split** falls back to an outline of the whole area.
- **A division** leaves each feature owning what it was outlined for.
- **An outline or a feature** is left uncaptured, and the report says so - a writer of the interface too, its surfaces then counted in the summary.
- **The modules by concern** stay as the code's areas make them, in the order of their code.
- **The conventions check, an interface correction or a trial** leaves what was there.

Only a survey that never holds stops the capture, before anything is written.

## What it writes

When a captured program itself uses Liquid templates, literal tags and expressions in its examples are emitted as literal text. Markdown backticks alone do not prevent Liquid from evaluating them before the module is parsed. This applies to shared requirements, functional specs and their scenarios.

```
my-app/
  ...                          the original - read only, never written
  plain/
    config.turri.yaml          the config in use where the capture was started, conformance-tests: true, base-folder: assets
    config.turri.<m>.yaml      one per part, when there are several - where its testing scripts go
    template/<part>-shared.plain   what a part's modules share: the stack, test reqs, concepts used across modules
    <module>.plain ...         the modules, a concern each, in the order they are built, each requiring the one before it
    tests/<module>/<func-id>.plain   the scenarios of each functional spec that has them
    test_scripts/              the unit and conformance testing scripts, written by turri's skills
    resources/interface/<part>.md   each part's interface reference, linked by its interface concept
    assets/                    the original's images, fonts and media, copied - the base folder
    .gitignore                 keeps the regenerated code's histories out of the repo
    .turri/capture/            state.json - what each agent answered - and report.md
```

- **Modules.** Splitting decides what each agent sees; a module is a concern, what a person reads in one file. The code's areas make the modules an agent starts from: an area whose leaves hold 40 functional specs or fewer (`MODULE_SPECS`) is one module, named after the area, with its leaves' features in build order, and a larger area is its areas' modules, each worked out the same way. That is by size alone, so an agent then gathers the features into modules by concern and puts them in the order they are built (step 10): each module a concern, named for it, never one holding everything. Where its answer never holds, the modules stay as the areas make them.
- **Feature groups.** Each module's functional specs are grouped by feature, one feature's after another's, with no comment line between them.
- **Concepts.** A concept stays in the module that defines it when only that module uses it. A concept used across modules goes to the part's import module, along with every concept its definition uses.
- **The codebase is never written to.** Capture's agents only read it - read, grep, find, ls, and no shell - but for those that try the scenarios, which run the original in a copy of it, removed once they are done.
- **Assets.** The assets are copied rather than linked, so the original can be deleted without breaking anything. `base-folder: assets` puts them in the first module's code before its first pulse, at the paths they had.
- **The config.** Capture inherits `config.turri.yaml` from the project in which the chat or `turri capture` was started. That keeps the person's models, thinking, reviews and limits. With no config to inherit, capture writes the full `turri init-config` template. A named harness model selects its vendor's pair: for example, a global Bedrock Claude harness gets Haiku low for coding. `--coding-model` overrides that choice. A custom provider with no preset keeps its named model. The capture agents use their [own three tiers](#models).
- **Capture-specific settings.** Capture turns on `conformance-tests` and wires up the captured project's own unit and conformance runners. The original project's script paths, `module`, `base-folder` and `test-dir` do not carry over. In the chat, the current chat model and thinking and any coding model given at startup take precedence; on the command line, `--harness-model` and `--coding-model` do. A config that does not parse stops capture before anything is written ([details](config.md#a-config-that-does-not-parse)).

## The report

`plain/.turri/capture/report.md` replaces the questions a capture never asks. It lists:

- what was written
- the conventions every feature follows, with the files that decide each: wrong there, wrong everywhere - and what the check against the code changed
- what the check of each module's interface against the code corrected, and why
- the scenarios tried on the original: each one corrected to what the original does, removed or not tried, with why; the functional specs corrected with them; what was added to the test reqs. The summary says how many held as written.
- each part's modules by concern, in the order they are built, what each needs of those before it, and the scenarios rewritten to need only those before their own
- the features merged into others, and why
- the testing scripts: where each is, or why it was not written and which skill to ask for
- the parser's check
- what could not be captured
- features the original's tests cover that were captured with no scenario
- each part's interface reference: where it is, what it holds, what was left out of it and why, and what could not be taken
- the interface its \*\*\*plain still names nowhere - options, commands, routes, screens, environment variables - each with why its writer dropped it, or with none when no writer settled it. Those with no why are counted in the summary: a user could call them in the original and will not find them in what is regenerated.
- what was left out and why
- every assumption
- what the agents were unsure of
- what they dropped as incidental
- what to do next

Its first lines are the summary the command line and the chat show. In the chat, the report comes back once the capture ends, and the chat's agent passes it on.

## Stopped, finished, run again

- **Stopped part-way.** Every answer is saved in `state.json` as it comes. Running the capture again goes on from where it was and asks no agent twice. This covers a quit, a crash, or a provider down for good.
- **Finished.** A finished capture is never run over. To capture again, move `plain/` out of the way.
- **A folder that is not a capture.** Capture refuses a `plain/` that holds anything but its own state, and `--into <folder>` names another folder.

## Models

| Role | Work | Default |
| --- | --- | --- |
| `capture-exploration` | Gather facts from source for the public interface reference. | **Haiku, low** |
| `capture-analysis` | Check conventions, reference entries and the module's interface against the code, split and outline areas, divide features, and try draft scenarios against the original. | **Sonnet, low** |
| `capture` | Reason about the stack and requirements, write the specs, organise modules, reconcile concepts, revise the text and write custom testing scripts. | **Opus, medium** |

`init-config` writes all three entries as active configuration. For example, with Anthropic:

```yaml
models:
  capture-exploration: anthropic/claude-haiku-5-5:low
  capture-analysis: anthropic/claude-sonnet-5-5:low
  capture: anthropic/claude-opus-5-5:medium
```

The three entries are independent, each overriding its tier's default. Headless capture resolves the same defaults without needing `init-config`; a Bedrock Claude harness uses its inference geography. A non-Claude harness keeps its configured provider models: coding for exploration and analysis, harness for writing. Capture prints the resolved models at startup, and each agent's elapsed time and cost at completion. Capture turns have ten minutes unless a role, `models.default` or `turn-limit` sets a limit; scenario trials get at least thirty minutes unless the limit is off.

`--harness-model` and `--coding-model` are also written into the new project's config, for the chat and the regeneration that follow.

## After a capture

1. **Read the \*\*\*plain and the report,** in turri opened in `plain/`. From now on the \*\*\*plain is the source of truth.
2. **Regenerate,** first module first: `/regenerate`. Its testing scripts are written already. Any the report says were not, ask turri for first (`implement-unit-testing-script`, `implement-conformance-testing-script`).
3. **Compare with the original** by hand: its own tests, the scenarios' conformance tests, a look at what is launched. Each difference becomes a \*\*\*plain change.
4. **Abandon the original** once you are satisfied.
