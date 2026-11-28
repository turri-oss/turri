# The project config

A project says how its \*\*\*plain is built in `config.turri.yaml`, at the project root. Everything in it is optional: with no file at all, turri finds the testing scripts on its own, turns conformance tests on wherever a module has test reqs, and runs on [pi](https://pi.dev)'s configured model. A project whose parts are on different stacks - a backend and a frontend - gives a module a file of its own, `config.turri.<module>.yaml`, beside it, which builds that module and those built on it (see [a module's own config](#a-modules-own-config)). turri never writes a `config.yaml`: it may be another tool's, and is read only by a project that has no file of turri's yet (see [the old config.yaml](#the-old-configyaml)). A key in `config.turri.yaml` or a module's file that turri reads nothing of - a setting it no longer has, like `test-advisor`, or one misspelt - is named in a warning under the banner as turri starts, rather than ignored without a word. A key turri has renamed is renamed in the file itself as turri first reads or writes the project's config - `release-after-pulse`, now `launch-after-pulse` - its value and its comment kept, and the banner says so; a file that sets the new name too is left as it is, the banner saying the old one does nothing.

`turri init-config` starts one: the two models, a strong one to talk to and a smaller one to write the code. It asks which vendor's models you use - `--vendor` says it without asking, and with neither, as from a script, it is `other`:

| vendor | harness-model | coding-model | key [pi](https://pi.dev) reads |
| --- | --- | --- | --- |
| `anthropic` | `anthropic/claude-opus-5-5` | `anthropic/claude-haiku-5-5` | `ANTHROPIC_API_KEY` |
| `openai` | `openai/gpt-6-astra` | `openai/gpt-6-luna` | `OPENAI_API_KEY` |
| `google` | `google/gemini-3.1-pro-preview` | `google/gemini-3.1-flash-lite` | `GEMINI_API_KEY` |
| `amazon-bedrock`, Anthropic | `amazon-bedrock/<region>.anthropic.claude-opus-5-5` | `amazon-bedrock/<region>.anthropic.claude-haiku-5-5` | `AWS_PROFILE` or `AWS_BEARER_TOKEN_BEDROCK` |
| `amazon-bedrock`, OpenAI | `amazon-bedrock/<region>.openai.gpt-6-astra` | `amazon-bedrock/<region>.openai.gpt-6-luna` | `AWS_PROFILE` or `AWS_BEARER_TOKEN_BEDROCK` |
| `claude-code`, a Claude subscription | `claude-code/claude-opus-5-5` | `claude-code/claude-sonnet-5` | none: Claude Code's own sign-in (below) |
| `other` | `anthropic/claude-opus-5-5` | `google/gemini-3.1-flash-lite` | `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` |

Amazon Bedrock asks three more things, from [pi](https://pi.dev)'s catalogue: whose models (`--maker`) - any maker [pi](https://pi.dev) has there, Anthropic, OpenAI, xAI, Meta, Mistral, Qwen, DeepSeek, Amazon, Moonshot, Z.ai, ... - the geography of the inference profile they run in (`--region`) - `global`, `us`, `eu`, `jp`, `au`, `apac`, `in`, `ca` or `us-gov`, as the maker's models are served, or `in-region`, a model served in the AWS region it is called in - and which two. The pair offered is turri's own where it has one - the table's, for Anthropic's and OpenAI's in the geographies they are served in - and otherwise the catalogue's: the strongest model that reasons to talk to, by price, and the cheapest costing at least a fifth of it to code, ties to the newest. Enter takes it; `c` chooses each from the maker's models there. The region is turri's to set, not the person's: [pi](https://pi.dev) calls Bedrock in `AWS_REGION`, else `AWS_DEFAULT_REGION`, else the `AWS_PROFILE`'s region, else `us-east-1` - so every geography but `global`, `us` and `in-region` needs a region of its own (`eu-central-1` for `eu`, `ap-northeast-1` for `jp`, `ap-southeast-2` for `au`, `ap-southeast-1` for `apac`, `ap-south-1` for `in`, `ca-central-1` for `ca`, `us-gov-west-1` for `us-gov`), and turri sets `AWS_REGION` to it in its own process before any model is called (`src/bedrock-region.ts`) - the chat, every command that calls a model, a host's session. `AWS_REGION` or `AWS_DEFAULT_REGION`, set, is always used instead, and so is the profile's region when it is in the geography. Models of two geographies that need two regions get none: one `AWS_REGION` serves every model, and `turri doctor` says which model needs which. `init-config` says which region turri will use. A `config.turri.yaml` already there keeps everything but its two models, which it sets; `--force` writes the whole file again.

`--harness-model` and `--coding-model` name the two models instead, for any vendor: provider/model-id without a thinking level - `turri init-config --harness-model amazon-bedrock/global.xai.grok-4.7 --coding-model amazon-bedrock/global.xai.grok-4.6`. They are written wherever the vendor's own would be - the two models with their thinking, the commented-out `judge-model` and `models:` examples - and the vendor, maker and geography are read from them. `--judge-model` names the strong one the judging examples use, the harness model unless given. Each is checked against [pi](https://pi.dev)'s catalogue first: one it does not have, or that is not a chat model, is named, with the closest it has, and nothing is written.

Each is written with how hard it thinks - `harness-model: openai/gpt-6-astra:medium`, `coding-model: openai/gpt-6-luna:low` - so the file shows it. `init-config` also writes and prints the three active capture tiers. On an existing config it fills in missing capture entries and preserves explicit overrides. The reviews and judges of a regeneration run on the coding model but think medium (see [models per role](#models-per-role)).

They are an example, not a requirement - any model [pi](https://pi.dev) supports works, signed in any way [pi](https://pi.dev) supports; `other` is the starting point for another provider. What we recommend is that split, a capable model to talk to and a smaller, cheaper one for the coding. Once written, it says what to do next: the key to set in your shell - or `/login` in turri, which [pi](https://pi.dev) keeps in `~/.pi/agent/auth.json` - and that the file belongs to that folder: turri reads the nearest `config.turri.yaml` upwards from where it starts, so one written anywhere else is not seen.

Below them it writes every other setting out, each with what it does and the value turri uses for it - `review: false`, `turn-limit: 120`, `parallel-jobs` as this machine's cores make it - so the file says how the project is built, and you change one by changing it. The optional ones, which have no value of their own - the testing scripts (written in by the skill that writes them), `module`, `test-dir`, `judge-model`, `models` - are there commented out, each with an example: uncomment one to use it. A key taken out of the file is still read as the table below says.

Beside a `config.yaml` - another tool's, say - the new file takes from it the keys turri reads too, each in its place, its testing scripts above all, and says which it left (see [the old config.yaml](#the-old-configyaml)); `config.yaml` is left as it is. A `config.turri.yaml` already there keeps everything but its two models, which it sets - `--force` writes the whole file again - and a `config.yaml` turri read until then is copied to it first. It takes a folder other than the current one as its argument.

### A Claude subscription

`--vendor claude-code` runs every agent on your Claude Pro, Max or Team subscription instead of an API key, through Claude Code and [pi-claude-code](https://github.com/earendil-works/pi-claude-code), a [pi](https://pi.dev) extension: `claude-code/claude-opus-5-5` to talk to, `claude-code/claude-sonnet-5` to code. It needs the extension installed (`turri install https://github.com/earendil-works/pi-claude-code`) and Claude Code signed in (`claude auth login`), and none of `ANTHROPIC_API_KEY` and the like set; `turri doctor` checks all of it. Setting it up, its models, checking it yourself and what to know: [a Claude subscription](claude-subscription.md).

## Where it is read from

\*\*\*plain belongs to its **project**: the nearest folder, from its own folder up, that holds a `config.turri.yaml`, a module's `config.turri.<module>.yaml`, the old `config.yaml` or a `plain_modules/`. Without any of them, the \*\*\*plain description's own folder is the project. That folder's config is the one read, and its `plain_modules/` is where the code is built, wherever turri was started. So a project that keeps its \*\*\*plain in `plain/`, with `plain/config.turri.yaml`, builds `plain/app.plain` by `plain/config.turri.yaml` even when `turri` runs in the folder above.

When it is read:

- **In the chat**, afresh: the chat's agent is told what it says on every turn, and each regeneration reads it when it is queued. An edit to the file holds from the next turn and the next regeneration, with no restart. The agent is told the config of the session's folder and of the projects one folder down.
- **On the command line**, once, when the command starts. `turri regenerate` takes `module:` from the folder it is run in, and the rest from \*\*\*plain's own project.

## Changing it from the chat

`/settings` changes any key in the chat, and writes it into the `config.turri.yaml` of the folder turri was started in - its comments, and the commented-out examples, kept. Alone, it lists every key with what it is now, and asks for the value of the one you pick the way the key takes it: `true` or `false`, one of its words, a number from a few offered or typed, a model from those this machine can reach and then how hard it thinks, a script or a `.plain` file the project has, rules ticked on and off. `/settings review` asks for review's value; `/settings review false` sets it, and `/settings review unset` takes it out, back to its default. Completion offers the keys, then each one's values. Each role's model and turn limit is `models.<role>` and `models.<role>.turn-limit` - `models.coding`, `models.planner.turn-limit`. It takes [pi](https://pi.dev)'s own `/settings` over: pi's menu - the theme, the editor, how the chat is shown - is the last entry of its list.

You can ask the chat too - "regenerate with gpt 5.5 from now on" - and its `settings` tool writes `coding-model` for you, the model checked as it is written, by the name you said: one that fits several models, or none signed in, comes back to you as a question instead. It writes into `config.turri.yaml`, or a module's own file (see [a module's own config](#a-modules-own-config)), and says what it set and when it takes effect. It changes a setting only when you ask, and some it never changes, whatever you ask - they are yours, with `/settings`:

| yours alone | why |
| --- | --- |
| `conformance-tests` | it doubles the time each change takes - see [conformance tests](#conformance-tests) |
| `agent-env`, `toolchains` | they hand the agents credentials, and folders of this machine past the [sandbox](sandbox.md) |
| `sentinel` | it checks the chat's own work |
| `rules-off` | it takes \*\*\*plain rules out of the chat's own prompt |
| `ledger-keep` | the ledger is the record of what the agents did |

A path it writes stays inside the project. For one pulse on another model, the chat passes `model` to `regenerate` or `conform` instead, and the config stays as it is.

Each change says when it takes effect. None needs turri started again - what turri fixes as it starts is changed as it runs:

| when | keys |
| --- | --- |
| now | `harness-model` and `models.chat` - the conversation switches to it; `parallel-jobs` - a pulse waiting for a slot starts if there is one now; `allow-to-stop-jobs` |
| your next message | `rules-off` - for the conversation; a skill's agents from the next skill run |
| the next pulse - one running keeps what it started with | `coding-model`, `judge-model`, every other `models.<role>`, `review`, `mutation-testing`, `turn-limit`, `compact-at`, `agent-env`, `toolchains`, `debug` |
| the next time the work is planned | `max-specs-per-pulse`, `max-lines-per-pulse` |
| the next test run - the running pulse's too | the testing scripts, `testing-scripts-run-on` |
| the next pulse that lands - the running one too | `launch-after-pulse`, `sentinel` |
| the next regeneration that names no `.plain` file | `module` |
| the next time turri starts here | `ledger-keep`, `cache-keep` |

A coding model given for this session with `--coding-model` gives way to one set here: the last word wins. It says, too, what wins over the change: `models.chat` over `harness-model` (and so on), and a module's own `config.turri.<module>.yaml`, which `/settings` does not change, for that module and those built on it. In a project still read from `config.yaml`, the first change copies it to `config.turri.yaml` first - see [the old config.yaml](#the-old-configyaml).

## The keys

```yaml
module: app.plain                    # what to build when no .plain file is named
conformance-tests: false             # whether functional specs are conformance tested - false: none (default: false)
test-dir: tests                      # the test plain files, a folder per module (default: tests)
base-folder: existing-app            # what a codebase that requires no module starts from (default: nothing)
harness-model:                       # the model you chat with
  model: anthropic/claude-opus-5-5
  thinking: high
coding-model:                        # every render (default: harness-model)
  model: amazon-bedrock/eu.anthropic.claude-sonnet-5
  thinking: low
judge-model:                         # the verdicts of a conformance run (default: coding-model)
  model: amazon-bedrock/eu.anthropic.claude-sonnet-5
  thinking: medium
unittests-script: test_scripts/run_unittests_python.sh
conformance-tests-script: test_scripts/run_conformance_tests_python.sh
testing-scripts-run-on: copy         # what the testing scripts run on: copy - a fresh copy (default: in-place - the code itself)
turn-limit: 150                      # seconds each agent turn has (default: 120; 0 for none)
models:                              # each agent role's model, thinking and turn limit - see below
  default: amazon-bedrock/global.openai.gpt-6-luna
  coding: { model: amazon-bedrock/eu.anthropic.claude-sonnet-5, thinking: high, turn-limit: 180 }
  explorer: google/gemini-3.1-flash-lite
```

| key | what it sets | left out |
| --- | --- | --- |
| `module` | the `.plain` file `turri regenerate` and the chat's `regenerate` build when none is named, from the project root | a file has to be named |
| `harness-model` | the model `turri` starts on - the one you talk to - and, in the conversation, the planner that cuts the work into jobs (on whatever model the chat is on when it plans); under `turri regenerate`, the planner too | [pi](https://pi.dev)'s configured model |
| `coding-model` | every regeneration: functionalities, \*\*\*plain diffs, conformance tests, repairs, planning \*\*\*plain diffs, the explorer | `harness-model` |
| `judge-model` | the judge and the test review of a conformance run | `coding-model` |
| `review` | `true` or `false`: whether the code and its unit tests - and the conformance tests - are reviewed once they pass: two reviews at most, the second weighed by the arbiter; off, a job lands once its tests pass. A module's first pulse of one functional spec - the project set up and the smallest thing that runs - lands on its unit tests with no review - see [regenerating the code](regenerating.md#the-code-and-its-unit-tests-are-reviewed) | `false` |
| `mutation-testing` | `true` or `false`: whether the coding agent and the reviewer have `can_it_fail` - one change put in the code for one run of the unit testing script, to see that a test catches it; on a copy of the code, or in place and put back after the run (see [regenerating the code](regenerating.md#checking-its-own-work)). `turri regenerate --mutation-testing false` for one run | `true` |
| `rules-off` | a list of rule names - `integrations`, `concise-specs`, the files of `genome/rules/` without `.md` - left out of the conversation's prompt and every \*\*\*plain-writing agent's: a rule this project's own skills or AGENTS.md replace, such as one that says to probe a live API before any \*\*\*plain is written. `turri init-config` writes it with `integration-embedded`, `integration-embedded-testing` and `integration-standalone` - take them out when the project writes an integration against a REST API. The project's alone | none |
| `allow-to-stop-jobs` | `true` or `false`: whether turri stops a running job \*\*\*plain has moved on from - a functional spec it regenerates changed, or a file one links was edited - rolls it back and regenerates \*\*\*plain as it now is. `false`: the job runs to its end and lands, and what changed since is regenerated on top of it by the next job - see [regenerating the code](regenerating.md). Your own `halt` stops a job either way | `true` |
| `launch-after-pulse` | `true` or `false`: whether every pulse that lands code is launched, in the chat, in the background - the pulse ends as it lands, and the codebase's next pulse does not wait: the commit it landed goes on the [launch track](launch.md#the-launch-track), one launch of a codebase at a time, the newest commit winning. An agent on the coding model launches it, following the project's launch guidance (what was passed to `launch` this session, AGENTS.md, the project's skills) for how, or from `dist/<module>` without any - see [launch](launch.md#after-every-pulse). The sentinel tests each pulse in a launch that holds its commit; with it off, the chat is told how each launch went. `turri init-config` writes `true`. Formerly `release-after-pulse`: a file that still has it has it renamed as turri first reads it | `false` |
| `sentinel` | `ask`, `true` or `false`: whether the sentinel checks each finished pulse, tests what was launched under `launch-after-pulse`, and reports findings in notifications. `ask`: answer the start question in notifications before it first opens in a session - see [starting it](sentinel.md#starting-it); `true`: it opens without asking. `/sentinel` sets it from the chat. `turri init-config` writes `ask` | `ask` |
| `conformance-tests` | whether functional specs are conformance tested - black-box tests of the built software against the scenarios of their test plain files, run with the whole suite as more lands. `false`: none - no scenarios written or tested, no conformance testing script, and the chat's `conform` refused. Off by default for fast iteration - they make each change take about twice as long - and turned on by the person, with `/conform` - see [conformance tests](#conformance-tests). A module's `config.turri.<module>.yaml` can set its own | `false` |
| `test-dir` | the folder of the test plain files, by path from the project root: a module's are every `.plain` file in `<test-dir>/<module>/`, each a functional spec's conformance and acceptance scenarios - see [test plain files](parser.md#test-plain-files). A module's `config.turri.<module>.yaml` can set its own | `tests` |
| `base-folder` | a folder, by path from the project root, that a codebase requiring no other module starts from instead of nothing - an existing codebase to build on, files to use (images, animations, fonts), or both. It is copied in once, before the codebase's first pulse, and never written to: from a git repo what git sees, else every file but `.git` and installed dependencies. The \*\*\*plain may refer to it, and link into it; a codebase built on another starts from that one's code, base folder and all. A module's `config.turri.<module>.yaml` can name its own - see [the base folder](regenerating.md#the-base-folder) | none: the codebase starts empty |
| `unittests-script` | the unit testing script, by path from the project root - it runs the code's static checks too, exiting 80 when only they fail (see [the static checks](regenerating.md#the-static-checks)) | looked for - see below |
| `conformance-tests-script` | the conformance testing script, by path from the project root | looked for - see below |
| `prepare-environment-script` | optional: run as `<script> <build>` before every run of the conformance testing script, which runs only once it passes - see [the testing scripts](regenerating.md#the-testing-scripts). turri never writes one | the one `prepare_environment*.sh` at the root or in `test_scripts/`, else none |
| `compact-at` | how many tokens of work - past its instructions - an agent kept through a job holds before the harness compacts it between turns; at least 1000; the project's alone | 100,000 - see [agent sessions](regenerating.md#agent-sessions) |
| `ledger-keep` | how many megabytes of the ledger - what turri did, as facts, in `.turri/ledger` - the project keeps: past it, the oldest runs' are pruned when a run first writes; `0` keeps none, and writes none; the project's alone. See [the ledger](using.md#the-ledger) | 100 |
| `debug` | `true` or `false`: whether turri keeps what it writes only for a person debugging it - every agent's whole log and saved session, each pulse's log, the whole outputs of its test runs and services, its agents' temporary files, and the dependencies installed in the modules a chain has left behind. `false`: only what turri reads to work is kept. `TURRI_DEBUG=1` - or `turri --debug` - turns it on for one run, and `TURRI_DEBUG=0` off; the project's alone. See [debug mode](#debug-mode) | `false` |
| `cache-keep` | how many megabytes of package caches the project keeps - `plain_modules/.turri/cache`, and the caches in the agents' home folders: past it, the least recently written - by the newest file in each - are removed when a run starts its first agent command, each downloaded again when it is wanted; `0` keeps none; the project's alone | 4096 |
| `max-specs-per-pulse` | the most functional specs the planner groups into one pulse - what builds one feature goes together, up to this many; a module's file wins | 3 |
| `max-lines-per-pulse` | the most lines of \*\*\*plain in one pulse - its functional specs with the definitions they bring; a group past it is split again, a functional spec a pulse; a module's file wins | 120 |
| `parallel-jobs` | how many jobs the chat runs at once - modules that share nothing build side by side up to it; read when the chat starts, from the folder it starts in | half this machine's cores, between one and four - see [how many jobs at once](#how-many-jobs-at-once) |
| `agent-env` | credentials the agents' commands need while they work - a live API probed, tests run against a real service: `files: [...]`, dotenv files by path from the project root, every variable in them; `vars: [...]`, variables by name from the environment turri was started in. A module's `config.turri.<module>.yaml` adds its own to the project's. See [credentials for the agents](#credentials-for-the-agents) | none: an agent's commands get no credential |
| `toolchains` | folders of this machine an agent's commands may read beside the system's, the `PATH`'s and those the toolchain variables point at - a toolchain installed somewhere unusual (`[/srv/zig]`). A module's add to the project's. See [the OS sandbox](sandbox.md#the-os-sandbox) | none |
| `turn-limit` | seconds each turn of an agent a job starts has, for every role without its own (`models:`); `0` for none. The config is the only place it is set. A turn past it ends at its next request to the model - see [regenerating the code](regenerating.md) | 120 |
| `models` | each agent role's own model, thinking and turn limit - see [models per role](#models-per-role) | every role on `coding-model`, the conversation's side on `harness-model` |
| `testing-scripts-run-on` | what the testing scripts run on - always on this machine, in your environment. `in-place`: the real build and tests folders, the script at its own path, from the project - so a script that finds a host codebase from its own path finds it. `copy`: a fresh copy of the code, staged in `plain_modules/.turri/scripts/`, with the script copied beside it. `can_it_fail` works on either: on a copy it changes the copy, in place the code itself for the one run, put back after it (see [the testing scripts](regenerating.md#the-testing-scripts)) | `in-place` |

Keys are written with dashes; underscores are read the same (`mutation_testing`). A key turri does not know is ignored - another tool's `config.yaml`, read while it is the old file, may carry several - and so is a value of the wrong type, as if it were not there. `model:`, from before there were separate models, is read as `coding-model`.

## Models per role

`models:` gives each kind of agent its own model, thinking level and turn limit. Each entry is a model (`provider/id`, or `provider/id:thinking`) or `{ model, thinking, turn-limit }`, any of which may be left out:

| role | the agents |
| --- | --- |
| `default` | every role not named below - but the conversation's side |
| `chat` | `turri`'s model - the same as `harness-model`, which it wins over |
| `sentinel` | [the sentinel](sentinel.md): checks every finished pulse, and tests what was launched. Unnamed, the chat's model |
| `planner` | the conversation's side: the planner's agents. Unnamed, the chat's model |
| `capture-exploration` | gathers the interface reference from the original code. Claude default: Haiku low |
| `capture-analysis` | checks evidence and conventions, outlines areas and features, and trials scenarios on the original. Claude default: Sonnet low |
| `capture` | reasons about requirements, writes and revises \*\*\*plain and writes custom runners. Claude default: Opus medium. `init-config` writes all three active [capture tiers](capture.md#models); setting one does not change the others |
| `diagnosis` | the diagnosis of a job that failed for good: why it did not land, and what to do. Unnamed, the coding model the job ran on, thinking medium |
| `launch` | the launch agent - the chat's `launch`, `turri launch` and launch-after-pulse's: it follows steps - a script, a start command - so it runs on the coding model, thinking low |
| `coding` | the coding agent, the code fixer of a conformance run and the repair agent - the same as `coding-model`, which it wins over. `--model` on the command line, or a model a call to `regenerate` or `conform` names, wins over both |
| `conformance` | the conformance agent |
| `explorer` | the explorers of a conformance run |
| `reviewer` | the review of the code and its unit tests |
| `test-reviewer` | the review of the conformance tests - `judge-model` too, when it is set |
| `judge` | the judge of a failing conformance run - the same as `judge-model`, which it wins over |
| `arbiter` | the arbiters that weigh a second review |
| `debugger` | the fresh look at unit tests that keep failing the same way, or a coding agent going round in circles. Unnamed, `judge-model` when it is set, else the harness model - not `default` |

What an entry leaves out it takes from `default`: `reviewer: { thinking: low }` runs the default model, thinking little. A turn limit is the role's own, else `default`'s, else `turn-limit:`, else two minutes. A module's `config.turri.<module>.yaml` lays its own `models:` over the project's, role by role - all but `chat`, the project's alone.

A role whose thinking nothing names - neither its entry, `default`'s, nor a `:level` on the model it runs on - thinks as its kind of work needs: **low** for `coding`, `conformance`, `explorer`, `launch` and `capture-analysis`, and **medium** for `reviewer`, `test-reviewer`, `judge`, `arbiter`, `debugger`, `planner`, `capture` and `diagnosis`. Capture analysis and a judging role that falls back on the coding model take its model alone, not its thinking. The conversation keeps its own level, as [pi](https://pi.dev) sets it.

The thinking level reaches the model as each provider takes it. OpenAI's models on Bedrock are sent it as their reasoning effort (`none`, `low`, `medium`, `high`, `xhigh`) by turri itself, as [pi](https://pi.dev) sends them none.

## How many jobs at once

Jobs on the same module, or on modules of one `requires` chain, always run one after another. Modules that share nothing - a backend, a frontend, a worker, ten of them - build side by side, each pulse's builds and tests running on this machine beside your own work. So the chat runs at most `parallel-jobs` jobs at once; a job whose turn has come waits for a free slot past that, and its line says so. Unset, it is half this machine's cores, at least one and at most four. The config is the only place it is set. It is the project's alone, never read from a module's file.

The testing scripts all run on this machine, each on a copy of its module's code, so they never share files - but they do share its network: two modules whose conformance scripts start a server on the same port collide when they run at once. Give each its own.

## Models

Each model is a model reference and a thinking level - `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` - and either may be left out:

```yaml
coding-model:
  model: google/gemini-3.1-flash      # the provider and the model id, as pi names them
  thinking: medium
judge-model: google/gemini-3.1-pro:high   # the same, as one string
harness-model: anthropic/claude-opus-5-5  # a model alone
```

What a model leaves out it takes from the one it inherits: `judge-model` from `coding-model` - its model, not its thinking, which the judging roles have their own of - and `coding-model` from `harness-model`. So with only a harness model, everything runs on it; `coding-model: {thinking: low}` regenerates on the harness model, thinking less.

They are defaults. What is asked for wins over them:

| model | wins over the config |
| --- | --- |
| harness | `--harness-model <m>` (or [pi](https://pi.dev)'s own `--model`, for `turri`), and [pi](https://pi.dev)'s `/model` in the conversation |
| coding | `--coding-model <m>` (or `--model`, for a command) |
| judge | `--judge-model <m>`, for `turri regenerate`, `conform` and `doctor` |

The options are read as the keys themselves, for that run: `turri`, `turri regenerate` and `conform` - and `--review` and `--mutation-testing` for the two commands - take each key's value as if the file had it, in its place in the order above, so a `models:` entry still wins over it. A headless run is the same as a chat with those keys in the file.

A job keeps the model it was queued with: choosing another holds for what is queued after.

## Conformance tests

`conformance-tests: true` turns them on, a module's `config.turri.<module>.yaml` able to say its own. Unset, they are off, and `turri init-config` writes `conformance-tests: false`: no scenarios are written or tested, no conformance testing script is written, no conformance pulse runs - in the work loop, from `conform` or `turri conform` - and the chat's `conform` is refused. Test plain files already there are kept and parsed, and not tested: `parse` and `drift` say so. Turning them on is yours to decide, as they make each change take about twice as long: the chat always knows what they are, that they are off, and how they are turned on, and when it thinks a module needs them - or you ask it for them - it tells you why, and leaves it to you. `/conform` turns them on: it writes `conformance-tests: true` - into the module's config file when that names the key, else `config.turri.yaml` - in effect at once, and kept for the sessions after, then tests what has scenarios and code at once. So does `/settings conformance-tests true`, without testing anything.

On, what is tested is the functional specs with scenarios - the conformance and acceptance scenarios of each one's test plain file, `<test-dir>/<module>/<func-id>.plain` - in every module with `***test reqs***`. A functional spec with no test plain file is not tested, and a module with no functional spec with scenarios gets no conformance pulse at all - but keeps the codebase's existing tests passing. `test-dir` says where the test plain files are. To have a functional spec tested, write its scenarios: the chat writes them with its file tools, then calls `regenerate`, when you ask for conformance tests (see [conformance tests](regenerating.md#conformance-tests)).

## The testing scripts

A build needs a unit testing script - and, with conformance on, a conformance testing script - to decide when it is done. They are looked for at the project root, in this order:

1. named in the config - the module's own file first (or the one of a module it requires), then `config.turri.yaml` - by path from the root;
2. the one `run_unittests*.sh` / `run_conformance_tests*.sh` in the project root;
3. the one of each in `test_scripts/`.

Where modules have files of their own, a module with none - nor any module it requires - never takes a script one of those files names from 2 or 3: it is another module's, of another stack. It waits for one of its own instead, saying which file names which.

The optional prepare script - `prepare-environment-script:`, else the one `prepare_environment*.sh` - is looked for the same way, and run on the build before the conformance testing script.

A folder holding two of a kind is not guessed between: name the one to use. A script named inside `plain_modules/` is refused - agents write there, so it could be changed by the work it judges. The scripts are never linked from \*\*\*plain. What they are and how they run is in [regenerating the code](regenerating.md#the-testing-scripts).

## Debug mode

turri writes much more than it needs to work, for a person working out why it did what it did - each agent's whole conversation, each pulse's whole transcript, every test run's whole output. Most of it nothing of turri ever reads again. So by default it is not kept:

| | outside debug mode | in debug mode |
| --- | --- | --- |
| each pulse's log (`.turri/jobs/`) and its agents' (`.turri/debug/`) | written while the pulse runs - the diagnosis of a failure reads them - and removed as it ends | kept |
| the logs of agents outside a pulse - the launch agent, a side question | not written | kept |
| the agents' saved sessions (`.turri/sessions/`) | not written - each is kept in memory while it works; a gated skill's alone is saved, as its run resumes from it | kept |
| whole outputs of test runs and services (`plain_modules/.turri/logs/`, `services/`) | read by the pulse's agents while it runs, removed as it ends | kept, the last 100 outputs |
| a module's `TMPDIR` (`plain_modules/.turri/tmp/<module>`) | emptied as each of its pulses ends | kept |
| dependencies installed in the modules below a pulse's own in its chain (`node_modules`, `.venv`) | removed as the pulse ends: the chain is built in its tip, and a module built on again installs them again, from the cache | kept |

Kept either way: the ledger - what each pulse did, how it ended, what it cost (see [the ledger](using.md#the-ledger)) - and, for each pulse that failed or finished without landing, why: its report in `.turri/pulses/<id>.md` - its diagnosis, the stages that went wrong, the last failing test run's output, the last review that sent the work back, the tool calls that failed - which `pulses` tells with it in a later session, the newest 200 kept and none where `ledger-keep: 0`; the code, its tests and their history, a gated skill's run, what a conformance explorer found, what a launch started, and the package caches, held to `cache-keep:`. The testing scripts install what they run with themselves, so nothing removed is ever missed by a test run.

Turn it on in `config.turri.yaml` (`debug: true`, or `/settings debug true`), or for one run with `TURRI_DEBUG=1` or `turri --debug`.

## Credentials for the agents

An agent's commands do not get the environment turri was started in: it holds your providers' API keys, cloud credentials and tokens. They get only the path, the locale, the terminal and the user, the variables that locate your toolchains (`JAVA_HOME`, `NVM_DIR`, `RUSTUP_HOME`, ... - the ones in your home found even when your shell sets none), and turri's own: a home folder of the module's own (`plain_modules/.turri/home/<module>`, kept between pulses, with a git identity of its own), a `TMPDIR`, the package caches in `plain_modules/.turri/cache`, and git stopped at the module folder, so a project that is itself a repository is never found from the code.

A project whose agents need a credential while they work names it:

```yaml
agent-env:
  files: [.env]              # every variable of these dotenv files, by path from the project root
  vars: [D365_TENANT_ID]     # these variables, from the environment turri was started in
```

What it names reaches every agent with a shell, as environment variables of its commands only - the file stays where it is, outside every agent's reach - and never replaces turri's own home, `TMPDIR` or caches. A module's file adds to the project's. A file that is not there, or a variable unset or empty, is reported as missing. The testing scripts are not affected: they run in your own environment.

Their values never appear in what an agent is shown or what turri writes: each is replaced by its name - `[D365_CLIENT_SECRET]` - whole, URL-encoded, or split over a command's output as it streams: in every tool result and refusal an agent is given (and so in the session transcripts, which hold only those), in the whole outputs kept for `read_output`, and in the job and debug logs. A value shorter than four characters is not masked - `1` or `eu` is everywhere in ordinary output.

## A module's own config

One project can hold parts that share nothing but a common module - a Python backend and a React frontend side by side, each importing `base` from `template/`, neither requiring the other - each needing its own testing scripts. A module can have a file of its own beside `config.turri.yaml`, `config.turri.<module>.yaml`, holding what differs for it - typically its testing scripts, its `toolchains:`, its models:

```
config.turri.yaml            # the project's: harness-model, coding-model, review
config.turri.backend.yaml    # backend.plain's: its testing scripts
config.turri.frontend.yaml   # frontend.plain's: its testing scripts, and a coding model of its own
backend.plain                # import: [base, python_fastapi_template]
backend_auth.plain           # requires: [backend] - built with config.turri.backend.yaml too
frontend.plain               # import: [base, react_vite_template]
template/                    # base.plain, python_fastapi_template.plain, react_vite_template.plain
test_scripts/                # both modules' scripts
```

```yaml
# config.turri.frontend.yaml
unittests-script: test_scripts/run_unittests_typescript.sh
conformance-tests-script: test_scripts/run_conformance_tests_typescript.sh
coding-model:
  thinking: high
```

Nobody chooses which file builds a module: turri works it out from the module, the same in the chat and on the command line.

1. **`config.turri.yaml`**, by default.
2. **The module's own file**, `config.turri.<module>.yaml`, laid over it.
3. **The file of a module it requires**, when it has none of its own - all the way down its `requires` chain. A module is built on the code of those it requires, in one codebase, with their testing scripts: `backend_auth.plain` is built with `config.turri.backend.yaml`, and so is every module built on it that has no file of its own. Only `requires` counts, not `import`.
4. **An error**, when two modules it requires have a file of their own and it has none: which one builds it cannot be told. `turri parse` says so, and `regenerate` and `conform` refuse it - give the module its own file, or keep one of theirs.

How a module's config is made:

- **Laid over `config.turri.yaml`, key by key.** What the module's file gives wins; what it leaves out is the project's. A model it names takes what it leaves out from the project's same model - above, `frontend.plain` regenerates on the project's coding model, thinking `high`.
- **Pinned to each pulse.** A pulse runs with the config it was planned with - its test runs, the scripts found, its agents - and a pulse waiting for a free slot keeps the one it was queued with. A module is looked at again each time it is asked for or its \*\*\*plain changes: a file added since is used from its next pulse. What `regenerate` says back names the file each module is built with, and so does a pulse's report.
- **Refused when that cannot build.** In a project where modules have files of their own, a module with none - and none among the modules it requires - is refused before anything is planned when `config.turri.yaml` alone names no unit testing script: every pulse would stop for want of one. The refusal names the modules' files and the script each names. Give the module a file of its own - the chat's `settings` tool writes one, with `module` - or name the script in `config.turri.yaml`.
- **The project's alone.** `module:`, `harness-model:`, `parallel-jobs:`, `rules-off:`, `compact-at:`, `ledger-keep:`, `debug:` and `cache-keep:` are read only from `config.turri.yaml` - there is one conversation, one module built when none is named, one machine. `agent-env:` and `toolchains:` in a module's file add to the project's.

The chat is told each module's file and the modules it builds. The skills that write testing scripts put each module's scripts in its own file once a project has two, named after the module at the bottom of its chain.

## The old config.yaml

turri's settings were once in `config.yaml`, and a module's own in `config.<module>.yaml`. A `config.yaml` may be another tool's, so turri never writes one. While a project folder has no `config.turri*.yaml` at all, turri still reads its `config.yaml`, and each `config.<name>.yaml` as the module `<name>`'s own.

The first time turri itself writes a setting there with `/settings`, it copies `config.yaml` to `config.turri.yaml` and each `config.<name>.yaml` to `config.turri.<name>.yaml` first, leaves the old files as they are, and from then on reads only the new ones. `turri init-config` copies the modules' files the same way, but writes `config.turri.yaml` as its quick start, taking from `config.yaml` only the keys turri reads too - `unittests-script`, `conformance-tests-script` and `prepare-environment-script`, say - each in its place in the file, and saying which keys it left: `template_dir`, `verbose`, `api`, the other tool's alone. The two models are the vendor's, never taken. To change a setting by hand in such a project, do the same: copy the files to their new names, and edit the copies - never `config.yaml`. Writing a `config.turri.yaml` of your own beside it is the same move: from then on `config.yaml` is not read, its testing scripts with it. For a headless run that only needs conformance tests or another judge, or review, those options leave the files alone: `--conformance-tests`, `--judge-model`, `--review true|false`, and the models' too.

Keys turri does not read - another tool's `verbose`, `api-key`, `build-folder`, ... - are ignored without a word, and so is a value of the wrong type.

## A config that does not parse

A `config.turri.yaml` - or a module's own file, or a `config.yaml` turri still reads - that is not valid YAML is read as empty: none of it applies, and turri would run on its defaults and [pi](https://pi.dev)'s, the models among them - pi's own default model, which may not be one your credentials reach. A key set twice is the usual way in: a second config pasted under the first. So turri says it, never silently (`configProblems` in `src/config.ts`), naming the file, the line and what is wrong - `config.turri.yaml, line 13: conformance-tests is set twice`:

- **The chat** says it under the banner, in the error colour, as it starts.
- **Nothing is regenerated with it.** `regenerate`, `conform`, `/regenerate`, `/conform` and `turri regenerate` refuse to start a pulse until it parses, saying why - as they refuse a module that cannot be built with its config.
- **A capture** started where it is in use refuses to start, since the captured project starts as that config ([capture](capture.md)).
- **`turri doctor`** lists it first among the project's checks.

Fix it - each key set once - and ask again.
