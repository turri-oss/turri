# Capture a feature

Capture one feature of the codebase into ***plain: its functional specs, the concepts they need, and their scenarios. Agents capture the other features side by side; the features before yours in the outline are built before it. Call `submit_capture_feature` once.

## What is yours

Every feature of the part is listed with what it owns: each behaviour is one feature's. Capture all that yours owns - also where its code is in files you were not pointed to. Never capture what another feature owns, even where your code or your tests touch it: it is captured there, and your functional specs build on it, naming it at most. When your tests check another feature's behaviour along with yours, your scenarios check yours.

The part's conventions are settled: how errors are written, the exit code or status of each kind of failure, what changes without a terminal, what reaches the other side of a call. Every functional spec and scenario follows them; none decides them again. Where your feature departs from one, capture the departure.

## First, find out what it does

Start at the feature's paths and its surfaces. Follow each route, command or screen to what it does and what the user sees: the inputs it takes, what it answers or shows, what it refuses and how, what it keeps. Read the original's tests of the feature: what they assert is what someone cared about. Then stop reading and write from what you found out - never while reading code, never line by line.

## Then write the functional specs

- At most eight functional specs, in build order - each only builds on those before it, here and in the features before yours.
- `func_id`: short kebab-case from what it does (`add-task`), unique in your feature.
- `text`: what the software does once built, as a statement of fact with a concrete subject - `A :User: can archive a :List:.` - its first line the behaviour, then the detail that matters: inputs, outputs, boundaries, and the errors the stack does not settle. No line starts with `# ` or `***`.
- Each implies about two hundred lines of code at most: a larger one is two functional specs.
- The interface your feature owns, whole and exact. The interface in your files is listed - from the part's interface reference when it has one: taken from the code, every literal checked against it, and carried by every functional spec that uses the part's interface concept (`:<Part>Interface:`). Capture what each piece your feature owns does, by its exact name, using the concept; what it takes, its choices, its default and its help are the reference's - say them only where a behaviour turns on them, and never otherwise than it does. With no reference, capture each exactly yourself: every name it has, what it takes, its choices and default, what it does and what it answers - an endpoint's method, path, fields and status codes; a command's arguments and output; a message's exact text; a file's format. A client of the original must work against the code regenerated from your ***plain, call for call. Read each where it is defined - never from its name, its help text or what the stack would do.
- Everything else: as short as its facts allow. Leave out what a competent developer would build anyway on this stack, and anything only the code knows - never the interface.
- Nothing the stack says: what its templates and implementation reqs settle - settings, logging, request ids, error bodies, how it starts - is built already. Capture only where the original departs from them. A stack settles how; which options, routes and commands exist, and what each takes and answers, is always yours to capture.
- The rule, never its cases. A functional spec says what is refused - `The url is an absolute http or https URL with a host.` - and the stack says how: what invalid input, a missing record or no access answers, its status and its error code. So neither an example (`nope`, `ftp://example.com`) nor what one wrong input answers is a line of the functional spec: each is a scenario of it. Only a refusal the stack does not settle - a status or an error code of the original's own - is written in the functional spec, once, with its rule.

## Scenarios

A functional spec gets scenarios - `conformance` for its expected use, `acceptance` for use that is not expected: wrong input, a missing record, no access.

- **Where the original tests it.** The original's black-box tests are your evidence and your model: a test that runs the software through its interface - an HTTP call, the command run (in a process of its own or the test's), a page driven - is captured as a scenario that does what it does, with its values. A test that calls a function or a class directly is not. Spend your scenarios where the original's tests are densest: a functional spec it tests twenty ways gets several, one it tests once gets one, and error cases get no larger share than the original gives them. A functional spec the original tests through its interface never goes without a scenario.
- **Where it does not,** a functional spec gets scenarios only when a wrong implementation would give output that looks right, when two readings of it give different outputs, or when a bug in it costs money, security, data or users' trust.

Each scenario: a `scenario_id` in kebab-case, unique for its functional spec; one concrete, checkable outcome with concrete values (`named "Buy milk"`, `answers 404`); acting only through the interface; never more than its functional spec says. No more scenarios in all than your budget says - it grows with the original's tests of your feature.

A scenario runs as the part's test reqs say, so it expects what the original does then: its output is not a terminal unless they give it one - a scenario about colours passes the option that forces them; it talks to a local server, never a site on the internet; its width, its configuration and its home are the test's. A unit test of the original that mocks a library or calls a function is not a scenario recast: check its behaviour through the interface, or leave it out. What only your scenario needs set up - a file it sends, a session it starts from, a server that answers one exact body - it says itself: the test reqs are what every test of the part sets up.

Each feature's scenarios are tried on the original before the ***plain is written, and one the original fails is corrected - but write each to hold the first time.

## Concepts

Use the concepts you are given - the part's core ones - and the predefined ones. Define a new one in `definitions` only when your specs need a name the given ones do not have: one plain sentence that starts with the concept. Never define a given or predefined one again. Every concept in your specs, scenarios and definitions must be given, predefined or yours, and no definition names a concept whose definition names it back.

## Say what you decided

`assumptions`: what you decided where the code left it open. `uncertain`: what you captured without being sure of it. `dropped`: behaviour you judged incidental and left out. One line each; empty when there is nothing.
