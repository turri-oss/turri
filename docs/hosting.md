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
    }),
  ],
});
await loader.reload();
const { session } = await pi.createAgentSession({ cwd, resourceLoader: loader });
await session.bindExtensions({ uiContext, mode: "tui" });
```

- **The jobs.** The pulses the conversation starts - its tools, `/regenerate`, a spec change - run in its own job registry and work loop, the project's one. The host is handed both as they are made, and told of each job as it changes, so it shows the very jobs the conversation runs. Its buttons are best the conversation's commands - `session.prompt("/regenerate app.plain")` - so there is never a second loop on the same project.
- **The questions.** `dialogs` is `ask_user`'s two dialogs: `select(title, options, context, at)` and `input(title, context)`, each resolving with the answer, or undefined when the person dismissed it. Given, the conversation's questions and a skill's interview are put in them; without it, in the terminal's own dialog.
- **The mode.** `mode: "tui"` runs the work in the background and keeps the conversation free, as the terminal does; `rpc`, `json` and `print` wait for each job. The extension's other UI calls - its notices, its working line, a confirm - come to the host's `uiContext`, as pi's [SDK](https://github.com/earendil-works/pi) describes it.

## Running it

The host entry is compiled JavaScript, so any Node from 22.19 runs it - Electron's own included; nothing strips types. It finds turri's own folders - `genome/`, `stdlib/`, `.pi/` - beside `dist/` in the package, wherever npm installed it.
