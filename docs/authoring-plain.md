# Authoring \*\*\*plain

turri builds code from [\*\*\*plain](https://plainlang.org/docs/) - its documentation is the language's whole reference. Regenerating turns \*\*\*plain into code; authoring is the half that decides what gets built. The code is only ever as good as the \*\*\*plain description - a fact in the wrong section is silently ignored, a functional spec that is too big comes out half-built, two functional specs that contradict each other break each other's tests. So this repo carries as much for writing \*\*\*plain as for regenerating it: the authoring rules, a library of skills that apply them, and independent review of what they write.

The rule underneath all of it: **\*\*\*plain is the source of truth**. The generated code in `plain_modules/` is never edited by hand. A bug is fixed in \*\*\*plain, and a change that is wanted goes into \*\*\*plain - that is what persists and what the next regeneration builds from.

## A \*\*\*plain project

```
my-project/
  app.plain            # a root module: what the software does
  users.plain          # another module, perhaps one that `requires` app
  template/            # import modules: shared definitions and reqs
  tests/               # test plain files: tests/<module>/<func-id>.plain, one a functional spec
  resources/           # files specs link to: schemas, API specs, sample data
  test_scripts/        # scripts that run the unit and conformance tests
  plain_modules/       # generated - code, tests, history; never edited by hand
```

## What \*\*\*plain is made of

A `.plain` file is one module: optional YAML frontmatter, then up to four sections, in this order.

| section | holds | e.g. |
| --- | --- | --- |
| `***definitions***` | the concepts, written `:CamelCase:` - every concept is defined before it is used | `- :Task: is a unit of work with a title and a due date.` |
| `***implementation reqs***` | HOW it is built: stack, architecture, coding standards, and everything about unit tests | `- :Implementation: is written in Python 3.12.` |
| `***test reqs***` | everything about the black-box conformance tests: framework, how they run, mocking | `- :ConformanceTests: use pytest and call the CLI as a subprocess.` |
| `***functional specs***` | WHAT it does - observable, language-agnostic behaviour, one functionality under each `# <func-id>` heading, in the order they are built | `# add-task` over `A :User: can add a :Task:.` |

A functional spec is a `# <func-id>` heading - lowercase letters and digits in words joined by `-`, unique in its module - and its text under it, as free markdown: paragraphs, lists, code blocks. Each has a test plain file, `tests/<module>/<func-id>.plain` (the folder is `test-dir`), with `module:` and `func_id:` in its frontmatter, then `***conformance tests***` and `***acceptance tests***`, each scenario a `# <scenario-id>` heading and its text. A test plain file with no scenario in it says the functional spec is not tested yet; one is still needed. People and turri name a functional spec `<module>:<func-id>` - `todo:add-task`.

The frontmatter connects modules:

| field | |
| --- | --- |
| `description` | one line on what the module is |
| `import` | take the definitions, implementation reqs and test reqs of an import module - shared content, no functional specs of its own |
| `requires` | build on top of another module: its functional specs and its generated code come first |
| `exported_concepts` | which concepts a module that `requires` this one may use |
| `required_concepts` | concepts an import module expects the importing module to define |

Beyond that: \*\*\*plain links to files under `resources/` with markdown link syntax, and the file's contents go to the coding agents with the \*\*\*plain description; lines starting with `>` are comments for people; and files are processed with Liquid first, so a template can be included with parameters.

**Section ownership is the rule that bites.** turri reads each kind of fact only from the section that owns it. A tech choice written into a functional spec, or a behaviour written into the implementation reqs, is not flagged - it is simply not read.

## Tests, when they are asked for

A test plain file holds the scenarios of one functional spec: `***conformance tests***` for its expected use - the main path, with valid input and the data there - and `***acceptance tests***` for the use that is not expected - invalid input, missing authentication, missing data. Scenarios alone decide what is tested: the conformance agent writes at least one test for each, labelled with its scenario-id, and none of its own. A functional spec whose test plain file is empty is not tested.

```plain
---
module: todo
func_id: add-task
---

***conformance tests***

# add-valid-task
Adding a :Task: named "Buy milk" to an empty :TaskList: shows one :Task: named "Buy milk".

***acceptance tests***

# reject-short-name
Adding a :Task: named "Go" is rejected with the error "Name must be at least 3 characters".
```

Nothing about testing is written until the person asks for it: a module imports its stack alone, and a new functional spec gets its test plain file empty, in the same \*\*\*plain diff. The first time the person asks for tests in a module, turri does three things, in this order, each a change they see:

1. **The test reqs** - the stack's conformance template, `stdlib/<kind>/conformance/<stack>`, or the module's own `***test reqs***` when it has no stack from the standard library.
2. **The conformance testing script** - with `implement-conformance-testing-script`, when the project has none for the module's stack.
3. **The scenarios** - for the functional specs the person named, conformance scenarios and, only when asked for, acceptance scenarios, written with `change_plain` with no further confirmation. Scenarios in one functional spec say nothing about another: the rest stay untested until they are asked for too.

Scenarios that exist are kept in step with their functional specs: a functional spec changed has its scenarios reviewed in the same \*\*\*plain diff, and one split, moved, renamed or taken out takes its test plain file with it. The rules are in `test-plain-files.md`.

## The standard library

turri ships a standard library of import modules in `stdlib/` that settle everything about a generic piece of software on one stack except what it does: its language and framework, layout, configuration, error handling, logging, shutdown, and how it is unit and conformance tested. A module's \*\*\*plain imports one and writes only its own concepts and functional specs:

```plain
---
import:
  - stdlib/backend/python-flask
---

***functional specs***

# <func-id>
...
```

| kind | stacks - each with `stdlib/<kind>/conformance/<stack>` beside it |
| --- | --- |
| `stdlib/backend/` | `python-fastapi`, `python-flask`, `python-django`, `typescript-express`, `typescript-fastify`, `typescript-nestjs`, `java-springboot`, `go-nethttp`, `go-gin`, `rust-axum` |
| `stdlib/frontend/` | `react-vite`, `vue-vite`, `sveltekit-spa`, `angular` |
| `stdlib/cli/` | `python-typer`, `python-click`, `python-argparse`, `typescript-commander`, `go-cobra`, `go-flag`, `rust-clap`, `java-picocli` |
| `stdlib/library/` | `python`, `typescript`, `java-maven`, `java-gradle`, `go`, `rust` |

It is built in three layers, and a stack imports the other two:

- **The language** - `stdlib/lang/python`, `typescript`, `java`, `go`, `rust`: the version, the dependency manager, formatting, linting and type checking (ruff and mypy for Python; Prettier, ESLint and `tsc --noEmit` for TypeScript), how a failure is reported (an exception, a returned error, a `Result`), the logging library, and the unit test framework and layout. A module on a stack the library does not have can import its language alone. The formatter, linter and type checker a language names are enforced by the testing scripts, which run them with the tests - the unit testing script on the code, the conformance testing script on the tests - and count them as the tests (see [the static checks](regenerating.md#the-static-checks)).
- **The kind's `common`** - what every stack of a kind shares:

  | kind | settles |
  | --- | --- |
  | backend | settings from the environment into one typed object, checked at start (exit 1 when one is missing); handler, service and repository layers; domain errors turned in one place into `{"error": {"code", "message"}}` - `not_found` 404, `conflict` 409, `validation_error` 422 with `details` per field, `unauthenticated` 401, `forbidden` 403, `internal_error` 500 with no message and the stack trace logged; JSON logs on standard output with `timestamp`, `level`, `logger`, `message` and `request_id`, level from `LOG_LEVEL`, one line per request, never a secret or a body; `X-Request-ID` taken or made and sent back; shutdown on SIGTERM within 10 seconds |
  | frontend | one API layer that turns a failed call into an `ApiError` with the backend's error code, or `network_error`; errors shown in place, and a page for anything else at the root; one logger module, no `console` elsewhere; accessible roles and test ids |
  | cli | settings from flags, then `<TOOL>_<SETTING>`, then defaults; the work apart from parsing; errors as `Error: <message>` on standard error, exit 0, 1, 2 for a usage error, 130 on Ctrl-C, a stack trace only with `--debug`; logs on standard error, warnings by default, `--verbose`, `--debug` |
  | library | one public entry point; one base error type, with a dependency's errors wrapped; logs through the language's logging with no output set up; no environment variables, output or global state |

- **The stack** - the framework and how it does each of those: for `python-flask`, an application factory, one Blueprint per resource, Pydantic for bodies, `@app.errorhandler` for the error body, structlog JSON logs with the request id bound in a hook, Gunicorn. For `go-cobra`, `RunE` commands with Cobra's own error printing off, so `main` alone writes the error and picks the exit code, and slog on standard error.

Each conformance template imports its kind's `conformance/common`: a backend's tests start the built service on a free port and reach it over HTTP only, checking a failure by status and `error.code`; a frontend's run the served build in Chromium through Playwright with the backend stood in; a command-line tool's run the built tool as a process; a library's go through its public entry point.

- **Conformance tests apart.** A module imports its stack alone. The stack's conformance template is its test reqs: it is imported the first time the person asks for tests in the module, before the conformance testing script and the scenarios (see [tests](#tests-when-they-are-asked-for)).
- **A reserved name.** An import that starts with `stdlib/` is always turri's template, never a file of the project's. A project with a module at such a path - `stdlib/backend/python-fastapi.plain` beside the project's \*\*\*plain, in its `template/` folder or in `PLAIN_TEMPLATE_DIRS` - gets an error saying the name is reserved, so which one the project's \*\*\*plain builds on never depends on what is on disk beside it.
- **No concepts.** Its requirements are on the predefined `:Implementation:`, `:UnitTests:` and `:ConformanceTests:` only, so it never collides with \*\*\*plain's own definitions.
- **Pinned to a toolchain.** It names its stack's toolchain - Python 3.12, Node.js 24, Java 21, Go 1.25, Rust - which the agents use from this machine; `turri doctor` says when the machine lacks it.
- **Not storage, not the testing scripts.** A module with a database says which on top of its stack. It still needs its unit testing script, and a conformance testing script once its first tests are asked for.
- **Known to the agents.** The `stdlib` rule, in the system prompt of every agent that writes \*\*\*plain, says when to import which, and lists every template with what it is and the folder it is in, read from `stdlib/` when the rules load. The conversation imports a stack when the one chosen is in it, and its conformance template once the person asks for tests.
- **Only what this machine can build.** The agents use this machine's toolchains and install none, so a Go stack on a laptop without Go stops at its first build. Every agent that writes \*\*\*plain, and the conversation, are told which of the standard library's languages the machine can build now - Python needs `uv`, TypeScript and every frontend `node` and `npm`, Go `go`, Rust `cargo`, Java a JDK (`src/stack.ts`, `toolchainsBlock`) - and the conversation offers, and chooses, only stacks in those. A stack the person names in a language the machine lacks is not refused: they are told what to install first, and that `turri doctor` checks it.

A requirement beyond the stack - storage, an outside service - is added on top of it. A module that differs from its stack on something the stack settles - another framework, another layout - writes its own instead: an import cannot be taken back in part.

## The rules

`genome/rules/` holds the authoring rules. They are in the system prompt of every agent that writes \*\*\*plain - the conversation, the interview skills, the reviewers - so they are not something an agent has to decide to go and read.

| rule | covers |
| --- | --- |
| `module-structure.md` | the file skeleton, frontmatter fields, section order, module kinds, section ownership |
| `definitions.md` | concept syntax, predefined concepts, define before use, no circular definitions, granularity |
| `func-specs.md` | a functional spec's shape - a `# <func-id>` heading and a free-text body - voice, the complexity limit, chronological order, no conflicts, how a functional spec is added - checked for size and conflicts before it is written in, with its test plain file - and where it goes, language agnosticism, testability |
| `semantic-ids.md` | func-ids and scenario-ids: their syntax, unique in the module or the functional spec, a pure rename cheap and a rename with any other change a functional spec taken out and another added, a functional spec named `<module>:<func-id>` |
| `test-plain-files.md` | test plain files in `tests/<module>/`, their two sections and their scenarios, keeping them in step with the functional specs, and writing scenarios once the person asks for tests - test reqs, the conformance testing script, then the scenarios |
| `impl-reqs.md` | HOW not WHAT, unit tests live here, what belongs and what does not |
| `test-reqs.md` | conformance tests only, what belongs, test types |
| `concise-specs.md` (+ two example banks) | keeping \*\*\*plain short enough for a person to review: no obvious lines, plain words, no uncheckable adjectives, no hedging |
| `bullet-continuation.md` | bullets and continuation lines in the definitions, implementation reqs and test reqs |
| `linked-resources.md` | a linked resource is one text file on disk, or a PNG or JPEG image for a model that reads images; protocol artifacts are linked, never transcribed |
| `import-modules.md`, `requires-modules.md` | the two ways modules build on each other |
| `exported-concepts.md`, `required-concepts.md` | which concepts cross module boundaries |
| `integrations.md` (+ standalone, embedded, embedded testing) | \*\*\*plain for REST API integrations, deployed standalone or embedded in an existing codebase |
| `turri-regeneration.md` | turri's model of itself: a \*\*\*plain change regenerated as a \*\*\*plain diff, wherever it sits, in the chain's tip; what each kind of change sets off; what a coding agent sees; how bad code is fixed; where the cost is - so \*\*\*plain is placed by what it means, never to spare regeneration |
| `stdlib.md` | the standard library: when to import which template, and every template with what it is and where it is, read from `stdlib/` |

The ones that shape \*\*\*plain most:

- **One functional spec is at most ~200 lines of code.** A bigger one is split before it is written (`break-down-func-spec`) - the author judges its size by the signs in `func-specs.md`.
- **Functional specs are in build order.** Each is regenerated on top of the ones before it - which is what a functional spec may assume, not what a change costs: a functional spec inserted anywhere is regenerated alone.
- **They state facts, with a concrete subject.** "A :User: can add a :Task:" - not "Implement adding tasks", not "The system should…".
- **Nothing a test cannot check.** No `robust`, `seamless`, `as appropriate`; state the checkable fact or cut the word.
- **No two functional specs contradict each other.** A conflict is found and resolved when a functional spec is added, not when its tests fail.

## Writing \*\*\*plain with turri

In a conversation (`turri`), say what you want and the matching skill runs, or the conversation writes it itself. Asked for new software - `create a small server in Java Spring Boot` - turri starts the project in the conversation, writing the module, its config and its unit testing script, then the smallest thing that runs, regenerated at once, and the first slices of what you described (see [using turri](using.md)). Every change after - a feature, a rule, a fix - is \*\*\*plain it writes and regenerates.

## The skills

Every skill in `genome/skills/` can be run from a conversation; most are also used by the bigger ones. A project's own, in `.turri/skills/` or `.agents/skills/`, can be too (see [skills and gates](skills-and-gates.md#a-projects-own-skills)).

| to… | skills |
| --- | --- |
| start a project | ask, in the conversation: turri writes it itself, with no skill |
| add to \*\*\*plain | ask in the conversation: it writes a concept, a functional spec with its empty test plain file, a req or a linked resource itself, by the rules in its prompt, as a \*\*\*plain diff - and, once you ask for tests, the scenarios (see [tests](#tests-when-they-are-asked-for)) |
| check what is written | `analyze-2-func-specs`, `analyze-func-specs`, `resolve-section-ownership` |
| fix what is written | `break-down-func-spec`, `resolve-spec-conflict`, `debug-specs` |
| restructure modules | `refactor-module`, `consolidate-concepts` |
| move a module from the old syntax | `convert-old-syntax` - one module at a time, the lowest of its chain first: it proposes the func-ids and scenario-ids, and once the person confirms them writes the module and its test plain files in one \*\*\*plain diff, word for word, then validates it; it regenerates nothing |
| set up the project to build | `implement-unit-testing-script`, `implement-conformance-testing-script` |

`debug-specs` is the one for a running application that misbehaves: it reads the generated code to find the cause, traces it back to \*\*\*plain, and fixes only the `.plain` files.

## Checking \*\*\*plain

```bash
turri validate app.plain     # or validate in a conversation
```

It parses \*\*\*plain with this repo's own parser - each module with its test plain files - resolves its imports and required modules, and reports every syntax, concept and structure error with its line, every functional spec without a test plain file, and every test plain file outside its module's folder - no model, no API key. The interview skills run it before a phase ends, and `change_plain` refuses a change that leaves a file that does not pass. Pass the project directory to check every module at once.

What `check` cannot see - a fact in the wrong section, a functional spec that is too big, two that conflict, wording no test can check - is what the rules, the skills and the reviewers are for.
