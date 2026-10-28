---
description: Rules for writing ***functional specs*** in .plain files
---

# Rules for writing `***functional specs***`

When writing or editing a `***functional specs***` section in a `.plain` file, always follow these rules:

## Shape
- Each functional spec is a `# <func-id>` heading followed by its body; the func-id follows `semantic-ids.md`
- The body is free text that describes the behaviour: its first line states it, and prose or `- ` bullets under that line add the detail
- No body line starts with `# ` (that starts the next functional spec) or with `***`
- A functional spec's test scenarios live in its test plain file, never in this section (see `test-plain-files.md`)

## Voice
- Write each functional spec as a **statement of fact** — present tense, indicative mood — describing what the software *is* or *does* once built, not as a command telling a developer what to build
- **Name a concrete subject**: an actor (`A :User: can …`), a named component or concept (`:PdfRenderer: lays out …`, `:Order: processing depends on …`), or the affected data in passive voice (`All :Resource: items are returned`)
- **Avoid the vague subject "The system …"** — it says nothing about *which* part does the work. Prefer the concrete component/concept, or passive voice with the affected concept as the subject
- **Never open a functional spec with an imperative** like "Implement …", "Add …", "Create …", "Show …", "Display …", "Build …" — those read as instructions, not as what the software does
- Do **not** use "should" / "should be able to" in a functional spec — that is requirement-modal voice; state the fact directly

BAD — imperative commands, or the vague "The system":

```plain
***functional specs***

# entry-point
Implement the entry point for :App:.

# show-task-list
The system shows :TaskList:.

# add-task
Add :Task:.
```

GOOD — statements of fact with concrete subjects:

```plain
***functional specs***

# entry-point
:App: has an entry point.

# show-task-list
The :TaskList: is displayed.

# add-task
A :User: can add a :Task:. Only valid :Task: items are added.
```

## Conciseness
- A functional spec that a human will not read is not reviewed, so every one must be as short as its content allows — see `concise-specs.md`
- Cut anything obvious, any rationale, and every uncheckable adjective; keep every interface detail, boundary case, and disambiguation
- Shorten the wording, never the facts: the rules below always win over brevity

## Complexity limit
- The complexity limit is about breaking software into small, independently understandable behavior slices that people and AI can reason about, implement, and test reliably
- The current mechanism for enforcing the complexity limit is that each functional spec must imply a **maximum of 200 changed lines of code**.
- Smaller slices produce focused test failures, reduce hidden coupling and regression surface, and make review and incremental regeneration more predictable
- If a functional spec is too large, use `break-down-func-spec` to split it into multiple smaller, independent ones
- Judge a functional spec's size yourself before inserting it: estimate the code it implies - new files, functions, data model changes, UI components, error paths, boilerplate, its unit tests - and treat more than ~150 lines as too big, leaving the coding agent headroom
- Signs a functional spec is too big - one is not proof, several are:
  - more than one independently testable behavior ("create, edit, delete and archive")
  - more than three new constructs at once - data structures, UI components, endpoints
  - several modes or conditional paths, each with its own behavior
  - core behavior bundled with cross-cutting concerns - retries, pagination, caching, logging
  - a whole screen with several interactive elements and state transitions
  - multi-step transformations, joins or aggregations across entities
  - a substantial technical component it must build as well as use - an engine, parser, scheduler, layout algorithm, state machine, sync mechanism; it counts toward the limit, and goes in a functional spec of its own before the one that uses it
- Use `analyze-func-specs` to check a functional spec (or a batch of them) against all relevant existing ones in a single batched call; use `resolve-spec-conflict` for each conflicting pair it reports

## First-spec bootstrap cost
- The first functional spec in a new root module carries implicit implementation cost even when its text describes little behavior
- The coding agent may need to create the project structure, package metadata, framework configuration, entry point, initial source files, and unit-test infrastructure before implementing the behavior
- Count that bootstrap work toward the 200-changed-line limit; it is not free setup outside the functional spec
- Make the first functional spec the module's simplest useful, independently observable capability
- The first functional spec must still imply a testable outcome; setup alone is not a functional spec
- Prefer one minimal entry point or public operation with a deterministic result that can be invoked and verified
- Defer persistence, integrations, multiple interfaces, branching workflows, and cross-cutting behavior until later functional specs can build on the generated baseline
- A functional spec may start on its happy path and be hardened later - validation, edge cases and errors added to it by changing it - once the software has been tried; it must still say exactly what it does for the input it covers
- This extra bootstrap cost applies when no previous implementation baseline exists; a module that continues from a `requires` module may already inherit the necessary scaffold

## Chronological ordering
- Functional specs are regenerated incrementally, top to bottom
- The coding agent has **no knowledge of later functional specs** — only those before it are in context
- A new functional spec can reference behavior from earlier ones but cannot assume anything about those that come after it
- Functional specs from `requires` modules are treated as previous requirements — transitively, across the whole ancestor chain
- This order is about what a functional spec may assume, not what a change costs: turri regenerates a change as a ***plain diff wherever it sits (`turri-regeneration.md`)

## No conflicts
- A new functional spec must not contradict any existing one
- Before adding, review all existing functional specs and verify compatibility
- If ambiguity exists, add explicit detail to eliminate any conflicting interpretation

## Adding a functional spec
Every new functional spec - one or a batch - is checked before it is written into the file:
1. Draft it, then trim it per `concise-specs.md` to the shortest wording that keeps every fact
2. Judge its size against the complexity limit; when it is too big, split it with `break-down-func-spec` and check each part from step 1
3. Check it for conflicts with **one** `analyze-func-specs` call over the new functional spec and every existing one in the file and its `requires` chain - never pair by pair. Resolve each conflicting pair it reports with `resolve-spec-conflict`, then run it again over what changed until it is compatible
4. Pick its func-id per `semantic-ids.md`, unique in the module - and in the batch
5. Only then write it in, where it belongs (see Placement), as its `# <func-id>` heading and body - with no test plain file, unless the person asks for its tests (see `test-plain-files.md`)

A batch is checked one functional spec at a time, in order: each one's conflict check includes those of the batch already written in. Never write the whole batch in first and check it afterwards - a bad functional spec already in the file skews every later check. A few functional specs are no reason to skip a check.

## Placement
Put a new functional spec where it fits the module as it reads, not at the end by default:
- **Below every functional spec it builds on** - each one whose behaviour it references or extends, and the first to use each concept it relies on
- **Above every functional spec that builds on it** - one that already assumes what it adds
- **Within those bounds, beside the functional specs of its feature** - usually straight after the last one it extends
- **At the end** only when it starts something new or fits nowhere better

## Language agnosticism
- Write in terms of behavior, concepts, and domain logic
- Avoid language-specific terminology: generics syntax, framework annotations, language-specific collection types, decorator syntax, base-class keywords, framings like "POJO" or "dataclass"
- General technical terms that are not language-specific are fine: null values, JSON types, HTTP status codes, REST endpoints, etc.
- **Naming concrete components is encouraged.** Functional specs can and should refer to concrete domain components, services, or entities (e.g., `:PaymentProcessor:`, `:UserRepository:`, `:DataConverter:`) and their operations (e.g., `:ChargeCard:`, `:FindById:`), pinning down their inputs, outputs, and error behavior. Those names are part of the public contract and survive a language switch. What they must **not** do is bake in how the contract is realized (`@staticmethod`, `class Foo extends Bar`, `List<T>`, `async def`, etc.)
- **Litmus test:** if the project switched from Python to Java (or vice versa), would the functional spec read correctly with only `***implementation reqs***` updated? If yes, it is language-agnostic. If the functional spec itself would need rewording, the construct belongs in implementation reqs.

## Disambiguation
- Each functional spec must be unambiguous — the coding agent should have only one reasonable interpretation
- If the statement line is not enough to fully disambiguate the behavior, add `- ` bullets or sentences under it to add detail
- The detail clarifies the statement - it does not introduce separate behaviour
- Even with the detail, the functional spec must still imply ≤ 200 lines of code

## Testability
- Every functional spec must describe behavior that can be verified through an observable interface
- State the triggering input or action and the deterministic outcome a test can observe
- Include relevant outputs, state changes, errors, or externally visible side effects
- Do not rely on generated implementation details as the only way to verify the behavior
- If a black-box conformance scenario could not be written from the functional spec, make the behavior more explicit

## Deterministic interface
- Functional specs must be detailed enough that a developer can use the built software without reading the generated code
- All external interfaces must be explicit: REST endpoint paths and HTTP methods, CLI command names and arguments, file formats, message schemas, etc.
- Never leave interface details up to the coding agent's discretion

## Encapsulation
- Behaviour must be self-contained in the functional spec's text
- `requires` modules only pass on functional specs and `exported_concepts` — never implementation reqs, so do not rely on implementation reqs to convey behavior
- Behavior that downstream modules need must be expressed in functional specs, not elsewhere

## Test scenarios live in test plain files
- A module never holds a `***conformance tests***` or `***acceptance tests***` section, nested or top-level
- A functional spec's conformance and acceptance scenarios go into its test plain file, `tests/<module>/<func-id>.plain`, and are written only when the person asks for tests (see *Writing scenarios* in `test-plain-files.md`)
- A functional spec and its test plain file change together, in the same ***plain diff: a new one gets none, unless its tests are asked for; a changed one has its scenarios, if any, reviewed; a split, moved, renamed or deleted one takes its test plain file, if it has one, with it (see *Keeping test plain files in step* in `test-plain-files.md`)

## Format

```plain
***functional specs***

# entry-point
:App: has an entry point.

# add-task
A :User: can add a :Task:. Only valid :Task: items are added.

# send-message
A :User: can send a :Message: to a :Conversation:.
- A :Message: must have non-empty content.
- The :Message: is appended to the end of the :Conversation:.
- All :Participant: members of the :Conversation: can see the new :Message:.
```
