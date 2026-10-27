---
description: Rules for writing ***test reqs*** sections in .plain files
---

# Rules for writing `***test reqs***`

When writing or editing a `***test reqs***` section in a `.plain` file, always follow these rules:

## Conformance tests only
- Test reqs specify how **conformance tests** should be written and run
- Unit test guidance goes in `***implementation reqs***`, not here
- Test scenarios, conformance and acceptance, live in test plain files, not here - see `test-plain-files.md`
- Behavioral requirements go in `***functional specs***`, not here

## `:ConformanceTests:` lives here (hard rule)
- **Everything** about `:ConformanceTests:` goes in `***test reqs***` — paths, approach, packages, framework, execution command, mocking / network policy, fixtures, pass criteria, environment prerequisites
- `:ConformanceTests:` live outside the generated codebase, in one folder, `plain_modules/<module>/tests/` - the module's whole conformance suite, so requirements that shape them belong in test reqs by definition
- The conformance agent reads how to write and run the tests **only** from `***test reqs***` — anything about `:ConformanceTests:` placed elsewhere (e.g. `***implementation reqs***`) is silently ignored
- Phrase each `:ConformanceTests:` requirement in terms of `:ConformanceTests:` so the partition stays visible at a glance
- Do not link the conformance testing script here (or anywhere in the ***plain; a link to it is ignored). turri finds it in the project root - `conformance-tests-script:` in `config.turri.yaml`, else the one `run_conformance_tests*.sh` in the root, else the one in `test_scripts/` - and shows it to the agents that write the conformance tests itself. Describe the framework and execution command here in words

## What belongs here
- Test framework: which framework to use (e.g., pytest, Unittest, xUnit)
- Execution method: the command to run the tests
- Testing constraints: what must or must not be done in tests (e.g., no skipping, mock requirements)
- Test data: how test fixtures or mock data should be structured
- Environment setup: any prerequisites for running conformance tests

## Test type reference

| Test type | Where to specify | Written from | Purpose |
|-----------|-----------------|--------------|---------|
| Unit tests | `***implementation reqs***` | the functional specs, by the coding agent with the code | Test each functional spec's code in isolation |
| Conformance tests | how: `***test reqs***`; what: `***conformance tests***` of the functional spec's test plain file | exactly its conformance scenarios, by the conformance agent - at least one test each, none invented | Verify the expected use of one functional spec, its main path |
| Acceptance tests | how: `***test reqs***`; what: `***acceptance tests***` of the functional spec's test plain file | exactly its acceptance scenarios, the same way | Verify one functional spec under use that is not expected: invalid input, wrong or missing authentication, missing data |

## No duplication
- Do not duplicate guidance already present in the file or its imports
- Check imported modules before adding a new test req

## Concept references
- Reference predefined concepts like `:ConformanceTests:` where appropriate
- All other referenced `:Concepts:` must be defined in `***definitions***`

## Conciseness
- State each req in the fewest plain words that stay exact — see `concise-specs.md`
- Do not restate the default behavior of the test framework this section already names

## Format

```plain
***test reqs***
- :ConformanceTests: should be implemented using pytest framework.
- :ConformanceTests: will be run using "pytest" command.
- :ConformanceTests: must be implemented and executed - do not skip tests.
- :ConformanceTests: should mock all external HTTP calls.
```
