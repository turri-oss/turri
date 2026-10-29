---
name: write-test-scenarios
description: >-
  Write the conformance and acceptance scenarios of one functional spec from
  the test advisor's report - the inputs to cover, each agreed with its output
  or split between readings - into its test plain file, settling each split by
  the reading most consistent with the functional spec, its module and the
  project, and saying why. turri's test advisor runs it in the background on a
  functional spec it judged to need testing; run it in the foreground only when
  the person asks for this skill by name. When the person asks for scenarios,
  write them yourself instead, as the rules say.
allowed-tools: [read, write, edit, ls, grep, find, validate]
metadata:
  gates:
    - after: write-test-scenarios
      review:
        rubric: ./references/rubric.md
        judges: 1
        quorum: all
        on_fail: retry
        max_retries: 2
        judge_tools: [read, ls, grep, find]
---

# Write Test Scenarios

Writes the scenarios of one functional spec, from a report that says why it needs testing and which inputs to cover. Nobody is asked anything: what the report leaves open, you decide.

## What you are given

What you were told before this step names:
- **The functional spec**, as `module:func-id`, and its module's `.plain` file
- **Its test plain file**, `tests/<module>/<func-id>.plain` (or under the project's `test-dir:`): the one file you write
- **The report**: the questions that were a yes, each with its evidence, and the inputs to cover - each either *agreed*, with the output every reader predicted, or *split*, with the readings a reasonable person could hold
- **turri's earlier scenarios**, when there are any: scenarios turri wrote for an earlier text of this functional spec, still as it wrote them - replace or drop them freely. Every other scenario in the file is the person's: never change, move or drop one

Read the module and the files it links before writing. A scenario may use every concept the module sees - its own definitions, its imports' and the `exported_concepts` of the modules it requires - and defines none.

## Settling a split input

For each split input, pick the reading most consistent with the functional spec's words, the rest of its module, and the project's conventions - its other functional specs, its definitions, what its `AGENTS.md` says. Never the reading that narrows or extends the functional spec when another follows from it. Write down which reading you took and why, in a sentence, for the record. If the code is built the other way, the conformance pulse fixes the code.

## Writing the file

Follow `test-plain-files.md` to the letter:
- The file: frontmatter `module:` and `func_id:`, then `***conformance tests***`, then `***acceptance tests***`, each heading at the start of a line
- **One scenario per input of the report** - every input covered, by a scenario of its own or, where two inputs are the same expected use, by one that names both. No scenario for an input the report does not give
- **Leave out an input that is not this functional spec's** - one that exercises another functional spec of the module, or that this one says nothing about: a scenario on it would test what this functional spec does not say. Say which, and why
- An agreed input: its scenario expects the readers' output, as it is
- A split input: its scenario expects the reading you took
- Expected use goes under `***conformance tests***`, the use that is not expected - invalid input, missing data, a limit passed - under `***acceptance tests***`
- Each scenario is a `# <scenario-id>` heading - short kebab-case from what it checks, unique in the file - and one statement line naming the action and its expected result, with concrete values - never a placeholder such as `<name>`; `- ` bullets under it only when one line is not enough
- Black box: act through the interface the functional spec names, and never name a function, class or file of the code
- A scenario never contradicts, narrows or extends the functional spec

Change no other file: not the module, not another test plain file, not a script.

Run `validate` on the module, and fix what it reports in the file you wrote until it passes.

When you are done, call `write_artifact` with the record the review is checked against, in this order:
1. The test plain file's path
2. The report, word for word as you were given it: the questions with their evidence, and every input, agreed with its output or split with its readings
3. For every split input, the reading you took and why
4. Every input you left out, and why it is not this functional spec's
5. For every scenario, its scenario-id and the input it covers
6. What `validate` said, last
