---
name: convert-old-syntax
description: >-
  Convert one module from the old ***plain syntax - functional specs as `- `
  bullets, acceptance tests nested under them - to `# <func-id>` headings and
  test plain files, word for word, the ids confirmed by the person first. Use
  when turri says a module is in the old ***plain syntax, or the person asks to
  convert one. One run converts one module, the lowest of the chain first;
  it never regenerates.
allowed-tools: [read, ls, grep, find, change_plain, validate]
metadata:
  phases:
    ids: "a func-id for each functional spec and a scenario-id for each acceptance test, proposed and confirmed"
    rewrite: "the module and its test plain files, in one ***plain diff, word for word"
    check: "validate, and which module is next"
  gates:
    - after: rewrite
      review:
        rubric: ./references/rubric.md
        judges: 2
        quorum: all
        on_fail: retry
        max_retries: 2
        judge_tools: [read, ls, grep, find]
---

# Convert Old Syntax

Moves one module from the old ***plain syntax to the new one: each functional spec a `# <func-id>` heading with its body, and its acceptance tests in its test plain file. Nothing is reworded, added or dropped, and nothing is regenerated. The chat runs it again for the next module, asking the person in between.

## Steps

### ids

**Which module.** Convert one module in this run. When the person named one, start at the lowest module of its `requires` chain still in the old syntax - the first, from the bottom of the chain, whose functional specs are `- ` bullets - which may be the one they named. Read the modules of the chain as text to tell: a module in the old syntax has `- ` bullets right under `***functional specs***`, or `***acceptance tests***` nested in it, and no `# <func-id>` heading. Skip import modules, which have no functional specs, and the standard library's templates (`stdlib/...`): there is nothing in them to convert. When every module of the chain is in the new syntax already, change nothing: say so, and that the run is done.

**Read the module as text,** with `read` - the parser refuses the old syntax, so `validate` cannot read it yet. Change nothing in this step.

**Propose the ids:**
- A func-id for each functional spec - each top-level `- ` bullet under `***functional specs***`: short kebab-case from what it means (`add-task`), lowercase letters, digits and hyphens only, unique in the module (`semantic-ids.md`)
- A scenario-id for each acceptance test nested under one, the same way from its text, unique among that functional spec's acceptance tests

Ask the person once, with `ask_user`: the whole list in its `context` - each func-id with the first words of its bullet, and under it each scenario-id with the first words of its acceptance test - and options to accept the list or change ids. When they change some, apply the changes and ask again with the new list, until they accept it. Ask nothing else.

### rewrite

Write the whole conversion as one `change_plain` diff, with the confirmed ids:

- **The module.** Under `***functional specs***`, each bullet becomes its `# <func-id>` heading followed by its body: the bullet's text without its leading `- `, word for word. Its sub-bullets become `- ` bullets under that text, one level less indented, word for word and in the same order. Its nested `***acceptance tests***` are taken out of the module. The functional specs keep their order, one blank line between them. The frontmatter, every other section, the comments and any Liquid stay exactly as they are.
- **Its test plain files,** one for each functional spec that has acceptance tests, at `tests/<module>/<func-id>.plain`: frontmatter `module:` (the module's file name without `.plain`) and `func_id:`, then `***conformance tests***`, then `***acceptance tests***` (`test-plain-files.md`). Each acceptance test of the functional spec becomes a scenario under `***acceptance tests***`: its `# <scenario-id>` heading followed by its text without its `- `, word for word, and its sub-bullets as `- ` bullets under it. `***conformance tests***` stays empty. A functional spec with no acceptance tests gets no test plain file: it has no scenarios.

Nothing else: no word added, reworded or dropped, no conformance scenario, no fix to the ***plain however clear it seems. What the conversion shows to be wrong goes in the result, for the person to decide on later.

The change regenerates nothing: a module built before func-ids is not built on until its chain is regenerated from scratch, which the chat asks the person for.

The record for the review: the module as it was before the change, word for word as you read it; the confirmed ids; and every file the change wrote. When the review sends the step back, show the person what it found and your fix with `ask_user`, then write the fix with one `change_plain`.

### check

Run `validate` on the module and show what it says in your reply.

When it reports an error the conversion made, show it to the person with `ask_user`, with the fix, and write the fix with one `change_plain`; then run `validate` again. An error the module had before the conversion stays for the person.

End with the result:
- the module converted, its functional specs and scenarios counted, and the files written
- what `validate` said
- the next module of the chain still in the old syntax, for the chat to convert with this skill again - or that the chain is done
- that nothing was regenerated: once the whole chain is converted, its code in `plain_modules/` was built when functional specs were numbered, and the chain has to be regenerated from scratch - only with the person's go
