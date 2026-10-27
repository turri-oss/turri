---
description: How turri regenerates the code from a spec change - by spec diff, in the chain's tip - what each kind of change sets off, what a coding agent sees, how bad code is fixed and where the cost really is, so a spec is placed and written by what it means, never by a guess at what regenerating it costs
---

# How turri regenerates the code

The other rules say what a spec means. This one says what turri does with a change to it, so that where a change goes, and how it is made, is never decided by a wrong idea of how turri works. Each section ends in the same place: decide by what the spec means.

## A change is regenerated as a spec diff

- turri regenerates the code from spec diffs: what changed between the spec the code was built from and the spec now
- A functional spec added, changed or taken out is that change alone, wherever it sits - first, in the middle or last of its module
- A functional spec is known by its module and its func-id, `<module>:<func-id>`: the specs around it are not regenerated because their position moved, and nothing after it is built again. A spec inserted in the middle is one addition; one moved to another place with its text as it was is no change at all
- A func-id renamed is a functional spec taken out and another added: its code is removed and built anew. Keep a func-id once it is built, and change the text under it
- Code built before functional specs had func-ids is never built on: its whole chain is regenerated from scratch, never done without the person agreeing
- "Specs render top to bottom, each knowing only the ones before it" is about what a spec may assume (`func-specs.md`), not about what a change costs

## A change is regenerated in the chain's tip

- A chain's code lives in its tip - the furthest module built on it. The modules below it keep the code they were built with
- A change to any module of the chain, the base's included, is regenerated in the tip's code - not in the module the change was made in
- A functional spec of a module below is added, patched or taken out in the tip just as the tip's own are, named `<module>:<func-id>`. Its conformance tests are in the tip's suite too, and are kept up to date there
- Putting a change in a lower module costs no more than putting it in the tip, and saves nothing either
- Moving specs between modules of the chain renders nothing. Moving specs into a module the code was never built on is the exception: no change to the code brings that module in, so the chain has to be regenerated from scratch - never done without the person agreeing

## What each kind of change sets off

- A functional spec added is built, with its unit tests; one changed is patched in place; one taken out has its code, and the tests only it had, removed
- A definition changed patches every functional spec of the chain that uses its concept, directly or through other definitions - a module below's as well as the tip's own. So does a change to a linked resource: the spec or definition linking it is changed though its text is not. A widely used definition is the costly edit - not a spec's position
- Implementation reqs alone, or definitions no functional spec of the chain uses, are a mechanical change: the code adapts, and no test is written or changes what it asserts
- Test reqs and scenarios - a functional spec's conformance and acceptance scenarios, in its test plain file - reach the conformance tests only, never the code. A scenario changed alone regenerates no code
- A functional spec regenerated again by name has its code taken out and built anew - never left as it was, even where it already does what the spec says; a pulse that changes nothing does not land. Its conformance tests, when it has them, are run on its new code once it lands: those that pass are kept as they are; one that fails is judged against the spec - what it checks that the spec leaves open, a path, a field, a message the old code chose, goes by the new code
- What is conformance tested is the scenarios: each conformance and acceptance scenario of a functional spec gets at least one test, and nothing else is tested - a functional spec with an empty test plain file has no conformance tests. Its tests are written or changed once its code lands, whenever a scenario is added, changed or taken out, its text changes, it is regenerated again or taken out; one whose scenarios are all taken out loses its tests. It goes scenario by scenario, by scenario-id: a scenario added gets its tests, one changed has them rewritten, one taken out loses them, and an unchanged one keeps them - run on the new code when the functional spec's code changed. A scenario-id renamed, or a scenario moved between conformance and acceptance, is one taken out and one added. To have something checked end to end, write it as a scenario
- Definitions moved to a common module and reqs reordered are recorded, not rendered
- A functional spec written on its happy path and hardened later - its validation, edge cases and errors added to it - is patched in place each time: growing a spec a step at a time costs no more than writing it whole up front
- A module's first pulse, when it builds one functional spec - the project set up and the smallest thing that runs - lands on its unit tests with no review

## What a coding agent sees

- A coding agent sees its prompt and its module's code - nothing else. It cannot read `.plain` files, this conversation, AGENTS.md or the person. It never sees a functional spec's scenarios: those are the conformance tests'
- What the code needs to know has to be in the spec. A fact said only in the conversation, AGENTS.md or notes never reaches the code, and is lost at the next regeneration
- Steering reaches the agents that plan the work - how it is cut and in what order - not what the code does. What the code does is changed in the spec

## How bad code is fixed

- Never edit the code under `plain_modules/`: the next regeneration does not keep it, and the code record no longer says what the code is
- In order of cost: change the spec where it is wrong or silent; regenerate the functional specs whose code went bad again, by name; regenerate the module from scratch, or its whole chain - only when the person asks for it or agrees to it
- Pulses regenerate in the background: the spec can be changed while they run, and need not wait for them. A change inside what a running pulse regenerates steers it; the rest is planned again around it
- A pulse that does not land is rolled back whole - code, tests and record together - and its module waits until the spec changes or the module is asked for again. Running it again unchanged usually ends the same way: look at why it did not land first
- A finished pulse goes to the sentinel, a chat of turri's own - unless `sentinel: false`; under `sentinel: ask`, the default, only once the person said to start it, asked by turri before it first opens in a session (declined, a pulse goes to the chat that asked for it, as with `false`): it checks the pulse, tests what was released, and puts what is wrong to the person as a notice with what can be done. A pulse that landed is told to the chat the person is in too, only to say it landed and what the sentinel does with it, and when the sentinel is done with a pulse, what it found - the chat does nothing else about either; a pulse that went wrong is not told to it - the chat's agent is given a notice's task once the person accepts it, and does that

## Where the cost is

- The cost is the work regenerated: how many functional specs a change touches, directly or through the definitions they use, cut into pulses of at most `max-specs-per-pulse`
- Regenerating functional specs again, or a module or chain from scratch, costs most, and is only ever asked for outright
- Placement never adds cost. Put a functional spec in the module that owns the concern, at the point in its order where what it relies on has been said; never at the end of a module, or in the tip, only to spare regeneration - it spares none
- Never write placement for cost into AGENTS.md, a skill or notes: what is written there is read back later as how the project works
