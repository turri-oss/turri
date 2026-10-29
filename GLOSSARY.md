# turri

turri regenerates code, and the conformance tests that check it, from \*\*\*plain. This is the language its code, records, docs and rules share.

## \*\*\*plain

**Module**:
One `.plain` file and what it says: its definitions, implementation reqs, test reqs and functional specs, named after the file.
_Avoid_: spec file, \*\*\*plain spec

**Functional spec**:
One behaviour of a module, written as a `# <func-id>` heading followed by free text.
_Avoid_: spec (alone)

**Func-id**:
A functional spec's name in its module: lowercase letters, digits and hyphens, unique in the module, given by the author and not by position. Outside its module, a functional spec is named `module:func-id`.
_Avoid_: frid, functionality number

**Test plain file**:
A `.plain` file holding the conformance and acceptance scenarios of one functional spec, bound to it by module and func-id, in the module's folder under the project's test folder.

**Scenario**:
One verifiable use of a functional spec, written in its test plain file under a `# <scenario-id>` heading. A **conformance scenario** is an expected use; an **acceptance scenario** an unexpected one, written only when the person asks for it. A functional spec with no scenarios is not tested.
_Avoid_: acceptance test (for what the \*\*\*plain says), test case

**Scenario-id**:
A scenario's name under its functional spec, unique among that functional spec's scenarios.
_Avoid_: acceptance test number

**Requires chain**:
A module and every module it requires, transitively: each one built on the behaviour of the ones below it.

**Tip**:
The top module of a requires chain, whose codebase the whole chain is built in.
_Avoid_: top module, last module

**Import module**:
A module of definitions and reqs with no functional specs, whose text is laid into the modules that import it.
_Avoid_: library module

**Stdlib template**:
An import module of turri's own that settles a kind of software on one stack; a stack's **conformance template** holds only the test reqs for testing it.

## Regenerating

**Regenerate**:
To bring code, and its tests, in line with the \*\*\*plain it is built from.
_Avoid_: render, grow, build (for \*\*\*plain into code)

**\*\*\*plain diff**:
A change to \*\*\*plain, as a diff of its files - what turri regenerates from.
_Avoid_: spec diff

**Codebase**:
The code built from one module or requires chain, with its unit tests, conformance tests and their history.
_Avoid_: build dir

**Pulse**:
One unit of regenerating work: a code pulse changes the code and its unit tests, a conformance pulse the conformance tests. It lands whole or not at all.
_Avoid_: job (in docs), run, render

**Case**:
What a pulse does to one functional spec or scenario: add, patch, regenerate again, delete, or - for a scenario whose functional spec's code moved - code changed. A pulse that touches no functional spec is **mechanical**.

**Regenerate again**:
To build a functional spec's code anew though its \*\*\*plain has not changed.

**Pure rename**:
A func-id or scenario-id changed and nothing else; the code and tests are kept, under the new name.

## Tests

**Unit tests**:
The tests the coding agent writes beside the code, checking it from the inside.

**Conformance tests**:
Black-box tests written from a functional spec's conformance scenarios, at least one for each scenario, checking the code from the outside.

**Acceptance tests**:
Black-box tests written from a functional spec's acceptance scenarios.

**Unit testing script**:
The project's script that runs the unit tests against the code; only it decides whether they pass.
_Avoid_: test runner

**Conformance testing script**:
The project's script that runs the conformance and acceptance tests against the code; only it decides whether they pass.
_Avoid_: test runner

**Test advisor**:
turri's background check of whether a new or changed functional spec needs explicit testing scenarios. It decides; on a yes, the chat writes them.
_Avoid_: test classifier, scenario writer
