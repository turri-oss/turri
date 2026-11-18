---
description: Test plain files - where they live, their two sections, their scenarios, keeping them in step with the functional specs, and writing scenarios when the person asks for tests
---

# Rules for test plain files

A test plain file holds the test scenarios of one functional spec. Conformance scenarios test its expected use; acceptance scenarios, the use that is not expected. The conformance agent writes the conformance and acceptance tests from these scenarios and from nothing else: each scenario becomes at least one test that does what it says, and it invents none. A functional spec whose test plain file is empty is not tested. Always follow these rules when creating or editing one.

## Where it lives
- Every test plain file of a module lives in `tests/<module>/`, with `tests/` beside the module (`test-dir:` in `config.turri.yaml` can name another folder). This is a rule, not a convention: a file's folder matches its `module:`, and a `.plain` file in `tests/` outside a module's folder is an error `turri parse` reports
- Name the file after its functional spec, `tests/<module>/<func-id>.plain`; the name is convention, the frontmatter is what binds it
- A functional spec with no scenarios has no test plain file: it is not tested. Write one only to give a functional spec scenarios, and never an empty one - an empty file is a syntax error, as an empty section is
- With conformance tests on, a functional spec that needs scenarios by the criteria under *When a functional spec needs scenarios* gets its test plain file without the person asking, with the test reqs and conformance testing script it needs - as below
- More than one test plain file may bind to one functional spec: their scenarios are merged, and the scenario-ids must be unique across them. Write one file per functional spec, and keep a person's extra files as they are
- A test plain file is never a module: never import or require one, and never name one where a module is asked for

## File skeleton
- YAML frontmatter, then `***conformance tests***`, then `***acceptance tests***`, each section heading at the start of a line
- A section is there only with at least one scenario under it: a section with none is a syntax error - leave it out. A file with no section at all is one too: a functional spec with no scenarios has no test plain file
- The frontmatter has exactly two keys, both required:
  - `module:` - the module the functional spec is in: its file name without `.plain`
  - `func_id:` - the functional spec's func-id (see `semantic-ids.md`)
- The two must name a functional spec that exists
- No other section: no `***definitions***`, `***implementation reqs***`, `***test reqs***` or `***functional specs***`
- Comment lines starting with `>` are allowed, as in a module

The minimum - one scenario, its section alone:

```plain
---
module: todo
func_id: add-task
---

***conformance tests***

# add-valid-task
Adding a :Task: named "Buy milk" to an empty :TaskList: shows one :Task: named "Buy milk".
```

## Scenarios
- A scenario is a `# <scenario-id>` heading (see `semantic-ids.md`) followed by free text that says what is done and what result is expected
- No line of its body starts with `# ` (that starts the next scenario) or with `***`
- A scenario may use every concept its module sees: its own definitions, its `import` modules' and the `exported_concepts` of its `requires` modules. It defines none
- Scenarios are language-agnostic and black box: they act through the interface the functional spec names - a command line, HTTP, files, a UI - and never name a function, class or file of the code
- A scenario is a direct consequence of its functional spec: it does not contradict, narrow or extend it
- Each scenario states one concrete, checkable outcome; "works correctly" is not an outcome
- Values that matter to the check are concrete (`named "Buy milk"`, `exits with status 0`), never descriptive (`a valid name`)
- Scenario text follows `concise-specs.md`: no narration, no rationale, no step a reader would assume
- `***conformance tests***` holds the expected use: the main path, with valid input, the expected caller and the data present
- `***acceptance tests***` holds the use that is not expected: invalid input, wrong or missing authentication, missing data, a dependency that fails
- The kind of use decides the section, not how many functional specs a scenario touches

## Scenarios across functional specs
- A scenario may use functional specs written before the one it is bound to, for its setup or as steps of a longer path
- It is bound to the last functional spec it exercises, since the earlier ones exist when it runs
- It goes under `***conformance tests***` when every step is expected use, and under `***acceptance tests***` when any step is not; write one only when the person asks for it

## Keeping test plain files in step
Scenarios that exist are kept in step; a change calls for new ones only as *When a functional spec needs scenarios* says. In the same ***plain diff as the change:
- A new functional spec gets no test plain file, unless the person asks for its tests or - conformance tests on - it needs scenarios by the criteria below
- A functional spec whose body changes has its scenarios, if it has any, reviewed: one that no longer follows from it is changed or taken out, and your reply says so
- The last scenario of a section taken out: the section is taken out with it. The last scenario of the file: the file is deleted
- A functional spec split into several: each part gets its own test plain file, and each scenario moves to the part it tests
- A functional spec taken out: its test plain file, if it has one, is deleted
- A functional spec moved to another module: its test plain file moves to that module's folder, with `module:` changed
- A func-id renamed: `func_id:` is renamed in every test plain file bound to it, and the file with it

## When a functional spec needs scenarios
With conformance tests on, judge each functional spec as you write or change it - and one the person asks about. It needs scenarios when you can show, concretely, any of these:
- **It can fail silently:** an incorrect implementation could give output that looks plausible but is wrong - name the input and the wrong output
- **It can be read two ways:** two reasonable readings of its text give different outputs for some input - name the input and the output under each
- **A bug in it is costly:** financial loss, security exposure, data loss, or harm to users' trust - name the consequence

Without that evidence it does not: a functional spec with nothing at stake is left to its unit tests, and you do not write scenarios to be safe. Being likely to change, or to be built on later, is no reason alone - the unit tests guard against regressions. A functional spec that has scenarios already is judged no further: its scenarios are kept in step as above. Say in a line, for each you write scenarios for, which of these it is.

## Writing scenarios
Nothing about testing exists until the person asks for it, or - with conformance tests on - a functional spec needs scenarios by the criteria below: a module imports no conformance template, and its functional specs have no test plain files. With conformance tests off, the person turns them on first, with `/conform` (see `turri-regeneration.md`). The first time the person asks for tests in a module, or one of its functional specs needs scenarios, do three things, in this order, each a visible change - only what is missing:
1. **Test reqs:** import the stack's conformance template, `stdlib/<kind>/conformance/<stack>` (see `stdlib.md`), or write the module's own `***test reqs***` when it has no stack from the standard library (see `test-reqs.md`)
2. **The conformance testing script:** write it with `implement-conformance-testing-script`, if the project has none for the module's stack
3. **The scenarios**, as below

Then, and for every later request:
- Decide in prose which scenarios each functional spec named needs, then write them with the file tools, conformance and acceptance in one change where both were asked for, and call `regenerate` for the module. Ask for no further confirmation: the change is visible, and turri starts the conformance pulses itself
- Write scenarios for the functional specs the person named, and for those that need them by the criteria below. Scenarios in one functional spec imply nothing about another, in the same module or not: the person may test one thoroughly and leave the rest untested
- Write acceptance scenarios only when the person asks for them
- For a functional spec that needs scenarios by the criteria, cover what made it need them: the input an incorrect implementation would get wrong, the input two readings answer differently - settled by the reading most consistent with the functional spec and its module, and say which you took - and its boundary inputs. Leave out an input it does not settle rather than guess at it
- One conformance scenario per expected use the functional spec states: its main path first, then each valid variant it names - another input shape, an optional parameter. Stop when each has one, and never write the same outcome twice in different words
- Write no outcome the functional spec does not state. When a needed one is missing, ask the person, and put the answer in the functional spec first
- A scenario that needs a dependency to fail - a backend that does not answer, a database that is down - is written only when the test reqs let a test cause that failure, with a local mock of it, say; otherwise ask the person whether to add such a test req or leave the scenario out
- The body is one statement line naming the action and its expected result, with concrete values; when that is not enough, `- ` bullets under it, in order: the state before, the one action under test, then each observable result, one fact a bullet
- A framework, a run command or a network policy belongs in `***test reqs***`, never in a scenario

```plain
Functional spec:
# list-resources
:Resource: items are returned sorted by creation date in descending order.

Good - follows from the functional spec:
# newest-first
After three :Resource: items are created one after another, listing them returns the last one created first.

Bad - contradicts it (the functional spec says descending):
# oldest-first
The first :Resource: listed is the oldest.

Bad - extends it (the functional spec says nothing about a limit):
# at-most-fifty
At most 50 :Resource: items are listed.
```

The conformance agent writes exactly the scenarios: each one becomes at least one test, labelled with its scenario-id, and no test is written from the functional spec itself or invented beside them.

## Relation to `***test reqs***`
- The module's `***test reqs***` - its own, or a conformance template's - say how `:ConformanceTests:` and `:AcceptanceTests:` are written and run: framework, command, network policy. The scenarios say what they check
- Test reqs and scenarios reach the conformance agent only, never the coding agent
- A fact about the framework or the run command never goes into a scenario, and a scenario never goes into `***test reqs***`

## Format

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
Adding a :Task: named "Go" to an empty :TaskList: is rejected.
- :App: shows the error "Name must be at least 3 characters".
- :TaskList: stays empty.
```
