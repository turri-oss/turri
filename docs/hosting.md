# Running turri in a host

`turri` runs its chats in a terminal. A host - a desktop app, an editor - runs the same session itself, its chats in its own windows, and shows what turri's terminal draws in its own way: the pulses, the questions, the \*\*\*plain.

The terminal and a host build on the same package, [`@turri-dev/core`](https://github.com/turri-oss/turri-core): each opens one session with `createTurri({ frontend })`, says in its `Frontend` what it does differently - where its chats' pi sessions are made, how it asks the person, what it shows itself, where the person watches the work - hears the session's events and asks its methods. The terminal's front end is in this repository (`src/terminal-view.ts`, `src/chat-terminal.ts`); a host writes its own. [The core's interface](https://github.com/turri-oss/turri-core/blob/main/docs/core.md) is the whole of it.

`@turri-dev/cli/host`, which carried the old desktop contract over the core's compatibility bridge, is gone: a host imports `@turri-dev/core`.
