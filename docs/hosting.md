# Running turri in a host

`turri` runs its chats in a terminal. A host - a desktop app, an editor - can run the same session itself, its chats in its own windows, and show what turri's terminal would draw in its own way: the jobs, the questions, the \*\*\*plain description. It imports turri from npm as `@turri-dev/cli/host`.

## What the host entry gives

`@turri-dev/cli/host` is turri's compiled code (`dist/host.js`, with its types) - the conversation and what a host shows beside it:

| export | what it is |
| --- | --- |
| `createTurri(options)` | a turri session: its [chats](chats.md), each a [pi](https://pi.dev) session with every tool, slash command, rule and skill the terminal has, on one job registry and work loop. The host opens, closes and shows them, is told of their jobs and asks their questions - see [the session in a host](#the-session-in-a-host). |
| `MAX_CHATS`, `ChatInfo`, `ChatStatus` | the most chats a session has open - nine - and what the host is told of each. |
| `pi` | [pi](https://pi.dev) itself, as turri is built against it. Make the host's own extensions and UI with this one, not another copy. |
| `readProjectConfig`, `projectModels`, `modelSpec`, `configForSpec`, `hasProjectConfig`, `stacksOf` | the project's settings, as [config.turri.yaml](config.md) has them. |
| `configSettings`, `currentValue`, `readConfigText`, `overriddenBy`, `EFFECT_TEXT` | every setting of config.turri.yaml as [/turri-config](config.md#changing-it-from-the-chat) knows it - its key, what it does, its kind (a yes or no, one of a few words, a number, a model, a list, a path, a budget), its words or the values offered first, what it is unset and when a change takes effect - and what the file has now (`currentValue(readConfigText(dir), key)`), and what wins over it. Change one as the person would, by sending `/turri-config <key> <value>` to the chat: turri checks it and writes it with the file's comments kept. |
| `debugMode` | whether turri keeps, in a project, what it writes only for debugging it - `debug:`, or `TURRI_DEBUG` over it (see [debug mode](config.md#debug-mode)). |
| `initConfig(dir, { vendor, bedrock, models, force, catalogue })`, `VENDORS`, `BEDROCK_REGIONS`, `BEDROCK_DEFAULT` | a project's first config.turri.yaml, as `turri init-config` writes it - async, it may read [pi](https://pi.dev)'s catalogue - see [a project's first config](#a-projects-first-config). |
| `piModelCatalogue`, `bedrockMakers`, `bedrockModelsIn`, `bedrockDefaultModels`, `bedrockModels`, `bedrockPlaceOf`, `makerLabel`, `BEDROCK_GEOGRAPHIES`, `BEDROCK_IN_REGION` | [pi](https://pi.dev)'s model catalogue, read without a request, and Bedrock in it: whose models it serves, in which geographies, which two turri offers for a maker and geography. |
| `bedrockAwsRegion`, `bedrockNeedsAwsRegion` | the AWS region to set `AWS_REGION` to for a Bedrock geography, and whether it has to be set. |
| `checkPlainFile`, `plainFileParser`, `resolveTemplateDirs`, `iterateFunctionalSpecs`, `FUNCTIONAL_REQUIREMENTS` | \*\*\*plain checked and parsed, its functional specs one by one - as `turri validate` reads it. |
| `highlightLines`, `roleOf` | \*\*\*plain's lines coloured by turri's own [\*\*\*plain](https://plainlang.org/docs/) grammar. |
| `plainGraph(projectDir)` | a project's \*\*\*plain as a graph to move around in: its modules with what each imports and requires and what imports and requires it, each item of their sections with its line, and the concepts - an item linked to those it names and to where each is defined - see [\*\*\*plain for a host](#plain-for-a-host). |
| `conceptsOf(plainFile)`, `findConcepts(text)`, `conceptBeingTyped(text)` | the concepts a module can name, with what each is and the module that defines it; the concepts written in a piece of text; the one being typed at its end. |
| `stdlibTemplates()`, `isStack`, `STDLIB_KINDS` | turri's standard library: every template with its kind, file, text, imports and its conformance template or the stack it tests, and the kinds in order with their titles. |
| `functionalityCompletion`, `createWorkLoop`, `createJobRegistry`, `promptOf`, `describeModules` | how far each functional spec is built, and - on a loop of the host's own with `dryRun` - the work a \*\*\*plain change would plan, as `turri glimpse` does. |
| `onModelEvent`, `describeTurnIncident` | a provider failing and waited out, a turn turri ended itself. |
| `onLedgerEvent`, `readLedger`, `ledgerDir`, `runViews`, `pulseView`, `describePulseView`, `describeRuns`, `ledgerProjects`, `earlierPulses`, `asJob` | what turri did, as facts - the [ledger](using.md#the-ledger): each event heard as it is recorded, and every run and pulse read back, earlier sessions' too - see [the ledger in a host](#the-ledger-in-a-host). |
| `doctor({ dir, models, env })`, `Check`, `Level` | whether the machine - and, with `dir`, that project - is ready for turri, as `turri doctor` checks it: a list of checks to show in the host's own way - see [doctor in a host](#doctor-in-a-host). |
| `sweepOrphanedGroups` | stop what a turri killed outright left running, before anything starts. |

It is turri's own code, as the terminal runs it: a 0.x release may change any of it.

## A project's first config

```js
import { initConfig, piModelCatalogue, bedrockMakers, bedrockModelsIn, bedrockDefaultModels } from "@turri-dev/cli/host";

const catalogue = await piModelCatalogue();
bedrockMakers(catalogue);                                     // [{ maker: "xai", label: "xAI", regions: ["global", "us", "in-region"] }, ...]
bedrockModelsIn(catalogue, { maker: "xai", region: "global" }); // the maker's chat models there, with their prices
const offered = bedrockDefaultModels(catalogue, { maker: "xai", region: "global" });
const { written, message } = await initConfig(project, { models: { harness, coding }, catalogue });
```

`initConfig` writes config.turri.yaml as `turri init-config` does, and returns what it did - `written`, and `message`, the lines the terminal prints. It is async.

- `vendor` - `anthropic`, `openai`, `google`, `amazon-bedrock` or `other` - fills in that vendor's own two models (`VENDORS` has each one's label and models).
- `bedrock: { maker?, region }`, on Amazon Bedrock, says whose and where. turri's own pair is written where it has one - Anthropic's and OpenAI's in `BEDROCK_REGIONS` - and otherwise the pair `bedrockDefaultModels` offers from [pi](https://pi.dev)'s catalogue: any maker and geography it has.
- `models: { harness, coding, strong? }` writes those two instead - any pair [pi](https://pi.dev)'s catalogue has as chat models, full model ids without a thinking level (`amazon-bedrock/global.xai.grok-4.7`). They go wherever the vendor's own would: the two models with the thinking turri writes, the commented-out `judge-model` and `models:` examples, `strong` - the judging examples' model - being `harness` unless given. The vendor, the Bedrock maker and the geography are read from them, so neither `vendor` nor `bedrock` is needed. A model the catalogue does not have, or that is not a chat model, writes nothing: `written` is false and `message` says which, with the closest the catalogue has.
- `catalogue`, the one the host already read, saves reading it again.

The message says whose models were written - "with xAI's models on Amazon Bedrock (global)" - and how to sign in, with the `AWS_REGION` for the geography: `bedrockAwsRegion(geography)` is that region, and `bedrockNeedsAwsRegion(geography)` whether it has to be set - every geography but `global`, `us` and `in-region`, [pi](https://pi.dev) calling Bedrock in `us-east-1` unless `AWS_REGION` or the profile names another.

## doctor in a host

```js
import { doctor } from "@turri-dev/cli/host";

const checks = await doctor({ dir: project, env: engineEnv });
// [{ level: "ok" | "missing" | "limited" | "info", name, detail, more?, fix? }, ...]
```

`doctor` runs the checks `turri doctor` prints, and returns them: Node, bash, git, which OS sandbox is up under the agents' commands, and whether any model provider has credentials. With `dir`, the project too: whether this machine has the toolchains its modules' implementation reqs name, and what in its testing scripts it does not have. It prints nothing and asks nothing; each check's `fix` is plain text, to show as it is. A check `missing` means turri cannot run until it is fixed, `limited` that it runs with less.

- `dir` is the project to check - not the process's working folder, which in a host is not the project. Without it, only the machine is checked.
- `models: true` asks each model the project's config.turri.yaml names for a word, with this machine's credentials - a request a model, which costs money. It is off by default: run it when the person asks.
- `env` is the environment whose PATH is looked in - for bash, git, the sandbox, the toolchains and what the testing scripts run - by default the process's own. A Mac app opened from Finder runs with `/usr/bin:/bin:/usr/sbin:/sbin`, not the person's shell's PATH: pass the environment the host's engine runs turri with, so doctor checks the PATH turri will actually have.

What matters only in a terminal - `turri` on the PATH, a plain `pi` an older turri made load turri - is left to `turri doctor`.

## The session in a host

```js
import { createTurri, pi } from "@turri-dev/cli/host";

process.chdir(project);                // the session is the project's in the process's working folder
const turri = await createTurri({
  onJobChange: (job) => {},            // a job started, moved on, did something, or ended - any chat's
  onPlanChange: () => {},              // what is planned changed with no job
  dialogs: (chat) => ({ select, input }), // a chat's questions, put in the host's own dialogs - each with a signal to close it
  uiContext: (chat) => uiContext,      // a chat's other UI calls - notices, the working line
  surface: SURFACE,                    // the host's UI, in its own words, told to the model in place of the terminal's
  systemPrompt: (prompt) => prompt,    // the last word on the whole system prompt, each turn
  extensions: [browser, terminal],     // the host's own extensions, built into every chat after turri's
  restore: true,                       // reopen the last session's chats here, as `turri --continue` does
  onNotice: (notice) => {},            // the sentinel puts something to the person: draw it in notice.chat
  onNoticeOver: (notice) => {},        // ...answered, dismissed, ignored or superseded: take its card down
  onConcluded: (conclusion) => {},     // the sentinel is done with a pulse: holds or wrong, told to conclusion.chat
  onChatSession: (chat, session) => {}, // a chat's session replaced, same id: the sentinel's, fresh for each pulse - follow this one
  sentinel: {
    tools: [browserTool],               // the sentinel's own tools, beside turri's: what it tests a release with
    surface: "...",                     // where the person watches it use them, in the host's words
  },
});

const chat = await turri.openChat();   // { id, title, status, shown, session }: a fresh chat, shown
chat.session.subscribe((event) => {}); // pi's session: its events, prompt(), abort()
await chat.session.prompt("add a cart to the shop");
turri.focus(other.id);                 // the chat the person looks at now
await turri.interrupt(chat.id);        // ctrl+c: "stopped" what it was doing, else "ended" the session - "ignored", "missing"
await turri.decline(chat.id);          // ctrl+c at a question: "declined", the turn going on - "none", "missing"
turri.chats();                         // [{ id, title, status: "idle" | "working" | "question" | "unread", shown, role? }]
turri.notices();                       // the notices open now
await turri.answer(notice.id, { action: 0 }); // or { steer: "…" }, { dismiss: true }, { ignore: true }: "done", "dismissed", "ignored", "refused", "over", "missing"
turri.onChats((chats) => {});          // a chat opened, closed, renamed, working or done
await turri.closeChat(chat.id);        // its turn stopped, its conversation deleted - its pulses run on
turri.jobs;                            // the session's job registry: every pulse any chat started
turri.loop;                            // its work loop, once a chat is open
await turri.dispose();                 // every chat let go, what activate started stopped
```

- **The chats.** Up to nine, each its own history, model, thinking level and stack, all on the session's one job registry and work loop - see [chats](chats.md). `openChat({ sessionFile })` reopens a saved one. A pulse's end goes to the sentinel (below), and is shown in the chat `focus` last named - its agent told of a pulse that landed only to say so and what the sentinel is doing with it, and not told of one that went wrong. What the `surface` says to do once something is released is then not done: the sentinel tests the release. With `sentinel: false`, it is told to the chat that asked for it, its agent reacting there - to the chat `focus` last named when that one is closed. A chat is never hidden from turri's side: what the host does not show, it still runs, and its questions go to the host's dialogs at once - the host decides where they wait. `status` says a turn is running (`working`) or that it said something since it was last focused (`unread`).
- **Interrupting.** `interrupt(id)` is the terminal's ctrl+c for a host's key or button: it stops what that chat is doing - its turn, a skill or a tool in it, a `!` command, a compaction - and nothing in the other chats (`stopped`). A skill stopped keeps its run, to be continued. A question of the chat's open in the host's dialogs when its turn is stopped is over - declined - and its dialog's `signal` aborted, for the host to close it. A chat doing nothing ends the session, every chat with it, as `dispose` does (`ended`): turri never exits the host's process, so the host closes what showed it. An interrupt straight after one that stopped something is `ignored`, so pressing twice to be sure ends nothing. `session.abort()` is the chat's turn alone, and never ends the session.
- **Declining a question.** `decline(id)` is ctrl+c at a question in turri's terminal: the question the chat asks now - its ask_user, a skill's interview, a review gate's escalation, whatever goes through the host's dialogs - declined. The asker is told "The user declined to answer the question." and the turn goes on; a review gate declined stands. It declines each question it is called at, however many in a row, and never stops the turn - that is `interrupt`. `none` when the chat asks nothing now, `missing` for a chat not open. A dialog that resolves with `undefined` is something else - dismissed, and in a question of several answers "done" with the boxes ticked so far.
- **The record.** The chats are recorded in `.turri/chats.json` as the terminal records them, and `restore: true` reopens the last ended session's - without it, a host starts with none and deletes nothing. A chat closed is deleted; a session's chats are kept until five newer sessions have recorded theirs.
- **The jobs.** The host is told of each job as it changes, and has the registry and the loop themselves, so it shows the very jobs the chats run. Its buttons are best a chat's commands - `session.prompt("/regenerate app.plain")` - so the plan is the chats'. A job's \*\*\*plain diff is `job.diff`, and `job.diffWhere` places its lines in the `.plain` files: by a line's place in the diff, its `file`, its `line` there, the `section` it is in and `written` - the line as the file has it. The diff is \*\*\*plain as read, a link `[text](path)` in it as `` `[resource]text` ``, so a host that finds the lines again in a file's text - after an edit since the pulse started - matches them by `written`, never by the diff's text. A `job.diff` in a ledger written before `written` was added has none. `job.cases` is the functional specs the pulse covers, as planned, by what it does to each - `{ add, patch, again, delete }`, each a list of `{ module, funcId }`, `module` the pulse's own or one below it: new, changed, regenerated again with its text unchanged, taken out. A host lights those specs from it, and marks a line of the diff as regenerated again from `again` - never from the diff, where such a line is unchanged. A pulse of none is mechanical - reqs, or definitions none uses; a job that is not a pulse has no `cases`. The ledger's `job.queued` carries them too.
- **The questions.** `dialogs(chat)` gives a chat's two dialogs: `select(title, options, context, at, { signal })` and `input(title, context, { signal })`, each resolving with the answer, or undefined when the person dismissed it. `signal` is aborted when the question is over without the dialog's answer - declined by `decline`, or its turn stopped (`interrupt`, `session.abort()`): the host closes the dialog it opened for it, whatever it resolves with then being ignored. A host may leave it unread. The chat's questions, a skill's interview and a review gate's escalation are put in them; without them, in the `uiContext`'s own dialogs.
- **The surface.** What turri tells the model of where the person watches the work is the terminal's by default: regen, the side panel on `ctrl+h`, `/pulses`. In a host none of that is there, and the model would send the person to keys and panels that do not exist. `surface` is the host's own description of its UI - the views it has in place of the terminal's, what its marks and buttons mean, where questions appear - in its own words. Given, turri leaves every terminal instruction out of what the model is told and puts the surface in turri's identity, as a `<surface>` block, where the identity speaks of regen. It reaches the side questions and the tools' own words too: a pulse not found says the `pulses` tool lists them, not `/pulses`. Text only the person sees in the terminal - the job panel, the side panel - is the terminal's and stays as it is. Without `surface`, the prompt is the terminal's, byte for byte. What the conversation is to do once something is released belongs there too - open it in the host's preview, say what to test: with `sentinel: false`, after a pulse released under `release-after-pulse`, the conversation does what it was told to do once something is released. With the sentinel on, the sentinel tests the release, and the conversation only says it landed.
- **The system prompt.** `systemPrompt(prompt)` gets the whole system prompt for the turn - [pi](https://pi.dev)'s, turri's identity and blocks, the rules - after turri's own `before_agent_start` work, and returns what is sent. It is for what `surface` does not cover; to describe the UI, use `surface`, rather than words appended after turri's that contradict them.
- **The mode.** Each chat is bound in [pi](https://pi.dev)'s `tui` mode: the work runs in the background and keeps the chat free, as the terminal does. Its other UI calls - its notices, its working line, a confirm - come to `uiContext(chat)`, as [pi](https://pi.dev)'s [SDK](https://github.com/earendil-works/pi) describes it.

### The sentinel

The [sentinel](sentinel.md) is one of the host's chats: turri opens it with the first pulse that finishes, through the host's own `create` like any chat - `onChats` hears of it, `role: "sentinel"` - and never moves `focus` to it. It closes like any chat, and the next pulse that finishes opens it again; with it on, `openChat` opens up to eight.

- **A conversation a pulse.** The sentinel checks each pulse from scratch, in a conversation of its own - one pulse at a time, the others waiting their turn. The chat keeps its id; its session is replaced. As it starts on a pulse, the session it had is stopped and let go (`abort`, `dispose`), a new one is made in its place, and `onChatSession(chat, session)` comes with it - before the pulse is put to it - then `onChats`; `session(id)` returns the new one from then on. A host that follows the sentinel's chat subscribes to that session in place of the old - an `onChats` listener that follows only the ids it has not seen would hear nothing more of it. The first pulse goes to the session the chat was opened with: there is no `onChatSession` for it. Each conversation's first message is the hidden brief of its pulse - `customType: "turri_sentinel_pulse"`, `details.jobId` - so a host that splits the sentinel's work by pulse on it still can; the conversations before are not in the new session, and what the host showed of them is its own to keep.

- **Notices.** What it finds wrong comes as `onNotice(notice)`: `{ id, chat, severity: "error" | "warning" | "info", summary, evidence: string[], actions: [{ label, task }], module?, pulse?, job?, ignorable?, state: "open" }`. Draw it in the chat `chat` names - the one `focus` last named, or, while that is the sentinel, the chat that asked for the pulse. It is drawn there as a card in the transcript too. A host given `onNotice` answers it itself - the terminal's dialog is not opened - with `answer(id, …)`: `{ action: index | label }` starts that chat's agent on the action's task, `{ steer: text }` on the person's words, `{ dismiss: true }` on nothing, this once. A notice with `ignorable: true` - a gap in the \*\*\*plain the build settled with an assumption, which the person may leave as it is - takes `{ ignore: true }` too: offer it as its own button beside the actions. Nothing is done in the chat, the notice ends `state: "ignored"` (`"ignored"`), and turri writes it to the sentinel's guidance, so it is not raised again in this session or the next; on a notice without `ignorable`, `{ ignore: true }` is `"refused"` and the notice stays open. `onNoticeOver(notice)` comes as it is answered - and when a newer notice about its module supersedes it (`state: "superseded"`) - for the host to take the card down. `notices()` lists the open ones.
- **Starting it.** Under `sentinel: ask` - as it is unset - the person is asked before it first opens in the session: a notice with `kind: "sentinel-start"`, `severity: "info"`, in the chat `chat` names, its `summary` the question in one sentence, no `evidence`, and its actions the answers - `Start the sentinel`, `Start it, and don't ask again`, `Not this session`, `Turn it off for this project`. Draw it as a question rather than as something wrong. `answer(id, { action })` answers it, by index or label - `"done"` - and `{ dismiss: true }` is not this session; turri writes `sentinel:` itself for the two that choose for the project. Until it is answered, the pulses that finish are held: neither the sentinel nor the chat hears of them. A host that offers the setting too writes it as `/turri-config` does - `ask`, `true` or `false` (see `configSettings`).
- **Conclusions.** As the sentinel is done with each pulse - all well or not - `onConcluded({ job, verdict: "holds" | "wrong", summary, module, pulse, chat })` comes, and the chat `chat` names - the one `focus` last named, as for a notice - shows it and its agent says so in a line.
- **Its model.** The `sentinel` role in `models:`, else the chat's model - `models.chat`, else `harness-model` - with its thinking, set as its chat opens: not pi's default model, which may not be one the project's provider has. What the person then picks in its chat stands. See [its model](sentinel.md#its-model).
- **Its tools.** `sentinel: { tools }` are [pi](https://pi.dev) tool definitions registered in the sentinel's chat alone and told to it in its prompt - the host's browser, say, for it to test a release with. The rest of the host's `extensions` are built into its chat too, but their tools are refused it: only its own read, and these.
- **Its surface.** `sentinel: { surface }` is where the person watches the sentinel use those tools, in the host's own words - the preview pane its browser and terminal show in, say. Given, the sentinel's prompt has it, as a `<surface>` block, in place of the person not watching it: it tries a release with the host's tools, where the person can watch, and keeps its own shell for what those cannot show - logs, exit codes, files. Without it, the person does not watch the sentinel, and the host's tools are only to test with as well. As for the conversation, `systemPrompt` has the last word on its prompt.
- **Its surface.** What it is told is its own prompt, not the conversation's: the host's `surface` is not in it; `systemPrompt` still has the last word.

A surface for a desktop app might read:

```js
const SURFACE = `The person uses turri's desktop app, not a terminal: there are no keys to press. Slash commands are typed in
the chat, and the toolbar's buttons send them too.
- The Specs view shows each .plain file, every functional spec marked: a green dot is built, a pulsing ring regenerating,
  a hollow ring planned, grey waiting.
- The Pulses view lists every pulse - running, planned and finished. A row opens what its agents did and its log; its
  Halt button stops it.
- Your questions appear as cards above the message box: the person picks an option or types an answer there.
- The Run button releases what is built and opens it.`;
```

## \*\*\*plain for a host

```js
import { conceptBeingTyped, conceptsOf, findConcepts, plainGraph, stdlibTemplates, STDLIB_KINDS } from "@turri-dev/cli/host";

const { modules, items, concepts } = plainGraph(projectDir);
const app = modules.find((module) => module.module === "app");
app.requires;      // [{ name: "base", file: "/…/base.plain" }] - and imports, importedBy, requiredBy, the same way
app.items;         // ["/…/app.plain:11", "/…/app.plain:15"] - its own items, in order
items.find((item) => item.id === app.items[1]);
// { id, file, module: "app", section: "functional specs", line: 15, funcId: "fill-cart", text: ":User: can fill :Cart:.",
//   defines: [], uses: [{ concept: ":User:", definition: "/…/base.plain:8" }, { concept: ":Cart:", definition: "/…/app.plain:11" }],
//   resources: [{ text: "the schema", target: "schema.json", file: "/…/schema.json", line: 15 }] }
concepts.find((concept) => concept.definition === "/…/base.plain:8");
// { concept: ":User:", definition: "/…/base.plain:8", module: "base", text: "is a person who signs up.", usedBy: [...] }
```

- **The graph.** `plainGraph` reads every .plain file in the project's folder and its `template/` folder, and every module they import or require, wherever the parser finds it - the standard library's templates too. A **module** is a file: its imports, resolved as the parser reads an import (a `stdlib/` module from turri's own folder), its required modules, resolved as the requires chain finds them - `file: null` when one is not found - and the reverse of both, `importedBy` and `requiredBy`, so a host goes up and down the requires chain without inverting anything. An **item** is one item of a section - a definition, an implementation req, a test req, a functional spec with its acceptance tests - with its file, the line it starts on, its text, a functional spec's `funcId`, the concepts a definition defines, and each concept it names with the item that defines it: its own module's definitions, its imports', and those its required modules export, as the parser sees them from that module. `definition` is null for \*\*\*plain's own concepts, and for one defined nowhere the module can see. Its `resources` are the linked resources it names - `[text](target)`, a functional spec's acceptance tests' too, as the parser reads them - each with `file`, the file regenerating reads it from (the template folders first, then the current folder), null when it is not there, and `line`, the line the link is on. `resources` is on every item, `[]` when it names none: a turri that gives no resources has no field. A **concept** is one definition of it - or \*\*\*plain's own, `definition: null` - with every item that names it there. An item's id is `<file>:<line>`: the file to open and the line to go to.
- **What does not parse.** Nothing throws. A file that does not parse has `error`, the parser's message; its links are what its front matter says, and its items what of its own text reads without its imports. A file whose items Liquid moves keeps the lines of its own text.
- **Concepts.** `conceptsOf(plainFile)` is what one module can name - `{ concept, definition, module }`, `definition` the text after its concepts, `module` null for \*\*\*plain's own - for suggestions as the person types. `findConcepts(text)` is every concept written in a piece of text, `{ concept, start, end }`, and `conceptBeingTyped(text)` the one at its end still open - `{ typed: ":Us", start }`, or undefined - both with the parser's own pattern.
- **The standard library.** `stdlibTemplates()` is every template in turri's `stdlib/`, sorted: `name` - what a module imports it as - `file`, `kind` (`backend`, `frontend`, `cli`, `library` or `lang`), `description`, `text`, `imports` as the parser reads its front matter, a stack's `conformance` template when it has one, and a conformance template's stack as `tests`. `isStack(template)` says whether it is a stack to import; `STDLIB_KINDS` is the kinds in order, each with its title.

## The ledger in a host

`createTurri` starts the ledger itself, in the process's working folder - the project's - so a host needs nothing to have one: its pulses are recorded as `host` runs, each event with the chat its work was asked for in, and the chats' `pulses` and `diagnose` already tell the model of earlier sessions' pulses. What the host can do with it is show it.

```js
import { onLedgerEvent, pulseView, readLedger, runViews } from "@turri-dev/cli/host";

// Each event as it is recorded - written or not, so a project with ledger-keep: 0 is heard too.
const stop = onLedgerEvent((entry, project) => {
  if (entry.kind === "healer.failed") notify(`the ${entry.healer} failed: ${entry.error}`);
  if (entry.kind === "provider.error" && !entry.transient) notify(`the model provider: ${entry.error}`);
});

// The project's runs, the most recent first, each with its pulses, the most recent first - how each ended, how long, what it cost.
const runs = runViews(projectDir);

// One pulse, from this session or an earlier one: its rounds, test runs, verdicts, healers, refusals, history.
const view = pulseView("646d", readLedger(projectDir, { job: "646d" }));

// Earlier sessions' pulses as jobs, to list beside this session's - none this session's registry knows.
const { jobs, more } = earlierPulses(ledgerProjects(projectDir), new Set(turri.jobs.list().map((job) => job.id)));
```

- **Live.** `onLedgerEvent(listener)` is told every event as turri records it, with the project it is about, until what it returns is called; a listener that throws misses that event and nothing else. It is the pulse's own detail - its stages, test runs, verdicts, refusals - where `onJobChange` is the job as a whole.
- **Read back.** `readLedger(project, { job, run, kinds, since })` is the project's events, oldest first, the gzipped runs too; `runViews` and `pulseView` gather them into runs and pulses, and `describePulseView` and `describeRuns` say them in lines, as `turri ledger` prints them. `ledgerProjects(dir)` finds the ledgers of a folder and the projects under it. `earlierPulses(projects, known, runs = 3)` gives the last runs before this one as `Job`s - the shape a host already draws for this session's - each marked `earlier: { run, runMode, lines }`, `lines` what the ledger says of it, and with its `cases`, `diff` and `diffWhere` - the \*\*\*plain diff it regenerated, as last steered, and where its lines are written - as a pulse of this session has them (a pulse recorded before `job.diff` was has none); `more` is how many runs are beyond them. They are read only: never started, halted or waited for. turri's own side panel lists them so, as **earlier sessions**.
- **What it is for.** Looking up, never deciding: what is built and what is left come from the records and the work loop, as before. Its events and their fields are `LedgerEvent`'s - a kind is added, never changed, and every event carries `v: 1`.

## Running it

The host entry is compiled JavaScript, so any Node from 22.19 runs it - Electron's own included; nothing strips types. It finds turri's own folders - `genome/`, `stdlib/`, `.pi/` - beside `dist/` in the package, wherever npm installed it.
