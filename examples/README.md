# Examples

Each example is software that grows while you talk about it. You start with one small feature, and **turri** regenerates it at once. While that regenerates you say what comes next, and it goes into the \*\*\*plain and is regenerated after it - or into the pulse already running, when it changes what that pulse is building. Each pulse that lands is released and running, so you try the software as it grows, and change your mind about what it should do while it is still being built. You never write a line of code yourself, and you never wait for a build before saying the next thing.

| example | what you build | what it shows |
| --- | --- | --- |
| [guestbook](guestbook.md) | a backend API that keeps messages, and a dedicated frontend to read and sign it | a backend and a frontend as two modules regenerating side by side, a feature added while the first pulse runs, a rule changed inside a running pulse |
| [tidy](tidy.md) | a command-line tool that sorts a folder of files into subfolders | trying the first command while the next is still regenerating, and dropping a feature mid-build |
| [shorty](shorty.md) | a backend service: a URL shortener with click counts | conformance tests growing with the code - written for each feature once it is built, and the whole suite kept passing as more lands |

New to **turri**? Start with [guestbook](guestbook.md): it is the quickest.

## Before any of them

- Install **turri** as the [quick start](../README.md#quick-start) says, and run `turri doctor`.
- Make a folder for the project, `cd` into it and run `turri init-config`. It writes a `config.turri.yaml` with two models: a capable one to talk to and a smaller one for the coding. Change them to models you have. It also turns on `release-after-pulse`, so each pulse that lands is released, and the sentinel, which tries each release and tells you when something needs you.
- The agents use the toolchains on your machine and install none. Name a language in your first message, or let **turri** choose a stack your machine can build - Python needs [uv](https://docs.astral.sh/uv/), TypeScript and every web app Node with npm, Go `go`, Rust `cargo`, Java a JDK. `turri doctor` lists what is there.

## How each one goes

1. **Start small.** The first message asks for the smallest useful thing. **turri** chooses the stack, writes the module, its unit testing script and the first functional spec, and starts regenerating it at once.
2. **Keep going while it regenerates.** Every message after is a \*\*\*plain change, regenerated as soon as the work before it allows. Nothing waits for you, and you wait for nothing.
3. **Try what has landed.** Each pulse that lands is released and running. Try it, and say what you would change.
4. **Change your mind mid-build.** A change to what a running pulse builds steers that pulse. A change that takes out what it builds stops it, rolls it back, and plans the work again. A change to a rule regenerates every functionality that uses it.

What the agents build differs from run to run, as code written by any developer would. The \*\*\*plain is what stays the same.
