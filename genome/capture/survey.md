# Survey the codebase

You start the capture: from the map of the whole codebase, its manifests and its docs, you say what the software is built on and how it divides into parts, you settle the conventions every feature follows, and you write what every part's ***plain shares. Call `submit_capture_survey` once, with all of it.

## Parts

A part is software on one stack: a backend, a frontend, a command-line tool, a library. Most codebases are one part. A codebase with a Python backend and a React frontend is two - each captured as a chain of modules of its own, built and tested with its own toolchain. Two parts never share a folder.

- `name`: short kebab-case, what the part is - `api`, `web`, `cli`, or the product's name when there is one part.
- `paths`: the folders and files that are the part, relative to the codebase - `.` for the whole of it when there is one part.
- Leave out what is not the software: vendored code, generated code, build and deployment tooling, editor settings, the docs themselves - each in `left_out`, with why. A part's own tests are part of it, never left out: they are the evidence of what it does.

## The stack

The parts are captured on the stack they are on now - the same language, framework, storage and main libraries, with their versions from the manifests.

- `stdlib_stack`: turri's standard library has templates that settle a stack (the catalogue is below). Read the one that matches. Name it only when the original agrees with it - its framework, its layout, its libraries - since everything in it becomes a requirement. When it contradicts the original anywhere that matters, name none, and write the stack in `implementation_reqs` instead.
- `stdlib_conformance`: true to import the stack's conformance template too - when you named a stack that has one and the original's black-box tests, if it has any, run the way it says.
- `implementation_reqs`: how the part is built, one fact a line, without the `- `: the language and its version, the framework, storage, the libraries that shape behaviour or architecture - an ORM, an outside service such as a payment provider - and how it starts. Write :Implementation: as the subject. Not what a named `stdlib_stack` says already; not utility libraries. When the original has unit tests, how they run - their framework - with :UnitTests: as the subject.
- `test_reqs`: how the black-box conformance tests run, with :ConformanceTests: as the subject - the framework, how they reach the software (start the server and call it over HTTP, run the command, drive the page). Take it from the original's own black-box tests when it has them, and from how they run the software: read their harness - fixtures, helpers, `conftest` - for what standard input is (a terminal, empty, piped), the environment and the servers they start, and say it. A conformance test run any other way tests another program: a command that reads piped standard input as its body acts differently when its tests give it none.
- Then what every test sets up so the software acts the same on every run and every machine - read the code for what would otherwise vary: whatever it fetches or checks on its own - an update check, telemetry, a remote configuration - turned off, or pointed at a local stand-in; a home and a configuration folder of the test's own, empty unless the test fills them; the terminal width fixed (`COLUMNS`) where its output wraps or cuts to it; a pseudo-terminal where it prompts on one - a password - or acts otherwise on one; the servers it talks to started locally, never the internet. Each as one fact, with how: the variable and its value, the file and what it holds. Leave `test_reqs` empty only when the conformance template you named says it all.

## Conventions

`conventions`: what every feature of a part does the same way and a user or a script relies on, settled here once - the agents that capture each feature follow them, and never decide them again. Four agents each deciding a command's exit code on a usage error decide it differently. For a command-line tool: how an error is written - the stream, its exact form - the exit code of each kind of failure (a usage error, a failed request, a timeout, Ctrl-C), and what changes when standard input or output is not a terminal. For a backend: the error body, the status of each kind of failure, what every request needs. For a frontend: how errors and loading show.

For software that talks to other software - a client that sends requests, a server that answers them, a tool that writes files another program reads - also what reaches the other side, exactly, whichever feature makes the call: the headers it adds of its own and when (`User-Agent`, `Accept`, `Content-Type`, `Content-Length`); how a body is encoded - JSON's separators and whether non-ASCII is escaped, the charset, a form's encoding; how a header's value is encoded and trimmed; when a body is sent or read whole, streamed, or not read at all. No feature's writer looks at the wire; the other side sees it on every call.

- Settle each from the code that does it: follow the entry point to where it catches errors and exits, and read what it does there. A declaration is no evidence - an enum lists codes the code may never use - and neither is a framework's default the entry point changes: argparse exits 2 on a usage error unless the program catches it and exits otherwise.
- One fact a line, without the `- `, exact: the stream, the text, the code. In `where`, the files whose code decides it.
- Only what the stack you named does not say the same way: where the original departs from it, or what it leaves open.

## Concepts

`definitions`: the core concepts of each part's domain - what its data model, its tables and its screens are about: `:User:`, `:Order:`, `:Invoice:`. Each is one plain sentence that starts with the concept and says what it is, with its attributes when they matter to what users see. Only those used across the software; the agents that capture each feature define their own. Concept names are CamelCase between colons, and never one of the predefined ones (:Implementation:, :UnitTests:, :ConformanceTests:, :AcceptanceTests: and the rest).

Every concept your bullets use must be one of yours or a predefined one. Two definitions never name each other - `:Link:` naming `:LinkCode:` and `:LinkCode:` naming `:Link:` is a circle ***plain refuses: the one built on the other names it, and that one names nothing back.
