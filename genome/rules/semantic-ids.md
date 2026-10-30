---
description: Syntax, uniqueness and use of func-ids and scenario-ids in .plain files
---

# Rules for func-ids and scenario-ids

Every functional spec in `***functional specs***` and every scenario in a test plain file carries an id: its name, given by the author and never by its position. turri knows a functional spec by its func-id - in the code record, in its pulses, in the conformance tests' labels and in what it tells the person - and a scenario by its scenario-id. Always follow these rules when writing or reading one.

## Two kinds of id

| id | Written as | Names | Unique within |
|---|---|---|---|
| func-id | a `# <func-id>` heading in `***functional specs***` of a module | one functional spec | its module |
| scenario-id | a `# <scenario-id>` heading in `***conformance tests***` or `***acceptance tests***` of a test plain file | one scenario | its functional spec, across every test plain file bound to it |

## Syntax
- Lowercase letters, digits and hyphens only: `add-task`, `export-csv-2`, `ctrl-d-exit`
- The heading is `# ` (a hash and one space) followed by the id and nothing else
- Make the id short kebab-case from what the functional spec or scenario means (`add-task`, never `spec-3`)

## Uniqueness
- A func-id is unique in its module; two modules may use the same func-id
- A scenario-id is unique among its functional spec's scenarios, once every test plain file bound to it is merged; two functional specs may use the same scenario-id
- Before adding an id, search the module (or the functional spec's test plain files) for the same heading; a duplicate is an error `turri parse` reports

## Stability
- An id is an identity, not a label: a functional spec keeps its func-id for as long as it exists, even when its text changes
- A pure rename is cheap: a func-id renamed with nothing else changed - its body, its links and its scenarios as they were, only the `# <func-id>` heading and `func_id:` in its test plain files - is renamed by turri in its records and its tests' labels, and nothing is regenerated. The same holds for a scenario-id renamed with its text as it was
- A rename together with any other change rebuilds: to turri it is one functional spec taken out and another added, its code built anew and its tests written anew (`turri-regeneration.md`). So rename in a ***plain diff of its own, never in the same edit as a change to the body or the scenarios
- Rename only when the person asks, then rename `func_id:` in every test plain file bound to it, and the file with it
- Never renumber or reorder ids: the order of the headings in the module is the order of its functional specs, and the id carries no order

## Naming a functional spec
- Name a functional spec by its func-id - `<module>:<func-id>` outside its module (`todo:add-task`) - in questions to the person, in what you show them and in turri's tools; never by its position ("the third functional spec")
- Pick the func-id before writing the functional spec, check that it is unique in the module, then write the heading and the body (see `func-specs.md`)
- Everything about one functional spec is found through its func-id: its heading, the test plain files whose frontmatter names it, and the conformance tests labelled with it
- A conformance or acceptance test carries the scenario-id of the scenario it implements: when one fails, its label leads back to the scenario

## Format

```plain
***functional specs***

# add-task
A :User: can add a :Task:. Only valid :Task: items are added.

# delete-task
A :User: can delete a :Task:.
```
