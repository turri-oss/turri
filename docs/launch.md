# Trying what is built: launch

Ask to try it - "let me try it", "run the app" - at any time, even while a regeneration is running. The chat calls `launch`, and it returns at once: in the background, the module's code, as one of its commits has it, goes in `dist/<module>` in the project, and an agent starts it on your machine. The chat is told how it went once it ends - an app with a backend and a frontend started whole, and where to open your browser; for a command-line tool or a library, a few commands to paste, run from `dist/<module>`, and what they print.

With `launch-after-pulse: true`, turri launches what every pulse lands itself - see [after every pulse](#after-every-pulse).

## The launch track

Every launch goes through the session's launch track, one codebase at a time:

- **One at a time.** A codebase has one launch running at most. A launch is never stopped for a newer one: it finishes, and then the newest is launched.
- **The newest wins.** While one runs, a newer commit asked for waits as the next - and replaces any older one waiting there, which is never launched (`superseded`). Its code is in the newer one: code accumulates commit by commit. A launch that ends with a newer one waiting is replaced too (`replacedBy`): the newer one starts at once and stops what it started - unless its code is out already. Whoever asked for either is told that a newer launch takes its place, and then where that one runs, or why it did not come up, once it ends - never that the one it asked for is up, only for it to be stopped the next moment. The same holds up a `requires` chain - see [across a project](#across-a-project).
- **Nothing waits on it.** A launch is not a pulse. It holds no lane and takes no `parallel-jobs` slot: the next pulse starts while it runs, and the person goes on talking.
- **Out already.** When what runs is a commit's code already - the same code, and nothing it started has ended - it does nothing, and says so: nothing exported, nothing stopped, what runs left running. It still ends as a launch of its own, at once - `already`, its own cause, the commit asked for - and when that commit is built on what runs, what runs holds it from then on; the launch that started what runs is left as it was. A pulse that landed only conformance tests is out already. Guidance passed again does not launch it anew - the agent found the project's guidance itself; `again: true` launches it anyway, for when the last launch did not leave it as you need it - guidance that says to launch it some other way, say.

What each launch is - its codebase, its commit, whether it came up, what it started - is recorded, and the [sentinel](sentinel.md) tests a pulse only in a launch whose commit holds the pulse's.

## When the project says how it is launched

Every launch starts the same way: the commit's code goes in `dist/<module>`, as below. Not everything is tried from there, though. An integration that a host application loads goes on into the host's own tree, with the host's own scripts, and then the host is started. So the agent asks itself whether there is guidance for how this project is launched - in what you said (the chat passes it to `launch` whole), the project's AGENTS.md, a skill - and:

- **There is guidance.** The code goes on from `dist/<module>` as the guidance says, on your machine, from the host codebase - the git repository the project is in, or else where turri runs: the scripts it names, in their order, and any change it says the host needs. The code is taken from `dist`, never from `plain_modules`, where the next pulse may be writing; where the host's tooling reads `plain_modules` itself, the agent points it at `dist`, or does by hand from `dist` what it does. The rules below hold as they do for `dist`: the agent runs the project's scripts and installs what they need itself, and what keeps running - a start script, a server - is started with `activate`, from the host codebase. Nothing built is changed, and nor is the \*\*\*plain: its file tools refuse a `.plain` file - a module or a test plain file - as they refuse `plain_modules`.
- **There is none.** The default: it is started from `dist/<module>`, as below, as best it can be.

Guidance is whatever says it, in any words - a line in AGENTS.md such as *integrations are launched with `scripts/deploy_integrations.sh`, then the app is started with `scripts/start.sh`*, or the same said in the chat. What was said in the chat is kept for the codebase's launches after it, those after a pulse among them.

## What goes in dist

- **The module on top.** Code accumulates up a `requires` chain: a module starts from a copy of the code of the one it requires, and each built module is a codebase of its own, `plain_modules/<module>`. So a launch takes the built module on top of the `requires` chain - the project's `module` from `config.turri.yaml` unless another module's \*\*\*plain is named - and, as the chain is built, that is a new module each time one starts: `ocean`, then `depths` built on it, then `predators`. Before the module on top has anything built, it takes the nearest one below it that has, and says so. Each goes in `dist/` of its own, and what launches of the modules below it started is stopped as it starts - see [across a project](#across-a-project).
- **A commit, whole.** Each `plain_modules/<module>` is a git repository (`.plaingit`), and every unit of work starts from a commit and ends with one. A launch after a pulse takes the commit the pulse landed; one the chat asks for, the codebase's last. What a pulse is writing right now is half-done, so it is left out: the launch exports the commit - `git archive` of `code/` - which is the code with every uncommitted change put back, and no `node_modules`, `.venv`, `target` or other build leftovers, whatever the stack. The working tree the next pulse is using is never read, reset or touched. The harness's own files - `.turri.json`, the agents' notes - are left out too.
- **Replaced whole.** Each launch stops what the last one of the codebase started - and what launches of the modules below it started - empties `dist/<module>` and exports again. Change nothing there you want to keep. `dist/` is not added to `.gitignore`: whether it is committed is yours to decide.

## Starting it

It runs on your machine, outside the [sandbox](sandbox.md) - with your toolchains, where your browser can reach it. The launch agent - on the codebase's coding model, thinking low: it follows steps, and a small model does that well - reads how the code runs (its README, manifests and entry points), then:

1. **Checks the toolchains** it needs (`node`, `python3`, `go`, ...) - under another name too: `python` where `python3` is not, of the version it needs. One is missing: it stops, and says the exact command to install it yourself (`brew install node`). turri installs nothing on your machine and changes none of its settings - not a launch, not the chat, not any agent: its shell refuses it.
2. **Installs what it needs into the project.** Dependencies into a virtual environment or `node_modules`, a build that downloads packages, an image pull, a guided launch's project scripts: it runs them in its own shell, as any agent with a shell would, and fixes what fails. Nothing is put to you - there is no dialog to answer. Never a global install, never a system setting.
3. **Starts what serves** with `activate`: in the background, in its own process group, its output in `.turri/launch/<module>-<name>.log`. It waits until something answers at the server's URL - up to a minute - so the URL you are given has answered once; one that exits first comes back with the end of its output. A port that is held already is taken when one of turri's own launches holds it, and otherwise said - what holds it, whose it is and how to free it - with nothing started there: the app is never moved to a port you were not told about (see [what holds what a launch needs](#what-holds-what-a-launch-needs)). It runs in `dist/<module>`, or a folder inside it the agent names (`frontend`) - or, with guidance, in the host codebase; a folder that is not there starts nothing, and the agent is told so with what the folder holds, to name the right one.
4. **Says how it went** with `submit_launch`: launched or not, whether it serves - a backend or a frontend, against a CLI or a library tried from its folder - and in a line or three where it runs, or why it did not come up. The chat is told that, not the agent's prose. turri checks it rather than trusting it: a launch that says it serves - or names a URL - is launched only while something it started with `activate` still runs. Something else answering at its port - an earlier build left running, another program - is not this launch: `submit_launch` refuses it, and a launch that ends that way is `failed`, saying what holds the port.

`activate`, `stop_launched` and `submit_launch` are the launch agent's alone: the chat has `launch`, and nothing else of it. What a launch started is listed by the `pulses` tool and by **`/halt`**, with the launches under way and waiting, and stopped by **`/halt launched <name>`** (one server), **`/halt launched <module>`** (the module's launch under way, the one waiting, and what it started), by `halt` with `launched`, by the next launch of the codebase or of a module built on it, by a launch that needs what it holds, and when turri exits. Halted, a launch that has nothing left running is `stopped` - "Stopped on request." - a host hears it, the sentinel has nothing of it to test, and the next launch of the codebase launches anew, never out already.

## Across a project

A project's launches are of several codebases: the modules of a `requires` chain, one after another as it is built, and the modules of a branch - two built on one, `in_module` - side by side. What their launches start runs on the same machine, and the code of one module is often started the same way as the one below it - the same command, on the same port - since it was copied from it. So:

- **Up a chain, the newer module replaces the one below.** A launch stops what launches of every module below it in its `requires` chain started, as it stops what the last launch of its own codebase started: their code is in it, an older build of the same app. That is everything they started - a server on the same port, one on another, a worker - whatever it holds. What an earlier turri left running of them is stopped too. A launch of a module below it under way is waited for - it ends, and the newer one starts and stops what it started; one waiting is never launched (`superseded`). So whichever pulse lands, the newest build of the chain is what runs - and nothing older answers at its URL, even when the newer one does not come up.
- **Side by side, what does not get in the way runs on.** What turri's launches of any other module started - a branch beside it - is left running, unless it holds what this launch needs: then turri stops it, and this launch takes it. A port the harness sees itself, as `activate` starts the server. Anything else - a socket, a lock or pid file, a container name, a database kept open - the launch agent finds in what failed (its output, `lsof`, `ps`), and frees with `stop_launched`, naming a pid of it and what it holds. Either way turri stops only what its own records say one of its launches started.
- **Said, every time.** A launch whose servers were stopped this way is replaced: a host hears it again (`onLaunch`), with `replacedBy` the newer launch's id - nothing of it runs, and its codebase's code, for a module below, is what the newer launch runs. What the newer launch stopped is kept on it apart from what its agent said - `stopped`, an entry a process with why, whose launch, module, commit, pid and address, for a host to show beside it ([hosting](hosting.md)) - and what the chat and the terminal are told begins with a line for each - `Stopped what bestiary's launch launch-17 at befa07f started - bestiary (pid 96379, http://localhost:5173): upgrades is built on bestiary and holds its code, so this launch takes its place.`, or `Stopped server (pid 96379, http://localhost:5173), from web's launch launch-4 at 1a2b3c4: it held port 5173, which cli needs.` - and the ledger has `launch.freed` and `launch.replaced`.

The [sentinel](sentinel.md) tests a pulse of a module below in the launch of the module built on it that replaced its own: that launch holds its commit, as the module started from that code.

### What holds what a launch needs

What holds a port - or anything else a launch needs - is looked up by its process, in turri's records (`.turri/launch/running/`, below), and said as it is:

- **This turri's launch of another module.** Stopped, and taken - kept in the launch's `stopped` and said to the chat, as above.
- **An earlier turri's, ended.** Stopped too, as [what an earlier session left running](#what-an-earlier-session-left-running) is.
- **Another turri still running** - in another terminal, say. That turri's: never stopped. Said with the launch and module it started it for, and how to free it - `/halt launched <module>` in that turri's chat, or quit it - then ask for the launch again.
- **Nothing turri's records name.** Not turri's: never stopped, and said so - the process and its pid. If it is yours to stop, stop it, or ask the chat to (`kill <pid>`), then ask for the launch again.
- **This launch's own** - two of its servers on one port. The agent's to sort out: nothing stopped.

Where turri cannot tell - no `lsof` - it says that, and nothing is stopped. Nothing turri started is ever said to be someone else's, nor anything else turri's; and the app is never moved to another port.

### What an earlier session left running

What a launch starts is written down as it starts - `.turri/launch/running/<pid>.json`: its process, its process group, its codebase, its command, folder and URL, and the turri that started it - and taken out as it ends. A turri that is killed outright stops nothing it started, and a server it left would hold its port in the next session, answering with old code. So as a session starts, and again before each launch of a codebase, turri stops what those records name whose turri has ended - its process group, politely and then not, as it stops its own - and says so in the ledger (`launch.left-behind`), in the next launch's `stopped` for a host, and at the head of what the chat is told of the codebase's next launch: `Stopped what an earlier turri session left running of shorty: backend (pid 66816, http://127.0.0.1:8000).` Each record names the launch and the commit it started it for. It stops only a process its records name, and only while it is still the one recorded - started when the record says; a pid given to another process since is left alone, its record taken out. What another turri still running started is that turri's. Before a launch, what was left of the modules below it in its chain is stopped as well as its own codebase's.

## After every pulse

With `launch-after-pulse: true` in `config.turri.yaml`, turri launches what each pulse lands itself, on the launch track: the pulse ends as it lands - once its line in the notes is committed with it - and its commit is asked for as the codebase's next launch. The codebase's next pulse starts at once; nothing waits on the launch, and the chat - waiting on your answer to a question, say - has no part in it.

The launch agent finds the guidance as for any launch: what the chat passed to `launch` earlier for the codebase, the project's AGENTS.md and its skills. The setting is the word to launch; the guidance says only how - without any, the code goes to `dist/<module>` and is started from there.

- **With the [sentinel](sentinel.md) on** - the default - the chat you are in is told that the pulse landed, is being launched in the background, and that the sentinel tests it once it is up; the sentinel is told the pulse once what runs holds its commit, and tests it there. A launch that did not come up is told to it, and is a finding of its own like any other. A host hears every launch as it is asked for, starts and ends (`onLaunch`) - one out already once, as launched.
- **With `sentinel: false`**, the chat that asked for the pulse - or the one shown - is told as the pulse lands that its commit is being launched in the background, and says so in a line, offering nothing else for it. It is told again once the launch ends, as a turn of its own: where it runs, or why it did not come up - unless a newer launch replaced it, whose end is told instead. It then does what it was told to do once something is launched - a host such as a desktop app tells it, in its `surface`, to open it where the person can watch and say what to test.

Off without the key: launching after a pulse is then the chat's, when its guidance says so. `turri init-config` writes `launch-after-pulse: true`.

## On the command line

```bash
turri launch [file.plain] [--in-module <module>] [--guidance <text>] [--model <provider/id>]
```

The same, without the chat: one launch of the codebase's last commit, the agent on `coding-model`, thinking low (or `--model`; without either, [pi](https://pi.dev)'s default), given the project's AGENTS.md and what `--guidance <text>` says. It stays in the foreground with the servers' output; `Ctrl-C` stops them. If it does not get there, launch from the chat instead.

`turri regenerate` and `conform` end a build that landed with `To try it: turri launch <spec>`.
