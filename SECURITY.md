# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately, through GitHub's [private vulnerability reporting](https://github.com/turri-oss/turri/security/advisories/new): only the maintainer sees it.

Say what is affected, how to reproduce it, and what someone could do with it. You will have an answer within a week, word as it is fixed, and credit in the advisory unless you would rather not.

What counts most: a regenerating agent reaching past its walls - reading or writing outside its module's folders, a command the command check, the OS sandbox or the audit should have stopped - or a credential reaching an agent it was never given. [The sandbox](docs/sandbox.md) says where the walls are, and [credentials for the agents](docs/config.md#credentials-for-the-agents) what an agent's commands get. What `release` and `activate` start runs on your machine outside the sandbox, by design ([deploy](docs/deploy.md)).

A problem in the app - its window, its installer, its updates - belongs to [turri desktop's own policy](https://github.com/turri-oss/turri-desktop/security).

## Supported versions

Only the [latest release on npm](https://www.npmjs.com/package/@turri-dev/cli) is fixed: `npm install -g @turri-dev/cli` gets it.

## What turri sends

turri collects no telemetry. It sends what it works on - the conversation, your \*\*\*plain, the project files its agents read, what their commands print - to the models your `config.turri.yaml` names, with your keys or subscription, under that provider's terms. Its agents search the web through DuckDuckGo and read public pages, never this machine's own servers ([the web](docs/sandbox.md#the-web)). What you sign in with stays in [pi](https://pi.dev)'s `~/.pi/agent`, and an agent's commands never get it.
