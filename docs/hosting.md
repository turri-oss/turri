# Running turri in a host

`turri` runs its conversation in a terminal. A host - a desktop app, an editor - can run the same conversation itself, in its own window, and show what turri's terminal would draw in its own way: the jobs, the questions, the \*\*\*plain description. It imports turri from npm as `@turri-dev/cli/host`.

## What the host entry gives

`@turri-dev/cli/host` is turri's compiled code (`dist/host.js`, with its types) - the conversation and what a host shows beside it:

| export | what it is |
| --- | --- |
| `createTurriExtension(host)` | turri's conversation as an extension of [pi](https://pi.dev)'s: every tool, slash command, rule and skill the terminal has. The host is told of its jobs and asks its questions - see below. |
| `pi` | [pi](https://pi.dev) itself, as turri's extension is built against it. Make the session with this one - `pi.createAgentSession`, `pi.DefaultResourceLoader` - not another copy. |
| `readProjectConfig`, `projectModels`, `modelSpec`, `configForSpec`, `hasProjectConfig`, `stacksOf` | the project's settings, as [config.turri.yaml](config.md) has them. |
| `debugMode` | whether turri keeps, in a project, what it writes only for debugging it - `debug:`, or `TURRI_DEBUG` over it (see [debug mode](config.md#debug-mode)). |
| `initConfig(dir, { vendor, bedrock, models, force, catalogue })`, `VENDORS`, `BEDROCK_REGIONS`, `BEDROCK_DEFAULT` | a project's first config.turri.yaml, as `turri init-config` writes it - async, it may read [pi](https://pi.dev)'s catalogue - see [a project's first config](#a-projects-first-config). |
| `piModelCatalogue`, `bedrockMakers`, `bedrockModelsIn`, `bedrockDefaultModels`, `bedrockModels`, `bedrockPlaceOf`, `makerLabel`, `BEDROCK_GEOGRAPHIES`, `BEDROCK_IN_REGION` | [pi](https://pi.dev)'s model catalogue, read without a request, and Bedrock in it: whose models it serves, in which geographies, which two turri offers for a maker and geography. |
| `bedrockAwsRegion`, `bedrockNeedsAwsRegion` | the AWS region to set `AWS_REGION` to for a Bedrock geography, and whether it has to be set. |
| `checkPlainFile`, `plainFileParser`, `resolveTemplateDirs`, `iterateFunctionalSpecs`, `FUNCTIONAL_REQUIREMENTS` | \*\*\*plain checked and parsed, its functional specs one by one - as `turri validate` reads it. |
| `highlightLines`, `roleOf` | \*\*\*plain's lines coloured by turri's own [\*\*\*plain](https://plainlang.org/docs/) grammar. |
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

## The conversation in a host

```js
import { createTurriExtension, pi } from "@turri-dev/cli/host";

const loader = new pi.DefaultResourceLoader({
  cwd,
  agentDir: pi.getAgentDir(),
  extensionFactories: [
    createTurriExtension({
      onJobs: (jobs) => {},        // the conversation's job registry: every pulse it starts
      onWorkLoop: (loop) => {},    // its work loop, once work is first asked for
      onJobChange: (job) => {},    // a job started, moved on, did something, or ended
      onPlanChange: () => {},      // what is planned changed with no job
      dialogs: { select, input },  // ask_user's questions, put in the host's own dialogs
      surface: SURFACE,            // the host's UI, in its own words, told to the model in place of the terminal's
      systemPrompt: (prompt) => prompt, // the last word on the whole system prompt, each turn
    }),
  ],
});
await loader.reload();
const { session } = await pi.createAgentSession({ cwd, resourceLoader: loader });
await session.bindExtensions({ uiContext, mode: "tui" });
```

- **The jobs.** The pulses the conversation starts - its tools, `/regenerate`, a \*\*\*plain change - run in its own job registry and work loop, the project's one. The host is handed both as they are made, and told of each job as it changes, so it shows the very jobs the conversation runs. Its buttons are best the conversation's commands - `session.prompt("/regenerate app.plain")` - so there is never a second loop on the same project.
- **The questions.** `dialogs` is `ask_user`'s two dialogs: `select(title, options, context, at)` and `input(title, context)`, each resolving with the answer, or undefined when the person dismissed it. Given, the conversation's questions and a skill's interview are put in them; without it, in the terminal's own dialog.
- **The surface.** What turri tells the model of where the person watches the work is the terminal's by default: regen, the side panel on `ctrl+h`, `/pulses`. In a host none of that is there, and the model would send the person to keys and panels that do not exist. `surface` is the host's own description of its UI - the views it has in place of the terminal's, what its marks and buttons mean, where questions appear - in its own words. Given, turri leaves every terminal instruction out of what the model is told and puts the surface in turri's identity, as a `<surface>` block, where the identity speaks of regen. It reaches the side questions and the tools' own words too: a pulse not found says the `pulses` tool lists them, not `/pulses`. Text only the person sees in the terminal - the job panel, the side panel - is the terminal's and stays as it is. Without `surface`, the prompt is the terminal's, byte for byte.
- **The system prompt.** `systemPrompt(prompt)` gets the whole system prompt for the turn - [pi](https://pi.dev)'s, turri's identity and blocks, the rules - after turri's own `before_agent_start` work, and returns what is sent. It is for what `surface` does not cover; to describe the UI, use `surface`, rather than words appended after turri's that contradict them.
- **The mode.** `mode: "tui"` runs the work in the background and keeps the conversation free, as the terminal does; `rpc`, `json` and `print` wait for each job. The extension's other UI calls - its notices, its working line, a confirm - come to the host's `uiContext`, as [pi](https://pi.dev)'s [SDK](https://github.com/earendil-works/pi) describes it.

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

## The ledger in a host

The conversation's extension starts the ledger itself, in the folder the host made the session in - so a host that runs it there, the project's, needs nothing to have one: its pulses are recorded as `host` runs, and the conversation's `pulses` and `diagnose` already tell the model of earlier sessions' pulses. What the host can do with it is show it.

```js
import { onLedgerEvent, pulseView, readLedger, runViews } from "@turri-dev/cli/host";

// Each event as it is recorded - written or not, so a project with ledger-keep: 0 is heard too.
const stop = onLedgerEvent((entry, project) => {
  if (entry.kind === "healer.failed") notify(`the ${entry.healer} failed: ${entry.error}`);
  if (entry.kind === "provider.error" && !entry.transient) notify(`the model provider: ${entry.error}`);
});

// The project's runs, the most recent first, each with its pulses - how each ended, how long, what it cost.
const runs = runViews(projectDir);

// One pulse, from this session or an earlier one: its rounds, test runs, verdicts, healers, refusals, history.
const view = pulseView("646d", readLedger(projectDir, { job: "646d" }));

// Earlier sessions' pulses as jobs, to list beside this session's - none this session's registry knows.
const { jobs, more } = earlierPulses(ledgerProjects(projectDir), new Set(registry.list().map((job) => job.id)));
```

- **Live.** `onLedgerEvent(listener)` is told every event as turri records it, with the project it is about, until what it returns is called; a listener that throws misses that event and nothing else. It is the pulse's own detail - its stages, test runs, verdicts, refusals - where `onJobChange` is the job as a whole.
- **Read back.** `readLedger(project, { job, run, kinds, since })` is the project's events, oldest first, the gzipped runs too; `runViews` and `pulseView` gather them into runs and pulses, and `describePulseView` and `describeRuns` say them in lines, as `turri ledger` prints them. `ledgerProjects(dir)` finds the ledgers of a folder and the projects under it. `earlierPulses(projects, known, runs = 3)` gives the last runs before this one as `Job`s - the shape a host already draws for this session's - each marked `earlier: { run, runMode, lines }`, `lines` what the ledger says of it; `more` is how many runs are beyond them. They are read only: never started, halted or waited for. turri's own side panel lists them so, as **earlier sessions**.
- **What it is for.** Looking up, never deciding: what is built and what is left come from the records and the work loop, as before. Its events and their fields are `LedgerEvent`'s - a kind is added, never changed, and every event carries `v: 1`.

## Running it

The host entry is compiled JavaScript, so any Node from 22.19 runs it - Electron's own included; nothing strips types. It finds turri's own folders - `genome/`, `stdlib/`, `.pi/` - beside `dist/` in the package, wherever npm installed it.
