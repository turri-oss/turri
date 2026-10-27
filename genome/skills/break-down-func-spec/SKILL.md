---
name: break-down-func-spec
description: >-
  Break down a functional spec that is too complex into smaller ones that
  each imply ≤ 200 lines of code. Use when a functional spec is judged too large against
  the complexity limit (`func-specs.md`), before or after it is written in.
allowed-tools: [read, write, edit, ls, grep, find]
---

# Break Down Functional Functional spec

## When to Use

- A functional spec is judged to exceed the 200 LOC limit (`func-specs.md`, *Complexity limit*) and needs to be split before it is written in.
- A functional spec already written in turns out too large - its pulse could not get its unit tests to pass.
- A functional spec bundles multiple behaviors, constructs, or concerns that should be separated.

## Input

The functional spec to break down, plus the full `.plain` file it belongs to.

## Workflow

1. **Read the full `.plain` file** — definitions, implementation reqs, and all functional specs (including `requires` modules) to understand context.
2. **Identify the functional spec to break down** — the one flagged as too complex or pointed to by the user.
3. **Analyze why it is too complex** — use the signs in `func-specs.md` (*Complexity limit*):
   - Multiple distinct behaviors bundled together?
   - Too many new constructs introduced at once?
   - Complex branching logic or conditional paths?
   - Cross-cutting concerns mixed with core behaviour?
   - A full UI screen described in one functional spec?
   - Complex data transformations across multiple entities?
   - Implies one substantial technical component (engine, parser, scheduler, algorithm, state machine, sync mechanism) that must be built in code?
4. **Identify the split boundaries** — find the natural seams where the functional spec can be divided. Each resulting one must be:
   - Independently meaningful (makes sense on its own with the functional specs before it as context)
   - Self-contained (does not require a later functional spec to be useful)
   - Within the 200 LOC limit
5. **Draft the replacements** — write the smaller functional specs in chronological order, each with its own func-id per `semantic-ids.md`; the replacement that keeps the original's main behaviour may keep the original's func-id. The first replacement typically sets up the foundation, and subsequent ones layer behavior on top.
6. **Verify functional completeness** — this is critical. The replacements taken together must cover **100% of the behaviour** the original describes. Walk through every behavior, condition, and detail in the original and confirm it appears in exactly one of the replacements. Nothing may be lost, weakened, or left implicit. If any behaviour from the original is missing, add it to the appropriate replacement or create an additional one.
7. **Verify each replacement** — judge each against the complexity limit, and split again any that is still too large.
8. **Check for conflicts** — run `analyze-func-specs` **once** with the full set of replacements plus every existing functional spec in the file and its `requires` chain. The batched analyzer reports every conflicting pair (replacement × existing and replacement × replacement) in one call — do not loop over pairs. Resolve each reported pair with `resolve-spec-conflict`, then re-run `analyze-func-specs` over the touched set until the verdict is `COMPATIBLE`.
9. **Replace in the file** — remove the original functional spec (heading and body) and insert the replacements in its position, each as a `# <func-id>` heading with its body, preserving chronological order.
10. **Bring the test plain files in step**, in the same ***plain diff - every replacement gets its test plain file, each scenario of the original's moves to the replacement it tests, and the original's file is deleted when its func-id is gone (*Keeping test plain files in step* in `test-plain-files.md`). No scenario is written for a replacement that the original's did not have.
11. **Read the file again** to confirm correct placement and syntax.

## Splitting Strategies

### Strategy 1: Separate Distinct Behaviors

If the functional spec bundles multiple independently testable actions, split each into its own.

**Before:**
```plain
***functional specs***

# manage-recipes
A :User: can create, edit, and delete :Recipe: items, with validation on all fields.
```

**After:**
```plain
***functional specs***

# create-recipe
A :User: can create a :Recipe:. Only valid :Recipe: items can be created.

# edit-recipe
A :User: can edit an existing :Recipe:. Validation rules apply to the edited fields.

# delete-recipe
A :User: can delete a :Recipe:.
```

### Strategy 2: Separate Setup from Behavior

If the functional spec introduces a new construct and immediately defines complex behavior on it, split into setup + behavior.

**Before:**
```plain
***functional specs***

# meal-plan-screen
The :MealPlan: screen displays a weekly grid of :Slot: items, allows drag-and-drop reordering, and shows nutritional totals per day.
```

**After:**
```plain
***functional specs***

# meal-plan-grid
The :MealPlan: screen displays a weekly grid of :Slot: items.

# reorder-slots
A :User: can reorder :Slot: items within a day on the :MealPlan: screen using drag-and-drop.

# daily-nutrition-totals
The :MealPlan: screen displays nutritional totals for each day.
```

### Strategy 3: Separate Core Logic from Cross-Cutting Concerns

If the functional spec mixes primary behaviour with error handling, retries, caching, pagination, or logging, pull cross-cutting concerns into their own functional specs.

**Before:**
```plain
***functional specs***

# fetch-ingredients
:Ingredient: data is fetched from the external API with pagination, retry on transient errors, and caching for 10 minutes.
```

**After:**
```plain
***functional specs***

# fetch-ingredients
:Ingredient: data is fetched from the external API.

# fetch-ingredients-paged
:Ingredient: data is fetched from the external API in pages.

# retry-ingredient-fetch
Fetching :Ingredient: data is retried on transient errors.
```

### Strategy 4: Separate Conditional Paths

If the functional spec describes different modes or branches, give each its own.

**Before:**
```plain
***functional specs***

# generate-meal-plan
:MealPlan: generation depends on :DietType:. Standard plans use round-robin assignment. Restrictive plans filter out excluded ingredients first, then apply round-robin. Custom plans allow manual slot-by-slot selection.
```

**After:**
```plain
***functional specs***

# generate-standard-plan
A standard :MealPlan: is generated using round-robin :Recipe: assignment.

# generate-restrictive-plan
A restrictive :MealPlan: is generated.
- Excluded :Ingredient: items are filtered out first.
- Round-robin :Recipe: assignment is then applied.

# assign-custom-plan
A :User: can manually assign :Recipe: items to :Slot: items for a custom :MealPlan:.
```

### Strategy 5: Build UI Incrementally

If the functional spec describes a full screen, split into layout + individual interactive elements.

**Before:**
```plain
***functional specs***

# dashboard-screen
The :Dashboard: screen shows a summary card with stats, a scrollable list of recent :MealPlan: items, a floating action button to create a new plan, and a bottom navigation bar.
```

**After:**
```plain
***functional specs***

# dashboard-summary-card
The :Dashboard: screen shows a summary card with :MealFrameStats:.

# dashboard-recent-plans
The :Dashboard: screen shows a scrollable list of recent :MealPlan: items.

# dashboard-new-plan-button
The :Dashboard: screen includes a button to create a new :MealPlan:.
```

### Strategy 6: Extract a Reusable Technical Component

Sometimes a functional spec is too complex not because it bundles many behaviors, but because it implies building one substantial technical component inline — an engine, parser, scheduler, layout algorithm, state machine, or sync mechanism. Splitting the behavior sideways does not help when the weight sits in that single component. Instead, pull the component out: define a concept for it, build it in its own dedicated functional spec placed **earlier** in the chain, then rewrite the original to use the component **by reference**. Because functional specs are regenerated incrementally top-to-bottom, the original now implies far less code — it wires up a component that already exists rather than implementing it from scratch.

Define the component concept in `***definitions***` (per `definitions.md`) before the first functional spec that references it.

**Before:**
```plain
***functional specs***

# export-report-pdf
A :Report: is exported to PDF, laying out multi-page tables with repeating headers, page numbers, and charts rendered from :Report: data.
```

**After:**
```plain
***functional specs***

# pdf-renderer-tables
:PdfRenderer: lays out multi-page tables from structured content.
- Table headers repeat at the top of each page.
- Each page shows its page number.

# export-report-pdf
A :Report: is exported to PDF using :PdfRenderer:, embedding charts rendered from :Report: data.
```

The extracted component's functional spec and the rewritten original must together still cover 100% of the original behaviour (step 6): the original must **reference** the component, never re-describe it. Keep the component's technology and architecture choices in `***implementation reqs***`, not in the functional spec. If the component is a self-contained subsystem or will be reused across modules, promote it to its own module - one that `requires` it, following `requires-modules.md`, or with `refactor-module` - instead of a sibling functional spec.

## Preserving Chronological Order

The replacements take the position of the original. Earlier functional specs remain unchanged. The first replacement should make sense given only the functional specs above it. Each subsequent replacement can reference behavior from the ones before it.

The original's test plain file is split the same way: each scenario moves to the replacement it tests, and one that no longer fits a single replacement is rewritten to fit the one it tests most. A replacement no scenario moves to gets an empty test plain file (see `test-plain-files.md`).

## Validation Checklist

- [ ] The original functional spec has been removed from the file
- [ ] The replacements together cover 100% of the original's behaviour — nothing lost
- [ ] Each replacement implies ≤ 200 LOC (judged against the complexity limit)
- [ ] No conflicts between the replacements and existing functional specs (verified via one batched `analyze-func-specs` call)
- [ ] No conflicts between the replacements themselves (covered by the same batched call)
- [ ] The replacements are in correct chronological order
- [ ] Each replacement is independently meaningful
- [ ] All `:Concepts:` referenced in the replacements are defined
- [ ] Any extracted technical component is defined as a concept, built by its own earlier functional spec, and only **referenced** (not re-described) by the original
- [ ] The replacements are language-agnostic
- [ ] The replacements trimmed per `concise-specs.md` — a split is not a licence to re-add prose
- [ ] All external interfaces remain explicit
- [ ] Test plain files follow the split: one per replacement, every original scenario moved or rewritten, none bound to a func-id that no longer exists
