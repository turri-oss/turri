# Running turri in a host

`turri` runs its conversation in a terminal. A host - a desktop app, an editor - can run the same conversation itself, in its own window, and show what turri's terminal would draw in its own way: the jobs, the questions, the spec. It imports turri from npm as `@turri-dev/cli/host`.

## What the host entry gives

`@turri-dev/cli/host` is turri's compiled code (`dist/host.js`, with its types) - the conversation and what a host shows beside it:

| export | what it is |
| --- | --- |
| `createTurriExtension(host)` | turri's conversation as an extension of pi's: every tool, slash command, rule and skill the terminal has. The host is told of its jobs and asks its questions - see below. |
| `pi` | pi itself, as turri's extension is built against it. Make the session with this one - `pi.createAgentSession`, `pi.DefaultResourceLoader` - not another copy. |
| `readProjectConfig`, `projectModels`, `modelSpec`, `configForSpec`, `hasProjectConfig`, `stacksOf` | the project's settings, as [config.turri.yaml](config.md) has them. |
| `initConfig(dir, { vendor, bedrock, force })`, `VENDORS`, `BEDROCK_REGIONS`, `BEDROCK_DEFAULT`, `bedrockModels` | a project's first config.turri.yaml, as `turri init-config` writes it: the host asks which vendor's models - `VENDORS` has each one's label and its two models, `BEDROCK_REGIONS` where Bedrock serves each maker's - and `initConfig` writes it, saying what it did. One already there keeps everything but its two models. |
| `checkPlainFile`, `plainFileParser`, `resolveTemplateDirs`, `iterateFunctionalSpecs`, `FUNCTIONAL_REQUIREMENTS` | a spec checked and parsed, its functional specs one by one - as `turri validate` reads it. |
| `highlightLines`, `roleOf` | a spec's lines coloured by turri's own \*\*\*plain grammar. |
| `functionalityCompletion`, `createWorkLoop`, `createJobRegistry`, `promptOf`, `describeModules` | how far each functional spec is built, and - on a loop of the host's own with `dryRun` - the work a spec change would plan, as `turri glimpse` does. |
| `onModelEvent`, `describeTurnIncident` | a provider failing and waited out, a turn turri ended itself. |
| `onLedgerEvent`, `readLedger`, `ledgerDir`, `runViews`, `pulseView`, `describePulseView`, `describeRuns`, `ledgerProjects`, `earlierPulses`, `asJob` | what turri did, as facts - the [ledger](using.md#the-ledger): each event heard as it is recorded, and every run and pulse read back, earlier sessions' too - see [the ledger in a host](#the-ledger-in-a-host). |
| `sweepOrphanedGroups` | stop what a turri killed outright left running, before anything starts. |

It is turri's own code, as the terminal runs it: a 0.x release may change any of it.

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

- **The jobs.** The pulses the conversation starts - its tools, `/regenerate`, a spec change - run in its own job registry and work loop, the project's one. The host is handed both as they are made, and told of each job as it changes, so it shows the very jobs the conversation runs. Its buttons are best the conversation's commands - `session.prompt("/regenerate app.plain")` - so there is never a second loop on the same project.
- **The questions.** `dialogs` is `ask_user`'s two dialogs: `select(title, options, context, at)` and `input(title, context)`, each resolving with the answer, or undefined when the person dismissed it. Given, the conversation's questions and a skill's interview are put in them; without it, in the terminal's own dialog.
- **The surface.** What turri tells the model of where the person watches the work is the terminal's by default: regen, the side panel on `ctrl+h`, `/pulses`. In a host none of that is there, and the model would send the person to keys and panels that do not exist. `surface` is the host's own description of its UI - the views it has in place of the terminal's, what its marks and buttons mean, where questions appear - in its own words. Given, turri leaves every terminal instruction out of what the model is told and puts the surface in turri's identity, as a `<surface>` block, where the identity speaks of regen. It reaches the side questions and the tools' own words too: a pulse not found says the `pulses` tool lists them, not `/pulses`. Text only the person sees in the terminal - the job panel, the side panel - is the terminal's and stays as it is. Without `surface`, the prompt is the terminal's, byte for byte.
- **The system prompt.** `systemPrompt(prompt)` gets the whole system prompt for the turn - pi's, turri's identity and blocks, the rules - after turri's own `before_agent_start` work, and returns what is sent. It is for what `surface` does not cover; to describe the UI, use `surface`, rather than words appended after turri's that contradict them.
- **The mode.** `mode: "tui"` runs the work in the background and keeps the conversation free, as the terminal does; `rpc`, `json` and `print` wait for each job. The extension's other UI calls - its notices, its working line, a confirm - come to the host's `uiContext`, as pi's [SDK](https://github.com/earendil-works/pi) describes it.

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
