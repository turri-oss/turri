# Gather the features into modules

The part's ***plain is a chain of modules. Below is every feature of the part, area by area in the order of the code, with what it owns, the first line of each functional spec and its scenarios - and the modules as the code's areas make them, gathered by size alone. Gather the features into modules by concern, and put the modules in the order they are built. Call `submit_capture_modules` once.

## A module is a concern

A module is what a person looks for in one file: a command-line tool's request sending, its output formatting, its sessions, its downloads, its plugin manager; a backend's accounts, its orders, its payments. One module that holds everything is as hard to read as the code, and every change to it regenerates all of it; a concern split across modules is read in pieces.

- `modules`, each with a `name` - short kebab-case, the concern - an `about` line, and its `features` by key, in the order its functional specs are written. Every feature is in one module.
- A module of one feature is right when that feature is a concern of its own. Put a feature with another only when it is part of that concern - never to make a module larger.
- A concern too large to read in one file - past about 40 functional specs - is two modules, each a part of it.
- The areas are folders of the code - often a concern each, never binding: a module may take features of several areas, and an area's features may go to several modules. Where the code's areas are concerns already, keep them.

## The order they are built in

Each module is built on the code of the modules before it, and its conformance tests - its scenarios - run as soon as it is built, with nothing after it there. A module whose scenarios send a request, print a response or save a session needs the module that does that before it: built earlier, its scenarios cannot pass, and its coding agent invents what a later module captures.

The areas are in the order of the code's imports, which is not that order: the code that runs everything imports everything, yet everything else needs it built first - a command-line tool's request sending before the output formatting that prints what it answers, a backend's routes before the middleware that wraps them. List the modules in the order they are built: the core flow first, what extends it after.

- `needs`: for each module, the modules before it whose behaviour its functional specs build on and its scenarios run - the module where the command, the route or the screen its scenarios use does what they rely on. A scenario that runs a command needs the module that makes the command do it, not only the one that names its options.
- `rewrites`: a scenario that needs a module after its own whatever the order - two modules whose scenarios each need the other - is rewritten so it checks what it checks with only the modules before it: a scenario of output formatting that follows a redirect checks the formatting of a plain response instead. Its feature's key, its functional spec's func-id, its scenario's id, its whole new text, and `why`: the later module it needed. None when none: most orders need no rewrite. Never merge two modules to spare a rewrite.

You see the ***plain, not the code: decide from what each feature does and what its scenarios run.

Prefer the order that preserves the original observations. In particular, a test of the effect of an option must not become a test that the option is merely accepted. A test of one named failure must not become a test of a different failure that happens to share its exit code. Put the consumer after the features needed to demonstrate the original outcome. When choosing between a neat ordering and an exact observable contract, keep the contract.
