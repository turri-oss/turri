---
name: turri-app-prompt
description: Write the prompt for an agent session in turri-app, the desktop host, telling it what changed in turri that the app must reflect. Use whenever a turri change reaches turri-app - the host API (`@turri-dev/cli/host`), the chat's tools or slash commands, config keys, the ledger, anything the app shows or calls - or the person asks to sync, update or catch turri-app up.
---

# Prompt for turri-app

turri-app is the desktop host of turri: an Electron app that imports `@turri-dev/cli/host` and runs turri's chats and work loop in native UI. It is the sibling clone of this repo - `../turri-app` beside the main clone (from a worktree: `$(git rev-parse --path-format=absolute --git-common-dir)/../../turri-app`).

From here turri-app is **read-only**: read and grep it, nothing more - every change in it is made by its own agent session, from the prompt this skill writes. No file written there, no command that changes it (`npm install`, `npm run dev`, `git` beyond `log`/`show`/`diff`).

The prompt is a **brief**: what changed in turri, and what the app must now reflect. The receiving agent and the person decide the how together. Every sentence is a fact about turri, a fact about what the app does today, or a requirement on what the app does - an outcome someone using the app could observe.

## Steps

### 1. Gather what changed

Start from what the person said, then establish the range: turri-app pins turri in its `package.json` (`"@turri-dev/cli": "0.2.4-next.<sha>"` - the sha is the turri commit it runs). Read turri's history and working tree from that commit (`git log <sha>..`, `git diff <sha>`), and note what is committed and what is not.

Keep what a host can see: `src/host.ts` and `src/host-session.ts` exports and types, the chat's tools and slash commands (names, parameters, results), the hidden messages and events a host hears, config keys, ledger events, files turri writes under `.turri/`, and what turri now does or no longer does that the app shows. Done when every change in the range is either kept, with the turri docs that describe it, or dropped as invisible to a host.

### 2. See what reaches the app

Grep turri-app for each kept change - every name, command string, key and event - to learn what the app does with it today. Done when each kept change is marked as used by the app (and by which part, in the app's own terms: its plan view, the settings sheet, the chat) or as new to it.

### 3. Write the prompt

Use this shape:

```markdown
# turri-app: <the change, in a few words>

You are in turri-app (the turri desktop). It pins `@turri-dev/cli` `<version>`, turri at `<sha>`. turri (the clone at
`../turri`) is now at `<sha>`<, with ... in the working tree, not yet committed>.

Read first: <turri's docs/ pages that describe the change, and `git -C ../turri diff <sha> -- <paths>`>.

## What changed in turri

<each change as a fact: what it was, what it is now - in turri's words, naming the export, tool, command, key or event>

## What the app relies on

<for each change the app uses: what the app does with it today, as behaviour, and what of that the change breaks or leaves stale>

## What the app must reflect

<requirements: what the app must do, keep doing or stop doing once it runs this turri - outcomes, never steps>

## Before you change anything

Think this through before writing any code: read the turri side above and the parts of this app it reaches, then work
out with the person how the app should reflect it. Lay out what you found, the questions it raises and the ways you
see to meet it, and settle the approach with them. Resolve it together; the change is theirs to choose.
```

Leave out a section with nothing in it, the last one excepted - it closes every prompt.

### 4. Strip every solution

Read the draft sentence by sentence against the brief: a fact about turri, a fact about the app today, or a requirement. A sentence that names an edit, a file or function in turri-app to change, a turri export to switch to, a replacement, an order of work or a preferred approach is a solution - delete it, or rewrite it as the requirement it was serving ("the plan view must show the pulses `regenerate` would run, without starting any"). Done when every sentence passes.

### 5. Hand it over

Send the prompt to the person in full, in one fenced `markdown` block, and ask them to paste it into a new agent session in turri-app.
