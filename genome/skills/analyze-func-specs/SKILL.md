---
name: analyze-func-specs
description: >-
  Analyze a batch of functional specs from a .plain file to determine
  which pairs conflict. Replaces the pair-by-pair `analyze-2-func-specs` flow
  when a caller wants to check many functional specs at once (e.g. a new one against
  every existing one, or a freshly inserted batch against itself).
allowed-tools: [read, ls, grep, find]
---

# Analyze Functional Specs

## Input

A **set of two or more functional specs** to check against each other. Callers typically supply one of:

- A whole `***functional specs***` section to self-check.
- A new functional spec (or batch of them) **plus** the existing functional specs from the same file and any `requires` modules.
- An explicit list of functional spec snippets the user wants compared.

Each functional spec must be identifiable. Use its func-id (`<module>:<func-id>` when the batch spans modules). A draft that has no func-id yet gets a **stable identifier** in order of appearance: `S1`, `S2`, `S3`, …. Use those identifiers in the output. If the caller provided its own labels or quoted snippets, use those instead and keep them verbatim.

The skill also needs the `***definitions***` section (and any imported definitions) so referenced `:Concepts:` can be resolved.

## Workflow

1. **Read all input functional specs and the relevant `***definitions***`** so every `:Concept:` is understood.
2. **Establish chronological order** across the batch. Earlier functional specs are considered to have been regenerated first; later ones are evaluated with the earlier ones in context. If the caller already provided an order, preserve it.
3. **Generate the pair list.** Enumerate every unordered pair of functional specs, the earlier first. Skip pairs where the two share no `:Concept:` and no overlapping subject — they are trivially compatible and listing them adds noise.
4. **Run the conflict analysis below on each remaining pair.** Use the same checklist that the legacy `analyze-2-func-specs` skill used, but apply it pair by pair across the batch in a single pass — do not require the caller to invoke the analyzer once per pair.
5. **Record every CONFLICTING pair.** Compatible pairs are not listed individually; only the conflicts are emitted.
6. **Output the verdict** in the format below. No reasoning, no category labels, no resolution suggestions.

## Conflict Analysis Checklist (applied per pair)

Work through each question for the pair under inspection. If any answer is "yes", that pair is CONFLICTING.

### 1. Direct Contradiction

Do the two functional specs make mutually exclusive assertions about the same behavior?

```
# sort-by-name
:Resource: items are returned sorted by name in ascending order.

# sort-by-date
:Resource: items are returned sorted by creation date in descending order.

Verdict: CONFLICTING — both define the sort order for the same response,
but specify different fields and directions. A single implementation cannot
satisfy both unless scoped to different contexts.
```

### 2. State or Data Conflict

Does one functional spec set a state or value that the other assumes is different?

```
# empty-task-list
:TaskList: is initially empty.

# welcome-task
:TaskList: contains a default "Welcome" :Task: on first load.

Verdict: CONFLICTING — both define the initial state of :TaskList: differently.
```

### 3. Behavioral Override

Does the later functional spec silently replace behavior established by the earlier one without acknowledging it?

```
# api-key-auth
:User: credentials are validated using an API key.

# oauth-auth
:User: credentials are validated using OAuth 2.0.

Verdict: CONFLICTING — both define the authentication mechanism but pick
different approaches. The later one overrides the earlier one.
```

### 4. Scope Ambiguity

Are the two functional specs ambiguous enough that a coding agent could interpret them as conflicting, even if the user intends them to be complementary?

```
# list-resources
All :Resource: items are returned.

# list-active-resources
Only active :Resource: items are returned.

Verdict: CONFLICTING (ambiguous) — "all" vs "only active" appear contradictory.
Could be resolved by scoping each to different conditions (e.g., filtered vs unfiltered).
```

### 5. Shared Concept, Different Constraints

Do both functional specs impose constraints on the same `:Concept:` that cannot coexist?

```
# default-batch-size
:BatchSize: is 100 items.

# attachment-batch-size
:BatchSize: is 50 items for :Resource: types with attachments.

Verdict: COMPATIBLE — attachment-batch-size adds a conditional refinement, not a contradiction.
```

## Output Format

Emit exactly one of the two shapes below, with no surrounding text, explanation, category label, or resolution suggestion.

If **no pair** is conflicting:

```
COMPATIBLE
```

If **one or more pairs** are conflicting, emit `CONFLICTING` followed by one line per conflicting pair, in `<a> x <b>` form (the identifiers from step 1, the one that comes first in the input on the left), sorted lexicographically:

```
CONFLICTING
add-task x import-tasks
list-tasks x S2
```

Rules for the output:

- Do **not** list compatible pairs.
- Do **not** include reasoning, checklist categories, or fixes — the caller decides what to do with each conflict (typically: invoke `resolve-spec-conflict` on each pair).
- If the input contained fewer than two functional specs, emit `COMPATIBLE` (nothing to compare).
- Identifiers must match exactly what *Input* settled: the func-ids, the caller's own labels, or the `S1`, `S2`, … fallback for a draft.

The internal pairwise analysis informs the verdict but must not appear in the output.
