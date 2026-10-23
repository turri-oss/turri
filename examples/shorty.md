# A backend service, tested as it grows: shorty

You will build **shorty**, a URL shortener: an HTTP API that turns a long URL into a short code, and redirects anyone who opens the code. It starts with only that, and grows click counts, expiry and a list of your links while it regenerates. It has conformance tests from the first feature: black-box tests that start the service and call it over HTTP. They are written for each feature once its code is built, and the whole suite runs again each time more lands, so nothing that worked before quietly breaks.

Build it on any backend stack your machine can build - Python, TypeScript, Go, Rust or Java.

```bash
mkdir ~/shorty && cd ~/shorty
turri init-config
turri
```

## 1. The smallest thing, with conformance tests

> Let's build shorty, a URL shortener API, with conformance tests. To start: `POST /links` with `{"url"}` returns
> a 7-character code, letters and digits, and `GET /<code>` redirects to the URL. Keep the data in SQLite.

**turri** writes `shorty.plain` importing a backend stack from the standard library, and its unit testing script. Because you asked for conformance tests, it also writes the module's test reqs - the stack's conformance template, `stdlib/backend/conformance/<stack>` - and the conformance testing script, and puts `conformance-tests: true` in `config.turri.yaml`. Then it starts regenerating the first functional spec.

## 2. Two tracks

Each module is regenerated on two tracks:

- **Code.** The functional specs are regenerated into code that passes its unit tests.
- **Conformance.** Once the module's code is built, the conformance tests are written for what was built, and the whole suite runs.

So as long as you keep adding features, the code goes first. Each time the code catches up with the \*\*\*plain, the conformance tests catch up with the code.

## 3. Grow it while it regenerates

Say the next features one after another, without waiting:

> Opening a code counts the click. `GET /links/<code>` returns the link with its click count.

> A link can be given `expires_at`. After that time, `GET /<code>` returns `410` and the click is not counted.

> `GET /links` lists all links, newest first, each with its click count.

Each is a \*\*\*plain change, planned behind what is already regenerating. When the code for one lands, the conformance tests for it are written, and every conformance test written before runs with them. A test for the redirect from step 1 that fails after the click counts land means the click counts broke the redirect, and it is caught then, not later.

## 4. When a conformance test fails

A failing conformance test is not simply made to pass. A judge first works out what is wrong: the code, the test, or the \*\*\*plain. The code or the test is fixed. When two functional specs contradict each other - a counted click on an expired link, say - the pulse stops, and **turri** tells you in the chat which two, so you decide which one holds.

## 5. Try it

Each pulse that lands is released and running. Ask where:

> Where is shorty running?

Then make a link, with that address for `$SHORTY`:

```bash
curl -s -X POST $SHORTY/links -H 'Content-Type: application/json' -d '{"url": "https://example.com"}'
curl -si $SHORTY/<code>
```

## 6. Change a rule

> Codes should be 6 characters, not 7.

This is a change to a rule, not a new feature. Every functional spec that uses it is regenerated again with it, and their conformance tests are written again for the new text. The rest of the suite runs too, so you know the shorter codes did not break expiry or the click counts.

## Try it: regenerate from scratch

The \*\*\*plain is the software; the code is just one regeneration of it. Delete shorty's code and conformance tests, and regenerate both from the \*\*\*plain alone - every feature you added along the way, built again from the start:

```
/regenerate shorty from scratch
```

It starts at once, and the code it deletes stays in `/lineage`. The new code will not be the same code, but it does what the \*\*\*plain says - and its conformance tests, written again too, show it.

## Where next

- [Regenerating](../docs/regenerating.md#conformance-tests) - what a conformance pulse does, step by step.
