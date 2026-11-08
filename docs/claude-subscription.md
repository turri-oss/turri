# A Claude subscription

turri can run on your Claude Pro, Max or Team subscription instead of an API key. Every agent - the chat, the planner, the coding agents, the reviewers, the sentinel - then counts against the subscription's quota, as Claude Code does, and you set no key.

It goes through [pi-claude-code](https://github.com/earendil-works/pi-claude-code), a [pi](https://pi.dev) extension from pi's authors. It adds a provider, `claude-code`, whose every model request is sent through Claude Code's own CLI (`claude -p`), signed in as Claude Code is. Only the model call goes there: pi and turri keep the conversation, the history, compaction and every tool - turri's agents run their tools as they always do, in turri's [sandbox](sandbox.md). Claude Code runs no tools of its own.

```
turri's agent ─ pi ─ claude-code provider ─ claude -p ─ your Claude subscription
     ▲                                                          │
     └──────── tool calls run by turri, as with any model ──────┘
```

turri does not depend on the extension: it finds it as pi does, once you have installed it, wherever it needs a model - the chat, a host such as turri-desktop, `turri regenerate` and every command run on its own, `turri doctor`, `turri init-config` ([models from a pi extension](using.md#models-from-a-pi-extension)).

## Set it up

1. **Claude Code**, installed and signed in with the Claude account that has the subscription:

   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```

2. **The extension**, installed with turri - turri runs on [pi](https://pi.dev), and `turri install` is pi's own `install`, run by the pi inside turri: no `pi` of your own needed:

   ```bash
   turri install https://github.com/earendil-works/pi-claude-code
   ```

   `turri list` shows it; `turri update https://github.com/earendil-works/pi-claude-code` updates it; `turri remove https://github.com/earendil-works/pi-claude-code` takes it out. A `pi` you installed yourself sees the same packages, as they are kept in pi's own folder, `~/.pi/agent`.

3. **Nothing in the environment that points Claude Code elsewhere.** The extension refuses to run while any of these is set - each sends Claude Code to an API key or another backend, not the subscription: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`. Unset them where turri starts - your shell's profile, say. A project that also uses `anthropic/...` models with a key cannot run both from one shell.

4. **The project's models**, in its `config.turri.yaml`. A new project:

   ```bash
   turri init-config --vendor claude-code
   ```

   writes

   ```yaml
   harness-model: claude-code/claude-opus-5-5:medium  # you talk to it: it writes the specs and plans the work
   coding-model: claude-code/claude-sonnet-5:low      # it writes the code
   ```

   For a project that has a `config.turri.yaml` already, it sets those two and leaves everything else as it was; or change them yourself, or with `/turri-config harness-model claude-code/claude-opus-5-5:medium` in the chat.

Two settings of the extension's own, read from the environment: `PI_CLAUDE_CODE_COMMAND`, the Claude Code to run when it is not `claude` on the PATH, and `PI_CLAUDE_CODE_CONFIG_DIR`, a Claude Code configuration folder of its own - another account's sign-in, say.

## Its models

The models are pi's Anthropic ones, under `claude-code/`, as far as your subscription has them:

| model | what it is |
| --- | --- |
| `claude-code/claude-opus-5-5` | Opus 5.5 - to talk to, plan and judge |
| `claude-code/claude-sonnet-5` | Sonnet 5 - to write the code |
| `claude-code/claude-fable-5-1` | Fable 5.1 - the most capable, for the hardest work |
| `claude-code/claude-haiku-4-5-20251001` | Haiku 4.5 - the fastest |
| `claude-code/default` | whatever Claude Code itself recommends now |

Each takes a thinking level, as any model in `config.turri.yaml` does - `claude-code/claude-sonnet-5:low` - which goes to Claude Code as its effort. Give Opus 5.5 and Sonnet 5 one of `low`, `medium`, `high`, `xhigh` or `max`: through Claude Code they refuse a request with thinking turned off, so `:off` and `:minimal` fail on them. A role under `models:` takes them as any model - `models: { judge: claude-code/claude-fable-5-1:high }` - and they mix with other providers' in one config.

## Check it yourself

Each step says what you should see; the first one that does not is where it stops.

1. **Claude Code is signed in to the subscription.**

   ```bash
   claude auth status
   ```

   `"loggedIn": true`, and a `"subscriptionType"` - `pro`, `max` or `team`. None, and Claude Code is signed in with a Console API key instead: `claude auth logout`, then `claude auth login` with the subscription's account.

2. **The extension is installed.**

   ```bash
   turri list
   ```

   lists `https://github.com/earendil-works/pi-claude-code`.

3. **turri finds it, and the models answer** - in the project's folder:

   ```bash
   turri doctor
   ```

   ```
   ✓ Model provider       ..., claude-code (… models)
   ✓ Claude subscription  pi-claude-code installed, Claude Code signed in to max - for claude-code/claude-opus-5-5, claude-code/claude-sonnet-5
   ✓ harness-model        claude-code/claude-opus-5-5 answered (2.6s)
   ✓ coding-model         claude-code/claude-sonnet-5 answered (2.2s)
   ```

   `Claude subscription` is there whenever the config names a `claude-code/...` model, and checks what the extension needs, in the order it needs it: the extension installed, Claude Code on the PATH, signed in, to a subscription, and none of the environment above set. Each model line is one short request, thinking as the config says - a few tokens of your quota.

4. **An agent works on it** - start turri in the project and ask for something small, or regenerate a module on its own:

   ```bash
   turri regenerate app.plain
   ```

   The pulse's coding agent runs on `claude-code/claude-sonnet-5`, and the pulse lands as on any model. To watch it work, run it in [debug mode](config.md#debug-mode) (`--debug`): the pulse's log in `.turri/jobs/` names each agent's model and shows the tools it called. In the chat, `/engine` says which model each kind of work runs on.

## In turri-desktop

The desktop app runs turri's chats itself, and finds the extension as the terminal does: install it and sign in to Claude Code as above - in a terminal, once - and choose **Claude subscription** among the vendors of a new project. The app's engine runs with your login shell's PATH, so it finds the `claude` your terminal finds. The sign-in sheet shows `claude-code` among the providers, connected once Claude Code is signed in; its sign-in is Claude Code's own - `claude auth login` in a terminal - not the app's, and its button says so. Doctor's sheet has the `Claude subscription` line of step 3. A host's own part in it is in [running turri in a host](hosting.md#models-from-a-pi-extension-in-a-host).

## What to know

- **The quota is the subscription's**, with its rate limits, as any Claude Code use - and turri runs several agents at once: a pulse's coding agent, its reviewers, the sentinel, up to `parallel-jobs` pulses side by side. Lower `parallel-jobs` if you hit the limits.
- **It is experimental**, and its future is uncertain: Anthropic announced, then put on hold, moving `claude -p` use to a separate credit billed at API rates. The extension's [README](https://github.com/earendil-works/pi-claude-code) says what is known.
- **Each request starts Claude Code**: a little slower than an API key, more so after a tool call, when a fresh Claude Code process takes the conversation on.
- **Complex tool schemas may be simplified** on the way through Claude Code - nullable types, `oneOf`, `allOf`, `anyOf` - as the extension says. An agent whose tool calls come out wrong on `claude-code` but not on another provider is that.
- **Going back in a conversation** - a branch, an earlier message edited - starts Claude Code afresh with the conversation replayed: slower, and more of the quota.

## When it does not work

| what you see | what to do |
| --- | --- |
| `claude-code/... need pi-claude-code, pi's extension for a Claude subscription, which is not installed` | `turri install https://github.com/earendil-works/pi-claude-code` |
| `claude-code - Claude subscription (Claude Code) - is not there` | the same: the extension is not installed, so pi has no `claude-code` provider |
| `Claude Code (claude) is not on the PATH` | `npm install -g @anthropic-ai/claude-code`, or name it in `PI_CLAUDE_CODE_COMMAND` |
| `Claude Code (...) is not signed in` | `claude auth login` |
| `Claude Code is signed in (console), but not to a Claude subscription` | `claude auth logout`, then `claude auth login` with the subscription's account |
| `ANTHROPIC_API_KEY ... is set: pi-claude-code refuses to run with it` - or, from a model call, `refuses conflicting auth/backend overrides` | unset it where turri starts |
| `"thinking.type.disabled" is not supported for this model` | give the model a thinking level - `:low` or more - in `config.turri.yaml` |
| a 429, `rate limit`, `usage limit` | the subscription's limits: wait, or lower `parallel-jobs` |
