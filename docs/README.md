# turri documentation

turri is the first coding agent with the power of regenerative software: [\*\*\*plain](https://plainlang.org/docs/) captures the durable definition of what a system does, and the code is regenerated from it and validated against. The [project README](../README.md) says why, and how to install and start; these pages go into each part.

## Start here

1. [Installation](installation.md) - get a machine ready: `turri doctor`, and what turri needs of this machine.
2. [Using turri](using.md) - the conversation, the skills and tools, background jobs and their logs, choosing the model that codes, the command line.
3. [Authoring \*\*\*plain](authoring-plain.md) - writing \*\*\*plain: what is it made out of, the authoring rules, the skills that write and fix it.
4. [Regenerating](regenerating.md) - turning \*\*\*plain into code: what each build does, in which order, and what has to pass before it moves on.

## By question

| to find out… | read |
| --- | --- |
| what my machine needs, and why a check failed | [installation](installation.md) |
| what turri needs of this machine, and what `turri doctor` checks | [installation](installation.md#what-turri-doctor-checks) |
| how to start a project, or add a feature, in a conversation | [using](using.md#in-a-conversation) |
| how to have several chats open at once, and reopen them | [chats](chats.md) |
| what checks each pulse as it finishes, and tells me what needs me | [the sentinel](sentinel.md) |
| which model codes, and how to change it | [using](using.md#choosing-a-model), [the project config](config.md#models) |
| what `config.turri.yaml` can set, and what happens without it | [the project config](config.md) |
| how a backend and a frontend on different stacks share one project | [the project config](config.md#stacks) |
| which ready-made stacks \*\*\*plain can import - a FastAPI backend, a React frontend | [the standard library](authoring-plain.md#the-standard-library) |
| everything an agent was sent and did, to debug it | [using](using.md#agent-logs) |
| how to regenerate \*\*\*plain overnight, and resume it | [running unattended](headless.md) |
| how to rebuild one functionality | [running unattended](headless.md#rebuilding-one-functionality) |
| what goes in which section of \*\*\*plain | [authoring \*\*\*plain](authoring-plain.md#what-plain-is-made-of) |
| which skill does what | [authoring \*\*\*plain](authoring-plain.md#the-skills) |
| what happens when \*\*\*plain changes | [regenerating the code](regenerating.md#when-plain-changes) |
| why a test was not allowed to be deleted | [regenerating the code](regenerating.md#the-tests-must-actually-pass) |
| how to try what is built, and what deploy may install | [deploy](deploy.md) |
| what the agents can and cannot reach | [the sandbox](sandbox.md) |
| how skill review gates and judges work | [skills and gates](skills-and-gates.md) |
| how the parser matches the reference implementation | [the \*\*\*plain parser](parser.md) |
| how a desktop app or an editor runs turri's chats itself | [running turri in a host](hosting.md) |
| where the code for something lives | [development](development.md#layout) |

## All pages

| page | covers |
| --- | --- |
| [Installation](installation.md) | doctor, what turri needs of this machine, turri and `pi`, environment variables |
| [Using turri](using.md) | the conversation, the tools, background jobs, choosing a model, module history, the command line |
| [Chats](chats.md) | several chats in one session: what each keeps and what they share, `/chat` and its keys, `turri --continue` and `.turri/chats.json` |
| [The sentinel](sentinel.md) | the chat every finished pulse goes to: what it checks and tests, its notices and how to answer them, what it may do, closing it, its model, in a host |
| [The project config](config.md) | `config.turri.yaml` and each stack's `config.turri.<stack>.yaml`: where they are read from, every key, models and their inheritance, conformance, the testing scripts, stacks and choosing one, the old `config.yaml` |
| [Deploy](deploy.md) | trying what is built: dist/<module>, the last commit, starting it on your machine, `turri release` |
| [Running unattended](headless.md) | regenerating overnight or in CI: before you leave it, the command, the results, resuming, rebuilding one functionality |
| [Authoring \*\*\*plain](authoring-plain.md) | a \*\*\*plain project, what \*\*\*plain is made of, the rules, writing \*\*\*plain with the agent, the skills, checking \*\*\*plain |
| [Regenerating](regenerating.md) | where things go, one job, a whole module and how its work is cut into jobs, each job's cases, \*\*\*plain changes, conformance tests, the two records of what is built |
| [The sandbox](sandbox.md) | what an agent can reach, the file-tool fence, the command check, the OS sandbox, the audit |
| [Skills and gates](skills-and-gates.md) | the gate syntax, what the harness enforces, what a step can do, the rules, trying the gates |
| [The \*\*\*plain parser](parser.md) | the TypeScript port, `turri validate`, inheritance, the iterator, fidelity |
| [Theming](theming.md) | the turri themes, contrast, backgrounds, the font |
| [Running turri in a host](hosting.md) | `@turri-dev/cli/host`: the session and its chats in a host's own windows - their jobs, their questions - and what a host shows beside them |
| [Development](development.md) | tests, the source layout, known edges |
