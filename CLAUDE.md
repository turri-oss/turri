# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This repository is `@turri-dev/cli`: the command line and the terminal for turri. `@turri-dev/core` owns the session, work loop, agents, sandbox, parser, genome and standard library; the terminal is one front end of its session (`../turri-core/docs/core.md`). See `docs/development.md` for the package boundary, linked development and release checks. Behavioural docs in `docs/` describe the installed CLI; a harness change belongs in turri-core with its tests and rules.

## Commands

```bash
npm ci                                  # released, pinned core
npm run link:core -- ../turri-core       # local core instead (npm ci in the core first)
export NODE_OPTIONS=--conditions=turri-source   # only with a linked core
npm run typecheck                        # src/ only
npm test                                 # CLI and terminal - no model
npx vitest run tests/chat-terminal.test.ts
npm run chat                             # terminal, straight from src/
npm run test:package -- ../turri-core    # both tarballs, installed outside the checkouts
```

## TypeScript runs unbuilt

`bin/turri.mjs` checks for Node >= 22.19 and imports `src/cli.ts` directly. Node's own type stripping runs the sources and nothing compiles them - except for the npm package, where Node will not strip types inside `node_modules`: `npm run build` compiles `src/` into `dist/` file for file, and `bin/turri.mjs` runs `dist/cli.js` when there is no `src/`. So:

- imports use explicit `.ts` extensions;
- don't use syntax that type stripping can't erase: parameter properties (`constructor(readonly x: T)`), `enum`, `namespace`. Declare the field and assign it in the constructor. Other TypeScript runners can accept these, so they only fail when run through `turri`.

## Linux, macOS and Windows

turri is developed for all three, as equals: no code assumes the OS it is written on. Where the OSes differ, the code asks Node (`node:path`, `node:os`, `process.platform`) rather than hard-coding one's answer, and what only one OS has - Seatbelt, bubblewrap, process groups - is behind a check for it, with what the others do instead said beside it. On Windows, bash is Git Bash.

- **A path on disk** is built and taken apart with `node:path` - `join`, `resolve`, `dirname`, `basename`, `relative`, `sep` - never with `/` in a template string, `+ "/"`, or `split("/")`.
- **Inside a folder** is `isWithin(path, root)` (`regenerate/paths.ts`), never `startsWith(`${root}/`)` or `relative(...).startsWith("..")`: a Windows path does not start with `root/`, and one on another drive gives `relative` an absolute path.
- **A name, not a place** - a file of a codebase, a .plain file in a diff, anything compared with git's paths or the parser's - is written with `/` on every OS: `slashed(relative(...))`, and `posix.join` to build one. `listFiles` gives codebase files so. Git pathspecs and refs, `stdlib/...` imports and `provider/model` ids are such names.
- **A path handed to bash** - a testing script's arguments, a `bash -c` script's - is `slashed`: Git Bash's tools may read a backslash as an escape (GNU tar took the `\a` of `C:\Users\anton` for a bell). Better still, give the tool no path at all: run it with `cwd`.
- **Lists of paths** split on `delimiter` (`;` on Windows), never `":"`; temporary folders come from `tmpdir()` and the person's home from `homedir()`, never `/tmp` or `process.env.HOME` (unset on Windows outside Git Bash).
- Test OS-specific behaviour on each platform it reaches. Core path handling and its Windows-specific tests live in turri-core.

## Architecture

Import the core through its five public entries alone: `@turri-dev/core` (the session, its events and data), `/plain`, `/project`, `/models` and `/system` - never its `src/`. Every entry but `/plain` loads pi: what runs before pi loads (`cli.ts` on the chat's path, `cli-root.ts`) imports none.

`src/cli.ts` and the `*-cli.ts` files own arguments, console output, prompts, signals and exits. `regenerate`, `conform`, `launch` and `cultivate` open a session with no front end (`createTurri()`, the options that name config keys as its `overrides`) and print from its events; `drift`, `parse`, `lineage`, `init-config`, `capture` and `doctor` call `/project` and `/system`.

`src/pi-launch.ts` opens one `createTurri({ frontend, client, overrides })` per process, before pi's `main`, and builds `turri.extension` into pi; `src/extension.ts` is what pi loads when it is given turri's file, and finds that session. The terminal's `Frontend` is `src/terminal-view.ts`, its chats made on pi's runtime by `src/chat-terminal.ts` (`sessions: external`), whose prototype patches hold several chats on one screen. Keep the front end about presentation: read the session's events and methods rather than reproducing its decisions here. What the CLI needs and the core does not offer is marked `// core-gap:` where it is worked around.

turri-app builds on the core directly; this package exports nothing for it.

## Testing patterns

Run the CLI without a model when possible: parse a small project, inspect its drift or exercise the real CLI in a temporary folder. Terminal tests open a real session with the terminal as its front end (`tests/terminal-session.ts`), on stand-in pi sessions, use pi's installed classes, render the components and drive their keys. What the core decides is tested in the core; here, what the CLI draws and does with it. Never reach into a core checkout's private files to test the CLI.

## Conventions

- The name is always **turri**, lowercase, even at the start of a sentence. \*\*\*plain is written `***plain` (escaped in Markdown).
- Prose in docs, comments and user-facing strings uses British spelling (behaviour, organised) and a spaced hyphen ` - ` rather than an em dash. Test names are sentences about behaviour (`it("renames a clashing file instead of overwriting it")`).
- When behaviour changes, update the `docs/` page that describes it in the same change.
- In turri-core, `genome/rules/turri-regeneration.md` is turri's model of itself for every agent that writes specs: what a spec change regenerates and where, what a coding agent sees, how bad code is fixed. When any of that changes, update the rule in the same change too - a stale one is worse than none, the agents reasoning from it with confidence.
- Commit messages follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/): `<type>[optional scope]: <description>`, then an optional body and optional footers, each after a blank line.
  - **type:** `feat` for a new feature, `fix` for a bug fix; otherwise `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `style` or `revert`.
  - **scope:** optional, the part of turri it touches, in parentheses - `feat(stacks):`, `fix(regen):`, `docs(config):`.
  - **description:** lowercase, says what the system now does rather than what was edited, and carries no full stop.
  - **body:** the why and the details, when the subject alone does not say enough.
  - **breaking changes:** a `!` before the colon (`feat(config)!: ...`), or a `BREAKING CHANGE: <what changed>` footer - for example, a behaviour existing projects relied on that is gone.
  - Commits before this convention (see `git log`) are one long lowercase sentence; new ones are not.

## turri-app

turri-app, the desktop host (`../turri-app`), is read-only from here: read and grep it to see what a change reaches, and write nothing there - no file, no command that changes it. Whenever a change in turri must be reflected in turri-app, use the `turri-app-prompt` skill and ask the person to paste the prompt it writes into an agent session in turri-app.
