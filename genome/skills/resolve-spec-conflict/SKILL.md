---
name: resolve-spec-conflict
description: >-
  Resolve a conflict between two functional specs in a .plain file. Use
  when conformance tests for a previously passing functional spec start failing after a new
  one is regenerated, or when a potential conflict is detected while adding a new
  functional spec (the conflict check of `func-specs.md`).
allowed-tools: [read, write, edit, ls, grep, find]
---

# Resolve Spec Conflict

## When This Applies

A conflict exists (or is suspected) when:
- Conformance tests for a **previously passing** functional spec begin to fail after a new one is regenerated.
- A new functional spec being added appears to contradict an existing functional spec.
- Two functional specs make incompatible assertions about the same behavior, data, or state.

## Workflow

### Step 1: Identify the Conflicting Pair

Read the `.plain` file and pinpoint the two functional specs in tension. If the conflict was detected via a conformance test failure, also read the failing test and the generated implementation in `plain_modules/` to understand what behavior changed.

### Step 2: Diagnose the Root Cause

There are three possible outcomes — determine which one applies **before** making changes:

| Outcome | Symptom | Fix |
|---------|---------|-----|
| **Implementation is incorrect** | Generated code doesn't match the functional spec's intent. The functional specs themselves are fine. | Clarify the ambiguous functional spec so the coding agent interprets it correctly. Regenerate. |
| **Conformance tests are incorrect** | The tests don't accurately verify the functional spec. The implementation is actually correct. | Adjust `***test reqs***`, or a scenario in the test plain file (*Writing scenarios* in `test-plain-files.md`), to guide better test generation. Regenerate. |
| **Requirements truly conflict** | The two functional specs are inherently contradictory — no implementation can satisfy both. | One or both functional specs must be revised. See Step 3. |

**How to diagnose:**
1. Read both functional specs carefully. Can a single implementation satisfy both simultaneously?
2. If yes → the functional specs are compatible; the issue is ambiguity (outcome 1) or bad tests (outcome 2).
3. If no → the requirements truly conflict (outcome 3).

### Step 3: Resolve the Conflict

When the requirements truly conflict, choose a resolution strategy:

**Strategy A: Add detail to disambiguate.** Often the functional specs aren't contradictory — they're just ambiguous enough that the coding agent picks a conflicting interpretation. Adding explicit context to one or both functional specs eliminates the ambiguity.

Before (ambiguous):
```plain
***functional specs***

# list-resources
All :Resource: items are returned.

# list-active-resources
Only active :Resource: items are returned.
```

After (disambiguated):
```plain
***functional specs***

# list-resources
All :Resource: items are returned when no filter is specified.

# list-active-resources
When the "active" filter is specified, only active :Resource: items are returned.
```

**Strategy B: Revise the newer functional spec.** If the new functional spec introduced the conflict, rewrite it to be compatible with the established behavior from earlier functional specs.

**Strategy C: Revise the older functional spec.** If the older functional spec was under-specified and the new requirement reveals a better design, update the older functional spec. This is more disruptive — the older one's code is patched in place, and the functional specs that rely on what it did may need changing too.

**Strategy D: Merge into one.** If the two functional specs describe overlapping behavior, combine them into a single, clear one. Remove the redundant one and its test plain file, moving any scenario that still fits into the kept functional spec's file. Be mindful of the 200 LOC limit.

### Step 4: Validate the Resolution

After editing:
1. Re-read the full `***functional specs***` section to confirm no new conflicts were introduced.
2. Check that any revised functional spec still respects the 200 LOC limit.
3. Check that chronological ordering still makes sense (earlier functional specs should not depend on later ones).
4. If resolving via test adjustments, verify the `***test reqs***` or test plain file changes are appropriate.
5. Bring the test plain file of every revised functional spec in step with its new text, in the same ***plain diff (*Keeping test plain files in step* in `test-plain-files.md`).

## Prevention (while adding a functional spec)

Before adding a new functional spec, run through this quick conflict check:

1. List every existing functional spec that touches the same `:Concepts:` as the new functional spec.
2. For each, ask: "Can a single implementation satisfy both this existing functional spec and the new one?"
3. If any answer is "not obviously yes" — add explicit detail to the new functional spec to eliminate the ambiguity **before** inserting it.

## Validation Checklist

- [ ] Root cause diagnosed (implementation / tests / true conflict)
- [ ] Resolution strategy chosen and applied
- [ ] Revised functional specs are language-agnostic
- [ ] Revised functional specs trimmed per `concise-specs.md` — added disambiguation stays as short as it can be
- [ ] Revised functional specs each imply ≤ 200 LOC
- [ ] No new conflicts introduced by the fix
- [ ] Chronological ordering preserved
- [ ] All referenced `:Concepts:` are still defined
- [ ] Test plain files of the revised functional specs in step with them (`test-plain-files.md`)
