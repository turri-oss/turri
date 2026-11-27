# Developing turri's CLI

This repository publishes `@turri-dev/cli`: the `turri` command, the terminal and the compatibility entry for [desktop hosts](hosting.md). [`@turri-dev/core`](https://github.com/turri-oss/turri-core) owns the harness, agents, parser, genome and standard library. A change to how turri builds goes there; a change to how the terminal shows it goes here.

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

For the migration, use the core with `/cli-compat`. A checkout of the core before that entry was added cannot serve the old desktop host API.

## Checking a change

`npm test` runs the CLI and terminal suite without calling a model. `npm run typecheck` checks `src/`; with a linked core it follows the `turri-source` condition. To run one file: `npx vitest run tests/regenerate/jobs-tree.test.ts`. The harness suite and mutation tests run [in the core](https://github.com/turri-oss/turri-core/blob/main/docs/development.md).

`npm run build` compiles the CLI against the core's built declarations. On an unbuilt core checkout, run its `npm run build` first. `npm run test:package` installs the packed CLI in a temporary project and runs its commands and a desktop host against it. Pass the core checkout to pack and install both packages, including before the core version is published:

```bash
npm run test:package -- ../turri-core
```

## Layout

| Where | What it owns |
| --- | --- |
| `bin/turri.mjs`, `src/cli.ts`, `src/*-cli.ts` | Node checks, argument parsing, command dispatch, printing and exit status. `loop-cli.ts` renders the `HeadlessView` for `runHeadless`. |
| `src/cli-root.ts`, `src/pi-launch.ts`, `src/extension.ts` | Set the CLI's root in each process, prepare terminal images and build the CLI's view into pi's session. The banner and themes come from this package; the genome comes from the core. |
| `src/terminal-view.ts`, `src/banner.ts`, `src/entry-renderers.ts` | The `TurriView` hooks, welcome screen and transcript rendering. |
| `src/panel-view.ts`, `src/regenerate/*-view.ts`, `src/regenerate/jobs-tree.ts` | The side panel: regen, pulses, notifications and keyboard focus. |
| `src/chat-*.ts`, `src/pi-settings.ts`, `src/skill-progress.ts`, `src/capture-view.ts` | The terminal's chat driver, tabs and keys, settings menu and progress widgets. |
| `src/host.ts` | The legacy `@turri-dev/cli/host` API, backed by the same core session and pi peer. |

## Publishing

The compatible core version must be available on npm before releasing the CLI. Pin that version with npm and keep its lockfile resolution. The CLI's `prepack` builds `dist/`; the package includes the CLI's assets, themes, launcher and docs. The core is a normal versioned dependency.

The typecheck, suite and packed consumer check run in `.github/workflows/test.yml`. `.github/workflows/publish.yml` uses npm trusted publishing: a push to `main` publishes a prerelease under `next`; a GitHub release tagged `vX.Y.Z` publishes that version under `latest`, or `next` for a prerelease. See [contributing](../CONTRIBUTING.md) for the commit checks.
