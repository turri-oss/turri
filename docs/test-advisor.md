# The test advisor

Which functional specs need explicit testing scenarios is not obvious, and not every one should be tested - only the functionality that matters. The test advisor decides for you: when a functional spec is new or its text changed and it has no scenarios, turri checks in the background whether it needs testing, and when it does, writes what testing it takes itself - the \*\*\*test reqs\*\*\*, the conformance testing script and its scenarios - so the module's conformance pulse runs once its code is built. You are never asked anything.

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
