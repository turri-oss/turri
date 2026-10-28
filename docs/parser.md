# The \*\*\*plain parser

`src/plain/` is a TypeScript port of the reference [\*\*\*plain](https://plainlang.org/docs/) parser, [plain-parser](https://github.com/plainlang/plain-parser) - `plain_file.py`, `plain_spec.py`, `concept_utils.py`, `graph.py`, `test_plain_file.py`, `project.py`, and the `loaders.py` helpers they depend on.

## Which commit

The port follows plain-parser [#15](https://github.com/plainlang/plain-parser/pull/15) ("explicit test scenarios") at **`e0c5f31`** (2026-10-27), its head when the port was last checked; #15 is not merged yet. #15 branches from `063c8e0` (2026-10-13), and the port was brought there first, from `bdfd1af` (2026-09-20), as a step of its own:

- **`bdfd1af`..`063c8e0`:** lookup errors that say only what was not found (`692eaac`), exported concepts checked as each module is parsed (`0abc70d`), the concept graph sorted the way graphlib sorts it and a cycle report capped at `MAX_REPORTED_CYCLES` (`8741e03`, `6934220`), links resolved against the plain file's own folder (`0a1f044`), corrected error spacing and wording (`a275916`), Liquid syntax errors as \*\*\*plain syntax errors (`5d91970`), and the `requires` chain's exports and order (`269be5a`, `f59f51a`, `6917023`, `2cf5298`). The `check` and `parse` command line of `5b3b20c`..`063c8e0` has no counterpart: turri's is `turri validate`.
- **#15, `37e0b35`..`f1ac046`:** a functional spec is a `# <func-id>` heading with a free-text body; func-ids and scenario-ids are semantic ids (`SEMANTIC_ID_PATTERN`); `- ` bullets and `***acceptance tests***` in a module are the previous syntax, and are errors; conformance and acceptance scenarios live in test plain files, bound to a functional spec by their `module:` and `func_id:`; and with `require_test_plain_files` every functional spec of the chain needs a test plain file, which may hold no scenario (`f1ac046`).
- **#15, `e0c5f31`:** the parser has no default test directory - test plain files are read only from the directories it is given. Its command line's side of it, a usage error for a `conformance-tests-script` with no `test-dir`, has no counterpart in turri, whose `test-dir` is `tests` unless the config says otherwise (see [the config](config.md)); the parser here, like #15's, reads test plain files only when `ParseOptions.testDir` is given. Its fixture `cli/project/config.yaml` gains `test-dir: tests`.

### Comparison with the Python parser

<!-- COMPARISON RESULTS: to be filled in by a run of both parsers outside this repo, at e0c5f31 (and at 063c8e0 for the catch-up), over tests/data - #15's fixtures with testplainfile/ and cli/project/, and partial_rendering/ - the six body cases in tests/plain/renderer.test.ts, and the stdlib templates. -->

_Not yet run at these commits._ The comparison is run outside this repository - both parsers over the same corpus, their module name, marshalled tree (format version 2, with `test_plain_files`), required modules, func-ids and each functional spec's \*\*\*plain compared - and its results are recorded here. Its corpus is `tests/data` (#15's fixtures, with `testplainfile/` and `cli/project/`, and turri's own `partial_rendering/`), the six body cases of `tests/plain/renderer.test.ts` - whose expected values were read from mistletoe's renderer, not taken from a run - and the `stdlib/` templates.

| module | ports |
|---|---|
| `src/plain/parser.ts` | `plain_file.py` - sections and functional specs (`readSections`), imports/requires, the `requires` chain (`parseModuleChain`), marshalling |
| `src/plain/spec.ts` | `plain_spec.py` - func-ids, the per-functional-spec context with its scenarios, linked resources, ranges |
| `src/plain/test-plain-file.ts` | `test_plain_file.py` - a test plain file: its binding, its two sections and their scenarios |
| `src/plain/project.ts` | `project.py` - finding test plain files, binding them to the chain, and the completeness check |
| `src/plain/concepts.ts` | `concept_utils.py` - concept extraction, validation, topological ordering, the cycle report |
| `src/plain/cycles.ts` | `graph.py` - the cycle search (Johnson's algorithm over Tarjan's components) the cycle report is made from |
| `src/plain/markdown.ts` | mistletoe's AST + `PlainRenderer` (mdast + a matching serializer) |
| `src/plain/liquid.ts` | the reference implementation's Liquid nodes + the two filters in `plain_spec.py` (liquidjs) |
| `src/plain/files.ts` | `loaders.open_from` / `get_loaded_templates` / `liquid_error_message` / `relative_resource_path`, base64 blob detection |
| `src/plain/module-concepts.ts`, `src/plain/graph.ts` | nothing - turri's own, for a host: the concepts a module can name and where each is defined, and a project's \*\*\*plain as a graph of modules, items and concepts (see [hosting](hosting.md#plain-for-a-host)). The parser keeps, beside the reference's result, which module each item an import brought is written in (`importedFrom`) |
| `src/plain/stdlib.ts` | nothing - turri's own: `stdlib/` is a reserved import prefix, read from turri's standard library only, and a project module at such a path is an error (see [the standard library](authoring-plain.md#the-standard-library)) |

The ported functions keep the reference's names where it keeps them: `getFrids`, `getSpecificationsForFrid`, `getFridsRange` - a frid there is a functional spec's func-id.

## Test plain files

A functional spec's conformance and acceptance scenarios are in its **test plain file**, `tests/<module>/<func-id>.plain` by convention (the folder is turri's rule, the file's name is free):

```
---
module: todo
func_id: add-task
---

***conformance tests***

# add-first-task
Running `todo add Buy milk` on an empty list prints `Added task 1: Buy milk`.

***acceptance tests***

# add-then-list
Running `todo add Buy milk` and then `todo list` prints `1 Buy milk`.
```

Both sections are always there; either may be empty. turri hands the reference one test folder per module of the chain - `<test-dir>/<module>` for each, `test-dir` from [the config](config.md) - so a test plain file may bind to any module of the chain (`plainFileParser`'s `testDir`). Its scenarios ride on the functional spec it binds to, in the item's `conformance_tests` and `acceptance_tests` - `{id, text, linked_resources}` each - and the tree's `test plain files` names each file, relative to the module's folder, with the functional spec it binds to.

**Completeness.** turri never asks the reference's completeness check (`require_test_plain_files`), which wants a test plain file for every functional spec of the chain whenever the project names a conformance testing script. In turri a functional spec with no test plain file is not tested, as one whose file is empty - and no file is the way to say so. `parseProject` keeps the reference's switch. A module parsed without its test folder - the parser's own tests, a fixture - binds nothing and checks nothing.

## Checking \*\*\*plain

```bash
turri validate <file.plain>        # one module
turri validate .                   # every .plain module in a directory
turri validate <file.plain> --json
```

It uses this repo's own parser, so it needs no external tool, no API key and no credits: it parses each module with its test plain files, resolves its imports and required modules, and reports every syntax, concept and structure error with the line it is on. A module that passes lists each functional spec with its test plain file and its scenarios - and, where they have scenarios but the module has no test reqs, or no conformance testing script for its stack, a `WARN` line naming the next step ([the steps of adding tests](regenerating.md#the-steps-of-adding-tests)): a warning, never a failure:

```
PASS  todo.plain  3 functional specs, requires base
        add-task     tests/todo/add-task.plain     2 conformance, 1 acceptance
        list-tasks   tests/todo/list-tasks.plain   1 conformance
        delete-task  tests/todo/delete-task.plain  no scenarios - not tested

FAIL  broken.plain  PlainSyntaxError
        Plain syntax error: Syntax error at line 3 in module 'broken': Invalid specification heading
        (`Nope:`). Allowed headings: definitions, implementation reqs, test reqs, functional specs
```

The parser's errors come one at a time, the first it meets, word for word as the reference gives them; for one the previous syntax makes - bullets as functional specs, acceptance tests in a module - turri adds its next step under it: ask it to convert the module, which it does one module at a time, asking before it writes anything. turri's own checks list everything they find at once: every functional spec of the chain without a test plain file (`list-tasks - add tests/todo/list-tasks.plain`), and - every run, of a file or a folder, checks its project's test folder - every test plain file that is not where it belongs, saying where it does:

```
FAIL  tests/  2 test plain files outside a module's folder
        tests/add-task.plain - move it to tests/todo/ (its module: todo)
        tests/todos/x.plain - no module todos; module: todo is in tests/todo/
```

A test plain file, or a test folder, is never taken for a module: `validate` - and `regenerate`, `conform`, `glimpse`, `drift`, `release`, `/regenerate` and the commands - refuse one, naming its module (`\`tests/todo/add-task.plain\` is a test plain file of \`todo\`; name \`todo.plain\`, or \`todo:add-task\` for that one functional spec`).

The exit code is 0 only when every file passed. In a conversation the same check is `validate`; `change_plain` and `turri change-plain` run it on what a change touched - each module, an import module as the modules that import it, a test plain file as its module - and a change that does not pass is rolled back, a test plain file written outside its module's folder with it.

## Two rules of inheritance

- A module that **`requires`** another inherits its functional specs, transitively: it is built on top of that module's code.
- A module that **`import`s** another inherits its definitions, implementation reqs and test reqs.

## The functional-spec iterator

`getFrids` walks the functional specs in file order, by func-id; `getSpecificationsForFrid` builds what a single functional spec is regenerated with. `iterateFunctionalSpecs` pairs them:

```ts
import { plainFileParser, iterateFunctionalSpecs } from "./src/plain/index.ts";

const [moduleName, tree] = plainFileParser("my_app.plain", ["."], { testDir: "tests" });

for (const { funcId, specifications, codeVariables } of iterateFunctionalSpecs(tree)) {
  // definitions and reqs in scope, every functional spec up to and including this one,
  // and only this one's conformance and acceptance scenarios
  console.log(funcId, specifications["functional specs"].length, specifications.conformance_tests.length);
}
```

## Parsing once

A module's parse reads its imports and the whole of its `requires` chain, so a long chain asks for the same files over and over: bringing an 18-module chain up to its \*\*\*plain parsed for minutes. Two caches keep it to once. Inside `withParseCache`, one question about \*\*\*plain, each file is parsed once. Between calls, a parse is kept with a fingerprint of every file directly in its template folders and the current one - name, size, modification time, and a `.plain` file's text - and of every `.plain` file under the test folder, by name and text, and handed out again, as a copy, while the fingerprint is the same; \*\*\*plain that does not parse is kept as that too. A scenario written, changed or removed is seen at once. What a parse returns is unchanged: the cache only decides whether to parse again.

## Fidelity

The port is checked against the Python implementation directly, not only against the ported assertions. Both parsers are run over a corpus and their module name, marshalled tree, required modules, func-ids and each functional spec's \*\*\*plain compared. The last comparison recorded, at `bdfd1af` (see [Which commit](#which-commit) for the ones since):

| corpus | files | identical | differences |
|---|---|---|---|
| `tests/data/` fixtures | 84 | 80 | 4 error strings (below) |
| `hycu-dynamics-365-modules` | 47 | 47 | none |

The 4 differences are all the same thing: template partials (`implement.plain`, `implement_2.plain`, `header.plain`, `pr_implement.plain`) are meant to be included with arguments, not parsed alone. Both implementations reject them for the same reason - an undefined Liquid variable - but the message text comes from the template engine, and liquidjs phrases it differently from liquid2. `hycu-dynamics-365-modules` is in the previous syntax and is no longer a corpus; the `stdlib/` templates are its real-world replacement.

Real \*\*\*plain exposed places where mdast and mistletoe disagree, each covered by `tests/plain/renderer.test.ts`:

- **Inline decoding.** mdast resolves `\"` to `"` and forgets whether emphasis was written with `_` or `*`; mistletoe round-trips the source. Inline leaf nodes are pinned back to their original source slice at parse time.
- **List geometry.** mistletoe indents an item's continuation lines by its `prepend`, measured in coordinates with the enclosing item's indentation stripped - not by the column gap between parent and child. A nested item keeps the indentation of the coordinates it was parsed in.
- **Lazy continuation lines.** A paragraph's continuation lines carry leading whitespace that is not part of the text; keeping it in the raw slice indents the line twice.
- **Blank lines.** The reference parses inside its renderer's context, so every blank line is a `BlankLine` token and is rendered back. mdast has none: each block keeps the blank lines before it from the source, those around a dropped comment included. A list item that ends without a next item gives back only the last of the blank lines after it (`ListItem.read` steps back one line), so the run right after a list counts once.
- **Free-text bodies.** A fence keeps its delimiter, info string and indentation; an indented code block its four spaces; a thematic break its line as written; a setext heading its underline. A table is parsed as GFM's (`micromark-extension-gfm-table`) and re-rendered as mistletoe renders one: every column as wide as its widest cell and at least three, the separator row rebuilt from the alignments.

Deliberate differences from the Python source:

- graphlib's `TopologicalSorter.static_order` is reimplemented rather than replaced with a generic sort: it hands out each generation of ready nodes in insertion order, so the ordering of independent concepts follows graph insertion order, and the Python tests assert that exact sequence.
- A Liquid syntax error is reported as `Invalid Liquid at <module>:<line>:<column>: <message>`, as the Python parser reports it, but the message is liquidjs's and so is the place: liquidjs points at the token it stopped on, liquid2 sometimes at the next one (`unterminated_output.plain` is `4:19` here, `5:0` there).
- The `requires` walk is turri's: each required module is validated by parsing it in turn, through the parse cache, rather than by `validate_required_modules`. It reports the same first error in the same order - the top module's shape, then its required modules' parse errors, its own concept errors, then its required modules top down - and `parseModuleChain` gives the chain in the same order. `test_each_required_module_is_validated_once_top_down`, which counts calls to the Python function, has no counterpart.
- mistletoe's table splits a row on every unescaped `|` and drops empty cells; GFM keeps an empty cell, and lets a table go on over a row with no `|`. Tables that differ there are not in the corpus.
