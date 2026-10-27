---
name: analyze-2-func-specs
description: >-
  Analyze two functional specs from a ***plain spec file to determine if they
  conflict. Use when the user wants to check whether two specific functional
  requirements are compatible, or when debugging a suspected conflict between
  two specs.
allowed-tools: [read, ls, grep, find]
---

# Analyze Two Functional Specs

## Input

Two functional specs from a `.plain` file (or across `requires` modules). The user provides them directly or names them by func-id - `<module>:<func-id>` across modules. Name each by its func-id while you work; a draft that has none yet is Spec A or Spec B.

## Workflow

1. **Read both functional specs** and the `***definitions***` section so all referenced `:Concepts:` are understood.
2. **Determine chronological order** — which spec comes first? The earlier spec was rendered first and the later spec was rendered with the earlier one in context.
3. **Run the conflict analysis** using the checklist below.
4. **Output the verdict and nothing else** — either `COMPATIBLE` or `CONFLICTING`. No reasoning, no category labels, no resolution suggestions.

## Conflict Analysis Checklist

Work through each question. If any answer is "yes", the specs likely conflict.

### 1. Direct Contradiction

Do the two specs make mutually exclusive assertions about the same behavior?

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

Does one spec set a state or value that the other spec assumes is different?

```
# empty-task-list
:TaskList: is initially empty.

# welcome-task
:TaskList: contains a default "Welcome" :Task: on first load.

Verdict: CONFLICTING — both define the initial state of :TaskList: differently.
```

### 3. Behavioral Override

Does the later spec silently replace behavior established by the earlier spec without acknowledging it?

```
# api-key-auth
:User: credentials are validated using an API key.

# oauth-auth
:User: credentials are validated using OAuth 2.0.

Verdict: CONFLICTING — both define the authentication mechanism but pick
different approaches. The later spec overrides the earlier one.
```

### 4. Scope Ambiguity

Are the two specs ambiguous enough that a renderer could interpret them as conflicting, even if the user intends them to be complementary?

```
# list-resources
All :Resource: items are returned.

# list-active-resources
Only active :Resource: items are returned.

Verdict: CONFLICTING (ambiguous) — "all" vs "only active" appear contradictory.
Could be resolved by scoping each to different conditions (e.g., filtered vs unfiltered).
```

### 5. Shared Concept, Different Constraints

Do both specs impose constraints on the same `:Concept:` that cannot coexist?

```
# default-batch-size
:BatchSize: is 100 items.

# attachment-batch-size
:BatchSize: is 50 items for :Resource: types with attachments.

Verdict: COMPATIBLE — attachment-batch-size adds a conditional refinement, not a contradiction.
```

## Output Format

The skill emits exactly one of these two strings, with no surrounding text, explanation, category label, or resolution suggestion:

```
COMPATIBLE
```

or

```
CONFLICTING
```

The internal analysis (checklist, chronological reasoning) informs the verdict but must not appear in the output. The caller decides what to do with the result — typically: act on `COMPATIBLE` by proceeding, or invoke `resolve-spec-conflict` on `CONFLICTING` to produce the actual fix.
