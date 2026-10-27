# The \*\*\*plain parser

`src/plain/` is a TypeScript port of the reference [\*\*\*plain](https://plainlang.org/docs/) parser, [plain-parser](https://github.com/plainlang/plain-parser) - `plain_file.py`, `plain_spec.py`, `concept_utils.py`, `graph.py`, and the `loaders.py` helpers they depend on.

## Which commit

The port follows plain-parser **`063c8e0`** (2026-10-13). It was first taken from `bdfd1af` (2026-09-20) and then brought up to `063c8e0`: lookup errors that say only what was not found (`692eaac`), exported concepts checked as each module is parsed (`0abc70d`), the concept graph sorted the way graphlib sorts it and a cycle report capped at `MAX_REPORTED_CYCLES` (`8741e03`, `6934220`), links resolved against the plain file's own folder (`0a1f044`), corrected error spacing and wording (`a275916`), Liquid syntax errors as \*\*\*plain syntax errors (`5d91970`), and the `requires` chain's exports and order (`269be5a`, `f59f51a`, `6917023`, `2cf5298`). The `check` and `parse` command line of `5b3b20c`..`063c8e0` has no counterpart: turri's is `turri validate`.

### Comparison with the Python parser

<!-- COMPARISON RESULTS: to be filled in by a run of both parsers outside this repo, over tests/data and the stdlib templates, at the commit named above. -->

_Not yet run at this commit._ The comparison is run outside this repository - both parsers over the same corpus, their module name, marshalled tree, required modules, functionality ids and each functionality's \*\*\*plain compared - and its results recorded here.

| module | ports |
|---|---|
| `src/plain/parser.ts` | `plain_file.py` - sections, acceptance tests, imports/requires, the `requires` chain (`parseModuleChain`), marshalling |
| `src/plain/spec.ts` | `plain_spec.py` - functionality ids, the per-functionality context, linked resources, ranges |
| `src/plain/concepts.ts` | `concept_utils.py` - concept extraction, validation, topological ordering, the cycle report |
| `src/plain/cycles.ts` | `graph.py` - the cycle search (Johnson's algorithm over Tarjan's components) the cycle report is made from |
| `src/plain/markdown.ts` | mistletoe's AST + `PlainRenderer` (mdast + a matching serializer) |
| `src/plain/liquid.ts` | the reference implementation's Liquid nodes + the two filters in `plain_spec.py` (liquidjs) |
| `src/plain/files.ts` | `loaders.open_from` / `get_loaded_templates` / `liquid_error_message`, base64 blob detection |
| `src/plain/module-concepts.ts`, `src/plain/graph.ts` | nothing - turri's own, for a host: the concepts a module can name and where each is defined, and a project's \*\*\*plain as a graph of modules, items and concepts (see [hosting](hosting.md#plain-for-a-host)). The parser keeps, beside the reference's result, which module each item an import brought is written in (`importedFrom`) |
| `src/plain/stdlib.ts` | nothing - turri's own: `stdlib/` is a reserved import prefix, read from turri's standard library only, and a project module at such a path is an error (see [the standard library](authoring-plain.md#the-standard-library)) |

## Checking \*\*\*plain

```bash
turri validate <file.plain>        # one spec
turri validate .                   # every .plain file in a directory
turri validate <file.plain> --json
```

It uses this repo's own parser, so it needs no external tool, no API key and no credits: it parses the file, resolves its imports and required modules, and reports every syntax, concept and structure error with the line it is on.

```
PASS  d365_export.plain  6 functionalities (1, 2, 3, 4, 5, 6), requires d365_restore_api

FAIL  broken.plain  PlainSyntaxError
        Plain syntax error: Syntax error at line 3: Invalid specification heading
        (`Nope:`). Allowed headings: definitions, implementation reqs, test reqs, ...
```

The exit code is 0 only when every file passed. In a conversation the same check is `validate`.

## Two rules of inheritance

- A module that **`requires`** another inherits its functional specs, transitively: it is built on top of that module's code.
- A module that **`import`s** another inherits its definitions, implementation reqs and test reqs.

## The functional-spec iterator

`getFrids` walks functionalities depth-first through nested sections; `getSpecificationsForFrid` builds what a single functionality is regenerated with. `iterateFunctionalSpecs` pairs them:

```ts
import { plainFileParser, iterateFunctionalSpecs } from "./src/plain/index.ts";

const [moduleName, tree] = plainFileParser("my_app.plain", ["."]);

for (const { frid, specifications, codeVariables } of iterateFunctionalSpecs(tree)) {
  // definitions and reqs in scope from the outside in, every functionality up to and
  // including this one, and only this one's acceptance tests
  console.log(frid, specifications["functional specs"].length);
}
```

## Parsing once

A module's parse reads its imports and the whole of its `requires` chain, so a long chain asks for the same files over and over: bringing an 18-module chain up to its \*\*\*plain parsed for minutes. Two caches keep it to once. Inside `withParseCache`, one question about \*\*\*plain, each file is parsed once. Between calls, a parse is kept with a fingerprint of every file directly in its template folders and the current one - name, size, modification time, and a `.plain` file's text - and handed out again, as a copy, while the fingerprint is the same; \*\*\*plain that does not parse is kept as that too. What a parse returns is unchanged: the cache only decides whether to parse again.

## Fidelity

The port is checked against the Python implementation directly, not only against the ported assertions. Both parsers are run over a corpus and their module name, marshalled tree, required modules, functionality ids and each functionality's \*\*\*plain compared. The last comparison recorded, at `bdfd1af` (see [Which commit](#which-commit) for the one since):

| corpus | files | identical | differences |
|---|---|---|---|
| `tests/data/` fixtures | 84 | 80 | 4 error strings (below) |
| `hycu-dynamics-365-modules` | 47 | 47 | none |

The 4 differences are all the same thing: template partials (`implement.plain`, `implement_2.plain`, `header.plain`, `pr_implement.plain`) are meant to be included with arguments, not parsed alone. Both implementations reject them for the same reason - an undefined Liquid variable - but the message text comes from the template engine, and liquidjs phrases it differently from liquid2.

Real \*\*\*plain exposed three places where mdast and mistletoe disagree, each covered by `tests/plain/renderer.test.ts`:

- **Inline decoding.** mdast resolves `\"` to `"` and forgets whether emphasis was written with `_` or `*`; mistletoe round-trips the source. Inline leaf nodes are pinned back to their original source slice at parse time.
- **List geometry.** mistletoe indents an item's continuation lines by its `prepend`, measured in coordinates with the enclosing item's indentation stripped - not by the column gap between parent and child. An acceptance test rendered detached from its functionality keeps 6 and 10 spaces where the naive reading gives 4 and 8.
- **Lazy continuation lines.** A paragraph's continuation lines carry leading whitespace that is not part of the text; keeping it in the raw slice indents the line twice.

Deliberate differences from the Python source:

- The `test_plainfile.py` tests drive the acceptance-test helpers with `MagicMock` tokens and patch the inner helper to count calls. ESM has no equivalent, so those tests build real ASTs from markdown and assert the same observable outcome.
- graphlib's `TopologicalSorter.static_order` is reimplemented rather than replaced with a generic sort: it hands out each generation of ready nodes in insertion order, so the ordering of independent concepts follows graph insertion order, and the Python tests assert that exact sequence.
- A Liquid syntax error is reported as `Invalid Liquid at <module>:<line>:<column>: <message>`, as the Python parser reports it, but the message is liquidjs's and so is the place: liquidjs points at the token it stopped on, liquid2 sometimes at the next one (`unterminated_output.plain` is `3:21` here, `4:0` there).
- The `requires` walk is turri's: each required module is validated by parsing it in turn, through the parse cache, rather than by `validate_required_modules`. It reports the same first error in the same order - the top module's shape, then its required modules' parse errors, its own concept errors, then its required modules top down - and `parseModuleChain` gives the chain in the same order. `test_each_required_module_is_validated_once_top_down`, which counts calls to the Python function, has no counterpart.
