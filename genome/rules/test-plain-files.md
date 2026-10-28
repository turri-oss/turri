---
description: Test plain files - where they live, their two sections, their scenarios, keeping them in step with the functional specs, and writing scenarios when the person asks for tests
---

# Rules for test plain files

A test plain file holds the test scenarios of one functional spec. Conformance scenarios test its expected use; acceptance scenarios, the use that is not expected. The conformance agent writes the conformance and acceptance tests from these scenarios and from nothing else: each scenario becomes at least one test that does what it says, and it invents none. A functional spec whose test plain file is empty is not tested. Always follow these rules when creating or editing one.

## Where it lives
- Every test plain file of a module lives in `tests/<module>/`, with `tests/` beside the module (`test-dir:` in `config.turri.yaml` can name another folder). This is a rule, not a convention: a file's folder matches its `module:`, and a `.plain` file in `tests/` outside a module's folder is an error `turri validate` reports
- Name the file after its functional spec, `tests/<module>/<func-id>.plain`; the name is convention, the frontmatter is what binds it
- A functional spec with no scenarios has no test plain file: it is not tested. Write one only to give a functional spec scenarios, and never an empty one - an empty file says no more than none, and is one more file to keep in step
- turri's test advisor may add a test plain file for a new or changed functional spec it judges needs testing, with the test reqs and conformance testing script it needs (see `turri-regeneration.md`). Keep its scenarios in step as any others; a missing file stays preferred to an empty one
- More than one test plain file may bind to one functional spec: their scenarios are merged, and the scenario-ids must be unique across them. Write one file per functional spec, and keep a person's extra files as they are
- A test plain file is never a module: never import or require one, and never name one where a module is asked for

## File skeleton
- YAML frontmatter, then `***conformance tests***`, then `***acceptance tests***`, each section heading at the start of a line
- Both sections are always there, even with nothing under them
- The frontmatter has exactly two keys, both required:
  - `module:` - the module the functional spec is in: its file name without `.plain`
  - `func_id:` - the functional spec's func-id (see `semantic-ids.md`)
- The two must name a functional spec that exists
- No other section: no `***definitions***`, `***implementation reqs***`, `***test reqs***` or `***functional specs***`
- Comment lines starting with `>` are allowed, as in a module

The minimum - the file of a functional spec that is not tested:

```plain
---
module: todo
func_id: add-task
---

***conformance tests***

***acceptance tests***
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
Only scenarios that exist are kept in step: a change to a functional spec never calls for new ones. In the same ***plain diff as the change:
- A new functional spec gets no test plain file, unless the person asks for its tests
- A functional spec whose body changes has its scenarios, if it has any, reviewed: one that no longer follows from it is changed or taken out, and your reply says so
- A functional spec split into several: each part gets its own test plain file, and each scenario moves to the part it tests
- A functional spec taken out: its test plain file, if it has one, is deleted
- A functional spec moved to another module: its test plain file moves to that module's folder, with `module:` changed
- A func-id renamed: `func_id:` is renamed in every test plain file bound to it, and the file with it

## Writing scenarios
Nothing about testing exists until the person asks for it, or turri's test advisor writes it: a module imports no conformance template, and its functional specs have no test plain files. The first time the person asks for tests in a module, do three things, in this order, each a visible change:
1. **Test reqs:** import the stack's conformance template, `stdlib/<kind>/conformance/<stack>` (see `stdlib.md`), or write the module's own `***test reqs***` when it has no stack from the standard library (see `test-reqs.md`)
2. **The conformance testing script:** write it with `implement-conformance-testing-script`, if the project has none for the module's stack
3. **The scenarios**, as below

Then, and for every later request:
- Decide in prose which scenarios each functional spec named needs, then write them with `change_plain`, conformance and acceptance in one change where both were asked for. Ask for no further confirmation: the change is visible, and turri starts the conformance pulses itself
- Write scenarios only for the functional specs the person named. Scenarios in one functional spec imply nothing about another, in the same module or not: the person may test one thoroughly and leave the rest untested
- Write acceptance scenarios only when the person asks for them
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
