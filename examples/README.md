# Examples

Each example is a project you regenerate with **turri** from an empty folder, through its interview, `brood`. You say what you want, **turri** writes the \*\*\*plain specs and regenerates the code from them, and you change your mind by changing what the software should do. You never write a line of code yourself.

| example | what you build | what it shows |
| --- | --- | --- |
| [guestbook](guestbook.md) | a backend API that keeps messages, and a web page to sign it | a backend and a frontend in minutes: two modules on two stacks from one interview, each with its own testing scripts, regenerated at the same time |
| [tidy](tidy.md) | a command-line tool that sorts a folder of files into subfolders | light questioning - turri deciding what you leave open - a CLI on the standard library, conformance tests that run the real binary |
| [shorty](shorty.md) | a backend service: a URL shortener with click counts | conformance tests from the start, `bind`, a rule changed and regenerated again |

New to **turri**? Start with [guestbook](guestbook.md): it is the quickest, and done in minutes.

Every example is built in the language you choose. The agents use the toolchains on your machine and install none, so turri offers only the stacks your machine can build - Python needs [uv](https://docs.astral.sh/uv/), TypeScript and every web app Node with npm, Go `go`, Rust `cargo`, Java a JDK. `turri doctor` lists what is there.

## Before any of them

- Install **turri** as the [quick start](../README.md#quick-start) says, and run `turri doctor`.
- Make a folder for the project, `cd` into it and run `turri init-config`. It writes a `config.turri.yaml` with two models: a capable one to talk to and a smaller one for the coding. Change them to models you have.
- Each example says which toolchain its stack needs. Once the project exists, `turri doctor` in its folder says what is missing.
- Start `turri` in the folder and type `/brood`, then what you want. Each example gives the words to start with. Use your own words if you prefer: the interview asks for whatever is missing.
- The interview's first question is how many questions you want to answer: light, medium or thorough - at most 3, 5 or 10 in each of the stack and product phases - or best judgement. Fewer questions are broader ones, so every level covers the same ground. Every product answer is a spec change that starts regenerating at once; what the questions leave open, **turri** decides itself and tells you what it chose. Each example suggests a level. Whether there are conformance tests is always asked, in the testing phase.

What the agents build differs from run to run, as code written by any developer would. The specs are what stay the same, and the conformance tests are what show that the code does what they say.
