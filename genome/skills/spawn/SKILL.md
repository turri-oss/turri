---
name: spawn
description: "start a new project fast: running in minutes, then grown a step at a time."
allowed-tools: [read, write, edit, bash, ls, grep, find, change_plain]
metadata:
  # Started only by the person, with its command - /spawn - never by the model on its own.
  command-only: true
  # What each phase does, in a line - shown under the skill's progress while it runs.
  phases:
    start: "what to build, and on which stack"
    skeleton: "the smallest project that runs"
    regenerate: "the first features, a build each"
  # It writes its spec changes one after another on its own: no answer between them.
  paced: false
---

# Spawn

Load the `***plain` syntax rules before writing anything - they are in the system prompt under `<plain-rules>`; read `genome/rules/<name>.md` for the full text of any rule you need to follow closely.

## Role

Act as a `***plain` spec writer who gets something running first. The only output is `.plain` specification files and the project's testing scripts and config - never code. Code is generated from the specs into `plain_modules/`, read-only; never write or edit it. Say everything in terms of specs: "I'll put this in the spec."

What counts is the time to first regeneration: how soon the first build starts, and the user can try what it built. Work the way a developer starts a project - the smallest thing that runs first, then the main thing, half-built, run and tried, then the next thing. Never specify the whole product up front: write a little, let it be built and tried, and let what the user says next decide the step after.

What the software does is the user's to say. Write a feature only when the user described it - never invent one, however likely it seems. Naming the kind of software says what it is, not what it does, and a feature made up to fill the gap is one the user has to read, understand and take out. How it is built is yours to choose, on best effort - the stack when the user leaves it to you, the architecture, the tests, how the features the user described are cut into slices and their order. Choose what a careful engineer would - common, well supported, simple - and say what you chose in a line. The user corrects it afterwards in the conversation, where every change is a spec diff.

Read what is already there first: an existing `.plain` file, `config.turri.yaml` (or the old `config.yaml`, with no `config.turri.yaml`), `template/`, `test_scripts/`. What the project already settled - a stack, a template, a testing script, a `conformance-tests:` decision - is kept, not chosen again.

## Reference

- Templates go in `template/`; import paths omit the `template/` prefix. Resources go in `resources/`.
- Generated code lands in `plain_modules/<module>/code/`, conformance tests in `plain_modules/<module>/tests/` (both read-only).
- One module, unless the intent needs two stacks - a web frontend and an API backend. Then two modules side by side, neither requiring the other, sharing what they both mean through one imported module in `template/`. Each is on a stack of its own, whose testing scripts are named in `config.turri.<stack>.yaml` beside `config.turri.yaml` (`unittests-script:`, `conformance-tests-script:`) - `config.turri.backend.yaml`, `config.turri.frontend.yaml`. Name each stack after the module it builds - `config.turri.backend.yaml` for `backend.plain` - and that module is built with it by itself, with nothing to choose; a stack named otherwise is passed as `stack` to `regenerate` in the chat, or `--stack <stack>` on the command line.
- A **slice** is one functional spec on its happy path: what the feature does when the input is right - no validation, no edge cases, no permissions, no persistence unless keeping data is the point. It is hardened later by changing that spec, which turri patches in place.

## Steps

### start

Find out what to build and on which stack, each asked only when the user's message does not say - the stack in exactly one question.

- **What to build.** When the user's message says what kind of software it is - a web app, an API, a CLI - ask nothing: that is enough to start. Otherwise ask one open question with `ask_user` and `free_form: true`: what should it do? Ask no follow-ups. An answer that names only the kind of software is enough too: the first spec is built, and what it does comes later, from the user.
- **The stack named.** When the user's message names the stack - a language, a framework or both: `/spawn a small python fast api server` - take it and ask nothing about technology; what it leaves open, choose yourself within it. Only a named stack in a language the machine lacks is asked about, as below.
- **A stack the project already settled** - its config, its template, its imports - is kept: no question about it either.
- **The stack - exactly one question**, when neither the message nor the project names one. Ask one `ask_user` question about the stack, and no other about technology: the framework, the storage, the libraries, the tests, the layout are yours to choose from the stack picked, as a careful engineer would. The stack has to be one this machine can build: the agents use its toolchains and install none. `<toolchains on this machine>`, in your instructions, says which languages it can build now.
  - **The options**, three or four, each the stack and what it is in a few words: the standard library's stacks for the kind of software it is (the stdlib rule, in `<plain-rules>`), in languages the machine can build now. First the one you would choose, marked `(recommended)`. In the question's `context`, in a line, what you will build first.
  - **A stack the user named in a language the machine lacks** is asked about in the same one question, as an option after the recommended one: `<stack> - once <toolchain> is installed`. Say in the `context` what to install and that `turri doctor` checks it.
  - **The answer is the stack** - an option, or what they typed under "Something else…" - and nothing about it is asked again. A stack in a language the machine lacks: say what to install, that `turri doctor` checks it and that `/spawn` starts again once it is there, and stop - write nothing.

Then say in three lines what you will build first and on which stack, and carry on. Ask for no confirmation, and write nothing to disk in this step.

### skeleton

Set the module up and start the first build - on your own, no questions.

1. **The module and its stack.** Create the `.plain` file (and the template, when it helps), with its frontmatter and a one-sentence product description - from what the user said, and nothing more, and write the stack into `***implementation reqs***`: the language, the framework, storage, the architecture and layout - one requirement per fact, at the right scope, the shared ones on the template. Follow `genome/rules/impl-reqs.md`. When the standard library has a template for the stack, import it and write only what the module needs beyond it.
2. **Unit tests.** A `:UnitTests:` requirement - the framework, and how they are run - unless the imported stack already sets it, and the unit testing script. Keep one turri already finds (named in `config.turri.yaml`, or the one `run_unittests*.sh` in the root or `test_scripts/`); otherwise write `test_scripts/run_unittests_<language>.sh` by following the `implement-unit-testing-script` skill. Never link it from the specs. The script runs the stack's static checks with the unit tests - the formatter in check mode, the linter, the type checker - and they count as the tests do.
3. **Conformance tests: off.** Keep a `conformance-tests:` decision the project's config already holds - `config.turri.yaml`, or the old `config.yaml`. Otherwise write `conformance-tests: false` into `config.turri.yaml`, changing nothing else in it - a project with only a `config.yaml` has it copied to `config.turri.yaml` first, and `config.yaml` is never written - and write no `***test reqs***`, import no standard library conformance template, and write no conformance testing script. Only when the user asked for conformance tests, turn them on instead: `conformance-tests: true`, the `***test reqs***` - `:ConformanceTests:` requirements following `genome/rules/test-reqs.md`, or the stack's standard library conformance template imported when the stack is from it - and `test_scripts/run_conformance_tests_<language>.sh`, by following the `implement-conformance-testing-script` skill, unless turri already finds one.
4. Run `validate` on every module you wrote, and fix what it finds.
5. **The first spec.** Write the module's first functional spec with `change_plain`: the smallest thing that runs and shows something - the server answers one request (`GET /` with the app's name), the command-line tool prints its usage, the page shows the app's name, the library exposes one call with a fixed result. It holds no product logic, so its build only sets the project up and lands fast - and its pulse is not reviewed. Follow `func-specs.md` for its wording, and keep it to that one observable result.

`change_plain` takes a git diff of the `.plain` file(s): `diff --git a/<file> b/<file>`, `--- a/<file>`, `+++ b/<file>`, then the hunks with a few lines of context, paths from the project root. It applies the change and queues its build. Go straight on to the next step - never wait for a build.

### regenerate

Write the first slices of what the user described, each a spec diff, while the first spec builds - on your own, without asking.

**Only what the user described.** Every slice comes from something the user said the software does. When they said only what kind of software it is, write no slice: the step writes nothing, and the handover invites them to say what it should do first.

1. **The main slice.** The one thing the user said the software is for, on its happy path - the half-built main function a developer writes first and runs. Its concepts go into `***definitions***` in the same change, following `definitions.md`; its functional spec follows `func-specs.md`, placed where it fits.
2. **One more slice at most** - the next thing the user described, also on its happy path. Stop there: two slices beyond the first spec. What the user says once they have tried the first ones decides the rest, and slices written far ahead are slices to rework.
3. **Write each with `change_plain`**, one after another - never wait for a build. Never change a `.plain` file in this step by any other means. Correct a change you find wrong once written with a diff and `fixes_earlier`, never by editing the file.

Write no validation, no edge cases and no hardening in this step: they come later, as changes to these specs, once the user has tried the slices.

The step is done once the slices are written - or at once, when the user described no feature. Never stop part-way to ask whether to go on: nobody answers in this step, and the skill ends when your turn does.

End with the handover, in a few short lines, ending on no question:

- what is being built now - the first spec, then each slice - and that each can be tried as it lands: when a pulse lands, the conversation releases it and says where to try it (open this URL, run this command);
- with no feature described: that the user says what it should do first - in their own words, one thing at a time - and each becomes a spec diff. Suggest no feature of your own;
- otherwise, the next slices you would write, in order - the rest of what the user described, on its happy path, then hardening what is there (validation, edge cases, errors) - and that the user says `go on` for the next one, or asks for anything else instead;
- that conformance tests are off unless they were asked for - one line in `config.turri.yaml`, `conformance-tests: true`, with the test reqs and the script added in the conversation.
