---
name: deploy-npm
description: Release turri to npm - pick the version, write the release notes, publish the GitHub Release that publish.yml ships, follow its run, and check every job and npm itself.
disable-model-invocation: true
---

# Deploy turri to npm

A **release** is a published GitHub Release tagged `vX.Y.Z`. Publishing it starts `.github/workflows/publish.yml` (`docs/development.md`, "Publishing"): its jobs test the tagged commit, publish `X.Y.Z` to npm under `latest` (under `next` for a release marked a pre-release), and post it to Discord. The tag is the version - `package.json`'s is stale by design and is never bumped or committed. Every push to `main` already ships a prerelease under `next` by itself; this skill is for `latest`.

A release cannot be taken back: npm never takes a version twice, and Discord has announced it. So nothing leaves this machine without the person's **go** on the exact version, commit and notes (step 4), and every repair after it - a re-run, a deleted release - waits for a go of its own.

Work from the turri clone. `$V` is the version (`0.5.0`), `$SHA` the commit, `$RUN` the workflow run's id: write them out in every command, as shell variables do not carry between commands. Notes and checks go in a folder of your scratchpad.

## Steps

### 1. Settle the commit

```bash
git fetch origin --tags --prune
git status --short --branch
```

The release is cut from `origin/main` as GitHub has it. Local commits not on `origin/main` are not in it: name them to the person - pushing is theirs to ask for. `$SHA` is `git rev-parse origin/main`.

Its checks, from both workflows that ran on its push:

```bash
gh run list --commit <SHA> --json workflowName,event,status,conclusion --jq '.[] | [.workflowName,.event,.status,.conclusion] | @tsv'
```

Done when `test` (push) and `publish` (push) are both `completed success`. One still running: wait for it (`gh run watch <id> --exit-status`). One failed: stop, and tell the person what failed (`gh run view <id> --log-failed | tail -60`) - a release is never cut from a red commit.

### 2. Settle the version

```bash
npm view @turri-dev/cli dist-tags --json
gh release list --limit 5
git log --format='%h %s' <last tag>..<SHA>
```

The last tag is the newest release that is not a pre-release. While turri is `0.x`, the commits since it decide the bump: any `feat` or breaking change (`!`, a `BREAKING CHANGE:` footer) moves the minor (`0.4.0` → `0.5.0`), only `fix` and `perf` the patch (`0.4.0` → `0.4.1`). Only `docs`, `test`, `ci`, `chore`, `build`, `style`, `refactor` since the last tag: nothing reaches the person who installs turri - say so, and go on only if the person still wants a release.

Done when `$V` is free on both sides - `npm view @turri-dev/cli@<V> version` prints nothing and `git ls-remote --tags origin v<V>` is empty.

### 3. Write the release notes

Read the last release's notes first - `gh release view <last tag> --json body --jq .body` - and write these the same way, into `notes.md` in your scratchpad:

- the install block on top: ```` ```bash ```` `npm install -g @turri-dev/cli` and `turri doctor`;
- **Breaking**, **New**, **Fixed** - in that order, each only when it has an entry;
- one bullet a change the person notices, opening with its point in bold, then what they now get or must do - in turri's words (pulse, regenerate, \*\*\*plain diff, launch), never a file or function name;
- a breaking change says what replaces what is gone, and what happens to existing config;
- host API changes in one last `For hosts:` bullet under the section they belong to;
- British spelling, a spaced hyphen ` - `, never an em dash.

Read every commit in the range, its body too (`git log --format='%h %s%n%b' <last tag>..<SHA>`): one commit can hold several changes, several commits one. Done when every `feat`, `fix`, `perf` and breaking commit is in a bullet or knowingly left out (internal only), and nothing in the notes is missing from the range.

### 4. Get the go

Show the person, in full: `v<V>`, `<SHA>` with its subject, latest or pre-release, and the whole of `notes.md`. Ask for their go on exactly that. A change to any of it - the version, the notes - is shown again and asked again. Done when the person has said go.

### 5. Publish the release

```bash
gh release create v<V> --target <SHA> --title "turri <V>" --notes-file <scratchpad>/notes.md
```

Add `--prerelease` only when the person asked for one: it goes to npm under `next` and is not announced. Publish it directly - a draft does not start the workflow - and let `gh` make the tag on GitHub; no tag is made or pushed from here.

### 6. Follow the run

The release's run is the newest `release` run of `publish.yml` whose branch is the tag. It appears within seconds of the release:

```bash
gh run list --workflow publish.yml --event release --limit 5 --json databaseId,headBranch,status,url --jq '.[] | select(.headBranch == "v<V>")'
```

Give the person its `url` as soon as you have it, then follow it to the end - three to five minutes:

```bash
gh run watch <RUN> --exit-status --interval 20
```

Done when the run is `completed`, green or red.

### 7. Check every job

A green run is not proof on its own: a job that was skipped, or that passed with a notice, did not do its work. Check all three levels.

The jobs:

```bash
gh run view <RUN> --json jobs --jq '.jobs[] | [.name, .status, (.conclusion // "-"), (.databaseId|tostring)] | @tsv'
```

| Job | Release on `latest` | Release marked a pre-release |
| --- | --- | --- |
| Test | success | success |
| Publish to npm | success | success |
| Announce on Discord | success | skipped |
| Publish prerelease to npm | skipped | skipped |

Each job's steps - this prints only the steps that did not succeed or were not skipped, so it must print nothing:

```bash
gh run view <RUN> --json jobs --jq '.jobs[] | .name as $j | .steps[] | select(.conclusion != "success" and .conclusion != "skipped") | "\($j): \(.name) \(.conclusion)"'
```

Each job's annotations - a notice or warning is a job that passed without doing its work (`DISCORD_RELEASE_WEBHOOK is not set - no announcement posted`):

```bash
gh api repos/turri-oss/turri/check-runs/<job id>/annotations --jq '.[] | "\(.annotation_level): \(.message)"'
```

And the announcement itself, on a release on `latest` - the log line the post prints once Discord took it (the log also shows the script's source, hence the `grep -v`):

```bash
gh run view --job <Announce job id> --log | grep -E "announced v[0-9]" | grep -v echo
```

Done when every job matches its row, no step is listed, no annotation is there, and - on `latest` - `announced v<V> on Discord` is in the log. Anything else: see [When a job fails](#when-a-job-fails).

### 8. Check npm

npm takes a few minutes to show a new version - four for 0.4.1, its log saying `Your package is being processed`: retry for ten minutes (`--prefer-online`, every 15 seconds) before calling it missing. The publish job's log line `+ @turri-dev/cli@<V>` says the registry took it.

```bash
npm view @turri-dev/cli@<V> version dist.attestations.provenance.predicateType
npm view @turri-dev/cli dist-tags --json
```

Then install it as a person would, into a folder of your scratchpad, and run it:

```bash
npm install --prefix <scratchpad>/install --prefer-online --no-audit --no-fund @turri-dev/cli@<V>
<scratchpad>/install/node_modules/.bin/turri --version
```

Done when `<V>` is on npm with a `https://slsa.dev/provenance/v1` provenance, `latest` is `<V>` (a pre-release: `next` is `<V>` and `latest` is unchanged), and the installed `turri --version` says `turri <V>`.

### 9. Report

Tell the person: the release's URL, the run's URL, a line per job with its conclusion, what npm has under `latest` and `next`, whether Discord was told, and anything in steps 7 and 8 that did not hold. Then `git fetch origin --tags`, so this clone has the tag.

## When a job fails

Read why first - `gh run view <RUN> --log-failed | tail -80` - and tell the person what failed, what the log shows, and the way out below. Each way out waits for their go.

- **Test failed.** Nothing reached npm, but the release and its tag point at a commit whose tests fail. A flake (a timeout, a runner fault): `gh run rerun <RUN> --failed`, then steps 6 to 8 again. A real failure: the fix lands on `main`, and the release is deleted with its tag - `gh release delete v<V> --cleanup-tag --yes` - and cut again from the fixed commit, from step 1.
- **Publish to npm failed.** `already published`: `<V>` was taken after step 2 - delete the release and its tag as above and release the next version. An authentication error (`E404` or `ENEEDAUTH` on publish): npm's trusted publisher no longer matches - on npmjs.com the package must trust `turri-oss/turri`, the workflow `publish.yml` and the environment `npm` (`docs/development.md`); once the person has fixed it, `gh run rerun <RUN> --failed`. Anything else: the log decides.
- **Announce on Discord failed, or passed with a notice.** npm has the release; only the post is missing. Once the cause is fixed (the `DISCORD_RELEASE_WEBHOOK` secret, say), announce it again - `gh workflow run publish.yml -f tag=v<V>` - and follow that run as in steps 6 and 7: there, only Announce on Discord runs, and it succeeds.
