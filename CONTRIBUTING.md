# Contributing to turri

Thank you for helping. turri builds regenerative software from [\*\*\*plain](https://plainlang.org/docs/), and it is open source under the [MIT licence](LICENSE). Bug reports, ideas and pull requests are all welcome.

## Reporting a bug or asking for something

Open an [issue](https://github.com/turri-oss/turri/issues/new/choose). For a bug, say what `turri --version` prints, your system, the provider and models your `config.turri.yaml` names, what you did, and what you saw. The \*\*\*plain that makes it happen helps most, and so does the pulse's log from a run with `--debug` - see [agent logs](docs/using.md#agent-logs).

A security problem is not an issue: report it privately, as [SECURITY.md](SECURITY.md) says.

## Where a change belongs

turri is the command line, the conversation and everything they know: the \*\*\*plain parser, the work loop and its agents, the sandbox, the skills and rules in `genome/`, the standard library in `stdlib/`. [turri desktop](https://github.com/turri-oss/turri-desktop) is turri in a native window: it runs turri through its host entry (`@turri-dev/cli/host`, [hosting](docs/hosting.md)) and owns only the window - its views, its installer and updates. A change to what turri does goes here; a change to how the app shows it goes there. If you are not sure which side something is on, open an issue and ask.

## Making a change

Fork the repository, make a branch, and open a pull request against `main`.

```bash
git clone git@github.com:<you>/turri.git && cd turri
npm install
npm link           # `turri` on your PATH, pointing at this clone - edits apply at once
turri doctor       # what this machine lacks
```

You need Node 22.19 or newer, git and bash; on Linux, bubblewrap for the OS sandbox - [installation](docs/installation.md) says what to install. The TypeScript runs unbuilt, through Node's own type stripping, so there is nothing to build. [Development](docs/development.md) says how turri is laid out, and the pages in [docs/](docs/README.md) how each part behaves: read [regenerating](docs/regenerating.md), [the sandbox](docs/sandbox.md) and [skills and gates](docs/skills-and-gates.md) before changing the harness.

Before you open the pull request:

```bash
npm run typecheck  # src/ only, not tests/
npm test           # the whole suite, about a minute - calls no model
npx vitest run tests/regenerate/records.test.ts   # one file, while you work
```

Add a test in `tests/` for what you change. No test calls a model: an agent is scripted by mocking `src/pi.ts` with a stub that calls the session's tools itself - `tests/regenerate/conformance-loop.test.ts` is the example to follow. The tests that run real commands behind the OS sandbox are skipped on a machine without one. The same typecheck and suite run on every pull request, with a check of its commits; for a contribution from outside, the maintainer starts them, and they must pass before it is merged.

The tests spend nothing, but turri itself does: the conversation, `turri regenerate` and `turri doctor` in a project call the models `config.turri.yaml` names, with your keys. Check what you can with what calls none - `turri parse <file.plain>`, `turri doctor --no-models`.

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `feat(stacks): ...`, `fix(regen): ...`, `docs(config): ...`, the description lowercase, with no full stop, saying what turri now does. A breaking change takes a `!` before the colon. A pull request is rebased onto `main`, each of its commits landing as it is - so each is a Conventional Commit, with no merge commit and no fixup left. Fold fixups into the commits they fix with `git rebase -i --autosquash origin/main`, then `git push --force-with-lease`; the `commits` check fails a pull request until they are. Each push to `main` is published to npm under `next`.
- **Names**: turri is written lowercase, even at the start of a sentence; \*\*\*plain is written `***plain` (escaped in Markdown). The words in [GLOSSARY.md](GLOSSARY.md) - func-id, scenario-id, test plain file - mean what it says.
- **Prose** - docs, comments, strings - uses British spelling and a spaced hyphen ` - `, not an em dash. Test names are sentences about behaviour: `it("renames a clashing file instead of overwriting it")`.
- **TypeScript that type stripping can run**: imports with their `.ts` extension, and no parameter properties, `enum` or `namespace` - `tsc` accepts them, but `turri` will not start.
- **Docs move with the code**: when behaviour changes, update the [docs/](docs/README.md) page that describes it in the same pull request - and `genome/rules/turri-regeneration.md`, turri's model of itself for the agents that write \*\*\*plain, when it says what changed.
- **The parser is a faithful port** of the Python reference parser, quirks and all: read [the parser](docs/parser.md) before "fixing" one.

## Conduct

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Licence

By contributing, you agree that your contribution is licensed under the [MIT licence](LICENSE), as the rest of turri is.
