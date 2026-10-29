# A backend service, tested where it matters: shorty

You will build **shorty**, a URL shortener: an HTTP API that turns a long URL into a short code, and redirects anyone who opens the code. It starts with only that, and grows click counts, expiry and a list of your links while it regenerates. You never ask for tests. **turri**'s test advisor looks at each functional spec as you add it and decides whether it needs conformance tests - black-box tests that start the service and call it over HTTP. When one does, the chat writes its scenarios, and the tests are written once its code is built. The whole suite runs again each time more lands, so nothing that worked before quietly breaks.

Build it on any backend stack your machine can build - Python, TypeScript, Go, Rust or Java.

```bash
mkdir ~/shorty && cd ~/shorty
turri init-config
turri
```

## 1. The smallest thing

> Let's build shorty, a URL shortener API. To start: `POST /links` with `{"url"}` returns a 7-character code,
> letters and digits, and `GET /<code>` redirects to the URL. Keep the data in SQLite.

**turri** writes `shorty.plain` importing a backend stack from the standard library, and its unit testing script, and starts regenerating the first functional spec. It says in a line that testing scenarios are being evaluated for it: nothing waits for that.

## 2. What needs testing, decided for you

Not every functional spec needs conformance tests - only the ones where a mistake would matter. The test advisor decides, in the background, while the code regenerates. It asks four questions of each new or changed functional spec, and every yes needs evidence:

- **Could it fail silently?** A wrong implementation whose output still looks right - a code that redirects to the wrong link.
- **Can it be read two ways?** An input two reasonable readings answer differently - a URL with no `https://`.
- **Will it be built on?** Later features that depend on it.
- **Would a bug cost something?** Lost data, a security hole, users' trust.

A yes to the first, the second or the last means it needs testing. On a yes, the chat tells you and writes, as a \*\*\*plain change you see:

1. the module's test reqs - the stack's conformance template, `stdlib/backend/conformance/<stack>`
2. the conformance testing script
3. the scenarios, in `tests/shorty/<func-id>.plain`: the inputs the advisor picked, each with its expected output

You are never asked. Where the functional spec could be read two ways, the chat takes the reading most consistent with the rest of shorty, says which, and may write it into the functional spec too. On a no, a line says so - `shorty:list-links doesn't need testing scenarios` - and the unit tests are its regression protection.

Nothing interrupts you: a verdict that comes back while the chat is answering, or while you are typing, waits until it is idle.

## 3. Two tracks

Each module is regenerated on two tracks:

- **Code.** The functional specs are regenerated into code that passes its unit tests.
- **Conformance.** Once the module's code is built, the conformance tests are written for the functional specs that have scenarios, and the whole suite runs.

So as long as you keep adding features, the code goes first. Each time the code catches up with the \*\*\*plain, the conformance tests catch up with the code.

## 4. Grow it while it regenerates

Say the next features one after another, without waiting:

> Opening a code counts the click. `GET /links/<code>` returns the link with its click count.

> A link can be given `expires_at`. After that time, `GET /<code>` returns `410` and the click is not counted.

> `GET /links` lists all links, newest first, each with its click count.

Each is a \*\*\*plain change, planned behind what is already regenerating, and each is evaluated as it lands. Expiry is the kind of rule that gets scenarios - a link opened at exactly `expires_at` is a boundary two readers can disagree on - while a plain listing may well not. When the code for a feature with scenarios lands, its conformance tests are written, and every conformance test written before runs with them. A test for the redirect from step 1 that fails after the click counts land means the click counts broke the redirect, and it is caught then, not later.

## 5. Ask for it yourself

The advisor runs on its own, but you can ask too:

> Does expiry need tests?

The chat starts an evaluation and goes on - the verdict comes back to the chat. It asks on its own as well when something keeps going wrong: a functional spec the coding agent fails to get right is one where scenarios can say what it should do. And when you want tests the advisor would not write, just say so:

> Write conformance scenarios for listing links.

## 6. When a conformance test fails

A failing conformance test is not simply made to pass. A judge first works out what is wrong: the code, the test, or the \*\*\*plain. The code or the test is fixed. When two functional specs contradict each other - a counted click on an expired link, say - the pulse stops, and **turri** tells you in the chat which two, so you decide which one holds.

## 7. Try it

Each pulse that lands is released and running. Ask where:

> Where is shorty running?

Then make a link, with that address for `$SHORTY`:

```bash
curl -s -X POST $SHORTY/links -H 'Content-Type: application/json' -d '{"url": "https://example.com"}'
curl -si $SHORTY/<code>
```

## 8. Change a rule

> Codes should be 6 characters, not 7.

This is a change to a rule, not a new feature. Every functional spec that uses it is regenerated again with it. Their scenarios are kept in step in the same change - a scenario expecting a 7-character code now expects 6 - and their conformance tests are written again for the new text. The rest of the suite runs too, so you know the shorter codes did not break expiry or the click counts.

## Try it: regenerate from scratch

The \*\*\*plain is the software; the code is just one regeneration of it. Delete shorty's code and conformance tests, and regenerate both from the \*\*\*plain alone - every feature you added along the way, built again from the start:

```
/regenerate shorty from scratch
```

It starts at once, and the code it deletes stays in `/lineage`. The new code will not be the same code, but it does what the \*\*\*plain says - and its conformance tests, written again too, show it.

## Where next

- [The test advisor](../docs/test-advisor.md) - how it decides, what it keeps, and turning it off.
- [Regenerating](../docs/regenerating.md#conformance-tests) - what a conformance pulse does, step by step.
