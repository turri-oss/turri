# Developing turri's CLI

This repository publishes `@turri-dev/cli`: the `turri` command and the terminal. [`@turri-dev/core`](https://github.com/turri-oss/turri-core) owns the session, harness, agents, parser, genome and standard library; the terminal is one front end of its session, as a [desktop host](hosting.md) is another. A change to how turri builds goes there; a change to how the terminal shows it goes here. The CLI imports the core's five public entries alone - `@turri-dev/core`, `/plain`, `/project`, `/models` and `/system` - as [the core's interface](https://github.com/turri-oss/turri-core/blob/main/docs/core.md) describes them.

## Linked development

With a released core, `npm ci` installs the pinned version. To use a core checkout instead, install its dependencies there first (`npm ci`), then run this **in the CLI checkout**:

```bash
npm run link:core -- ../turri-core         # or the path to a core worktree
export NODE_OPTIONS=--conditions=turri-source
node bin/turri.mjs                        # the CLI and the core both run from src/
npm run typecheck
npm test
```

In PowerShell set `$env:NODE_OPTIONS = '--conditions=turri-source'`. The link helper also links the core's installed pi and pi-tui into the CLI: the terminal must patch the same pi classes that own its chats. It does not change either manifest or lockfile. `npm ci` restores the release dependencies once that version is on npm. Use the source condition only with a linked checkout: the npm packages ship compiled JS and declarations, not TypeScript sources.

## Checking a change

`npm test` runs the CLI and terminal suite without calling a model. `npm run typecheck` checks `src/`; with a linked core it follows the `turri-source` condition. To run one file: `npx vitest run tests/regenerate/jobs-tree.test.ts`. The harness suite and mutation tests run [in the core](https://github.com/turri-oss/turri-core/blob/main/docs/development.md).

`npm run build` compiles the CLI against the core's built declarations. On an unbuilt core checkout, run its `npm run build` first. `npm run test:package` installs the packed CLI in a temporary project and runs its commands there. Pass the core checkout to pack and install both packages, including before the core version is published - the clone is installed as the version the CLI pins, as its own package.json keeps the version it was last given:

```bash
npm run test:package -- ../turri-core
```

## Layout

| Where | What it owns |
| --- | --- |
| `bin/turri.mjs`, `src/cli.ts`, `src/*-cli.ts` | Node checks, argument parsing, command dispatch, printing and exit status. `regenerate`, `conform`, `launch` and `cultivate` open a session with no front end; `loop-cli.ts` prints a run from its events. |
| `src/cli-root.ts`, `src/turri-versions.ts`, `src/reopen.ts` | This turri: its identity for the core (`client`), its version line, update and PATH checks, and the handoff between `turri` and the chat process after a capture. |
| `src/pi-launch.ts`, `src/extension.ts` | Prepare terminal images, open the process's session before pi's `main` and build its extension into pi. The banner and themes come from this package; the genome comes from the core. |
| `src/terminal-view.ts`, `src/banner.ts`, `src/entry-renderers.ts` | The terminal's `Frontend` - what it shows, how it asks, its surface - drawn from the session's events; the welcome screen and transcript rendering. |
| `src/panel-view.ts`, `src/terminal-notifications.ts`, `src/regenerate/*-view.ts`, `src/regenerate/jobs-tree.ts` | The side panel: regen, pulses, the inbox of notifications and keyboard focus. |
| `src/chat-*.ts`, `src/pi-settings.ts`, `src/skill-progress.ts`, `src/capture-view.ts` | The chats on pi's screen (`sessions: external`), their stand-in UI while hidden, tabs and keys, the settings menu and progress widgets. |

## Publishing

The compatible core version must be available on npm before releasing the CLI. Pin that version with npm and keep its lockfile resolution. The CLI's `prepack` builds `dist/`; the package includes the CLI's assets, themes, launcher and docs, and exports nothing but its `package.json`. The core is a normal versioned dependency.

The typecheck, suite and packed consumer check run in `.github/workflows/test.yml`. While the core version the CLI pins is not on npm, that workflow checks out turri-core's branch with the interface the CLI is written against (`CORE_REF`), links it as linked development does and runs both from their sources; once that core is released and pinned, it installs it with `npm ci` alone. `.github/workflows/publish.yml` uses npm trusted publishing: a push to `main` publishes a prerelease under `next`; a GitHub release tagged `vX.Y.Z` publishes that version under `latest`, or `next` for a prerelease. See [contributing](../CONTRIBUTING.md) for the commit checks.
