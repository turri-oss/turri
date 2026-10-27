---
name: debug-specs
description: >-
  Investigate a bug observed in the running application by reading the generated
  code in plain_modules/, tracing the issue back to the ***plain, and fixing only
  the .plain files. Generated code is never modified. Use when the user reports
  unexpected behavior, visual glitches, crashes, or incorrect logic in the app.
allowed-tools: [read, write, edit, bash, ls, grep, find]
---

# Debug Specs

## When to Use

- The user observes a bug in the running application (visual, behavioral, crash, performance).
- A conformance test or unit test is failing.
- The generated code does something unexpected or incorrect.
- The user points to a specific functional spec that seems wrong.

## Guiding Principle

Generated code in `plain_modules/<module>/code/` and `plain_modules/<module>/tests/` is **read-only** — it exists solely as evidence for diagnosis. All fixes are applied exclusively to the `.plain` files. The workflow is: observe → read generated code → trace to the ***plain → fix the ***plain.

## Input

1. **The module name** — identifies the `plain_modules/<module_name>/` directory (`code/` and `tests/`) and the corresponding `.plain` file(s).
2. **The user's observation** — what is wrong? This can be a bug description, a screenshot, a test failure, an error message, or a general "this doesn't work right."
3. **Optional: a specific functional spec** — if the user suspects a particular functional spec, start there. Otherwise, investigate broadly.

## Phase 1 — Understand the Context

1. **Read the `.plain` file(s)** for the module — frontmatter, definitions, implementation reqs, test reqs, and all functional specs. Also read `import` and `requires` chains, and the module's test plain files.
2. **Read the user's observation carefully.** Rephrase it back to confirm understanding. Identify:
   - What is the expected behavior?
   - What is the actual behavior?
   - Is this a visual issue, a logic issue, a crash, or a data issue?

## Phase 2 — Investigate the Generated Code

Read files in `plain_modules/<module_name>/code/` to understand what the coding agent produced. **Do not modify any generated files.**

### 2a. Narrow the search

If the user pointed to a specific functional spec or area:
- Identify which generated files implement that functional spec's behavior.
- Read those files to understand the current implementation.

If the investigation is broad:
- Start from the entry point and follow the execution path related to the observed bug.
- Use the observation to narrow down: UI issue → look at widgets/views, logic issue → look at business logic/providers, data issue → look at models/repositories.

### 2b. Read the relevant generated code

For each relevant file:
1. Read the code and understand what it does.
2. Compare the behavior to what the functional spec says it should do.
3. Note any discrepancies — places where the code doesn't match the functional spec's intent.

### 2c. Check conformance tests and unit tests (if relevant)

If the bug manifests as a test failure:
1. Read the failing test — conformance tests in `plain_modules/<module_name>/tests/` (the module's whole suite, no per-functional-spec subfolders), each labelled with the scenario it implements (`conformance scenario <scenario-id> of <module>:<func-id>`, `acceptance scenario <scenario-id> of <module>:<func-id>`), unit tests inside `plain_modules/<module_name>/code/`.
2. Understand what the test expects vs. what the implementation does.
3. Determine whether the test expectation is correct (matches the functional spec) or incorrect (doesn't match the functional spec).

## Phase 3 — Diagnose the Root Cause

Trace the issue from the generated code back to the ***plain. There are six possible root causes — determine which one applies **before** making changes:

| Root Cause | Symptom | Fix |
|------------|---------|-----|
| **Ambiguous functional spec** | The functional spec is correct in intent, but vague enough that the coding agent interpreted it differently than intended. | Add explicit detail to the functional spec to eliminate the ambiguity. |
| **Missing functional spec** | The desired behavior is not covered by any functional spec. The coding agent had no guidance and either did nothing or made an arbitrary choice. | Add a new functional spec, checked as `func-specs.md` says (*Adding a functional spec*). |
| **Conflicting functional specs** | Two functional specs contradict each other, causing the coding agent to produce inconsistent behavior. | Use the `resolve-spec-conflict` skill. |
| **Incorrect functional spec** | The functional spec explicitly describes the wrong behavior. The coding agent implemented it faithfully, but the functional spec itself is wrong. | Rewrite the functional spec to describe the correct behavior. |
| **Incorrect scenario** | The functional spec is correct and the code matches it, but a scenario in its test plain file expects an outcome the functional spec does not state, or contradicts one it states. | Fix the scenario in the test plain file (`test-plain-files.md`). |
| **Missing implementation req** | The functional spec is correct, but the implementation req doesn't provide enough guidance for the coding agent to produce the right code (e.g., missing library, missing architectural constraint, missing platform detail). | Add or update the implementation req, per `impl-reqs.md`. |

### How to diagnose

1. **Read the functional spec that governs the buggy behavior.** Does it clearly and unambiguously describe the correct behavior?
   - If the functional spec is clear and correct but the code is wrong → **ambiguous functional spec** (the coding agent misinterpreted it) or **missing implementation req**.
   - If the functional spec doesn't mention the behavior at all → **missing functional spec**.
   - If the functional spec explicitly describes the wrong behavior → **incorrect functional spec**.
2. **Check for conflicts.** Could another functional spec be overriding or contradicting this behavior?
   - Read all functional specs that touch the same concepts.
   - If two functional specs are in tension → **conflicting functional specs**.
3. **Check the scenario.** When a conformance or acceptance test fails, find its scenario by the scenario-id in the test's label and compare it with the functional spec.
   - If the scenario contradicts or extends the functional spec → **incorrect scenario**.
4. **Check implementation reqs.** Is the coding agent missing guidance on how to implement correctly?
   - Does the implementation req specify the right library, pattern, or constraint?
   - If a platform-specific or framework-specific detail is missing → **missing implementation req**.

## Phase 4 — Fix the ***plain

Apply the fix based on the diagnosed root cause:

| Root Cause | How |
|------------|-------------|
| Ambiguous functional spec | Edit the functional spec inline — add detail under its statement line or reword for clarity |
| Missing functional spec | `func-specs.md`, *Adding a functional spec* |
| Conflicting functional specs | `resolve-spec-conflict` |
| Incorrect functional spec | Edit the functional spec inline — rewrite the incorrect part |
| Incorrect scenario | `test-plain-files.md` - change or take out the scenario |
| Missing implementation req | `impl-reqs.md` |

### Fix guidelines

- **Minimal changes.** Only modify what is necessary to fix the observed bug. Avoid rewriting unrelated functional specs.
- **Preserve chronological order.** If adding a new functional spec, place it correctly relative to the existing ones.
- **Stay language-agnostic.** Functional specs describe behavior, not implementation. Platform-specific guidance belongs in implementation reqs.
- **Respect the 200 LOC limit.** If a fix makes a functional spec too complex, use `break-down-func-spec` to split it.
- **Keep the test plain file in step.** A functional spec you change has its scenarios, if it has any, reviewed in the same ***plain diff, so they still follow from it (`test-plain-files.md`).
- **Check for new conflicts.** After editing, verify the fix doesn't conflict with other functional specs by running `analyze-func-specs` once with the edited functional spec(s) plus every existing functional spec that touches the same concepts. The batched analyzer reports all conflicting pairs in a single call; resolve each with `resolve-spec-conflict`.

## Phase 5 — Verify and Report

1. **Re-read the modified `.plain` file(s)** in full to confirm correctness.
2. **Summarize the findings** for the user:
   - What was observed (the bug)
   - What the generated code was doing (the symptom in code)
   - Which functional spec(s) caused the issue (the root cause)
   - What was changed in the ***plain (the fix)
   - What to expect after regenerating
3. **If uncertain**, present the diagnosis and proposed fix to the user for confirmation before making changes. Some bugs have multiple possible causes — when in doubt, explain the options and let the user decide.

## Debugging Strategies

### Strategy 1: Observation-Driven (most common)

Start from the user's observation and work backward through the code to the functional spec.

```
User sees bug → Read generated code → Find the responsible code path →
Identify which functional spec governs that code → Diagnose why the functional spec produced wrong code →
Fix the ***plain
```

### Strategy 2: Spec-Focused

The user suspects a specific functional spec. Compare the functional spec directly against the generated code.

```
User points to functional spec → Read the functional spec → Find the generated code that implements it →
Compare functional spec intent vs. code behavior → Diagnose the gap → Fix the ***plain
```

### Strategy 3: Test-Failure-Driven

A test is failing. Use the test as the entry point.

```
Read failing test → Understand what it expects → Read the implementation →
Determine if the test or the implementation is wrong → Trace back to the ***plain →
Fix the ***plain (or the test reqs / the scenario in the test plain file if the test itself is wrong)
```

### Strategy 4: Differential

The bug appeared after a new functional spec was added. Compare before and after.

```
Identify the newly added functional spec → Read the functional specs it might conflict with →
Check if the new functional spec introduced the bug → Use resolve-spec-conflict or
revise the new functional spec
```

## Common Pitfalls

### Fixing the code instead of the ***plain
Never modify files in `plain_modules/<module>/code/` or `plain_modules/<module>/tests/`. Even if the fix is obvious in the code, the change must be made in the `.plain` file so it persists across regenerations.

### Treating symptoms instead of root causes
If the user says "the button is in the wrong place," don't just add positioning detail. Investigate why the coding agent placed it there — the root cause might be a missing layout functional spec, an ambiguous screen description, or a conflict with another functional spec.

### Over-specifying the fix
Adding too much implementation detail to a functional spec (e.g., specific pixel values, widget names, CSS properties) makes it brittle. Prefer behavior-level fixes. Use implementation reqs for platform-specific guidance.

### Ignoring ripple effects
A fix to one functional spec may affect others that reference the same concepts. Always check neighboring functional specs for conflicts after making a change.

## Validation Checklist

- [ ] User's observation is clearly understood (expected vs. actual behavior)
- [ ] Generated code has been read to understand the current implementation
- [ ] Root cause is diagnosed (ambiguous / missing / conflicting / incorrect / incorrect scenario / missing impl req)
- [ ] Fix is applied in the `.plain` file(s) only — no generated code modified
- [ ] Fix is minimal and targeted to the observed bug
- [ ] Fix does not introduce new conflicts with existing functional specs
- [ ] Modified functional specs respect the 200 LOC limit
- [ ] Modified functional specs remain language-agnostic
- [ ] Chronological ordering is preserved
- [ ] Test plain file of every changed functional spec in step with it
- [ ] Summary of findings and fix presented to the user
