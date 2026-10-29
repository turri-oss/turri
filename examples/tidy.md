# A command-line tool, a command at a time: tidy

You will build **tidy**, a command-line tool that sorts a messy folder (your Downloads, say) into subfolders by kind of file. It starts as one command that only says what it would do. It grows a command that does it while you try the first, and loses a feature you change your mind about while it is being built.

Build it in whatever language you like - Python, TypeScript, Go, Rust or Java. Name no language, and **turri** chooses a stack your machine can build.

```bash
mkdir ~/tidy && cd ~/tidy
turri init-config
turri
```

## 1. The smallest thing: a dry run

> Let's build tidy, a command-line tool in Go. To start: `tidy plan <folder>` prints, one line a file,
> `<file> -> <kind>/`, where the kind is images, documents, archives, audio, video, code or other. It moves
> nothing. Hidden files and subfolders are left alone.

**turri** writes `tidy.plain`, importing the standard library's Go command-line stack, `stdlib/cli/go-cobra`. That stack settles what every CLI has to decide - `Error: <message>` on standard error, the exit codes, `--help` and `--version` - so the \*\*\*plain need not say it. Then it writes the unit testing script, and starts regenerating `plan` at once.

## 2. The next command, while the first regenerates

> Now `tidy apply <folder>` moves the files where `plan` says, creating the subfolders. It never overwrites:
> a name that is taken gets ` (2)`, ` (3)` and so on.

`plan`'s pulse goes on. `apply` is new work: it is planned behind `plan`, and starts as soon as `plan` lands.

## 3. Try the first command while the second is built

When `plan` lands, it is released. **turri** says how to run it from `dist/tidy` - that depends on the stack. Try it on a copy of a folder:

```bash
cp -r ~/Downloads /tmp/downloads-copy
tidy plan /tmp/downloads-copy
```

`apply` is regenerating meanwhile. You can say what you see in `plan`'s output now - "put `.svg` under images, not code" - and it is regenerated too. The kinds are one definition that both commands use, so the change reaches both.

## 4. Change your mind mid-build

> Add `--by-date`: sort into `YYYY/MM` folders by each file's modified time instead.

A pulse starts on it. Then, before it lands:

> Actually, forget `--by-date`.

**turri** takes it out of the \*\*\*plain. The pulse that was building it is now building something the \*\*\*plain no longer wants, so it is stopped and rolled back whole - code, tests and history. The rest of the work is planned again from the \*\*\*plain as it now reads. Nothing of `--by-date` is left in the code.

## 5. Keep growing

> Files bigger than 1 GB go to a `large` folder, whatever their kind.

That changes what `plan` prints and where `apply` moves, so both are regenerated with it. Their unit tests run again with the change, so what worked before is checked to still work.

## Try it: regenerate from scratch

The \*\*\*plain is the software; the code is just one regeneration of it. Delete tidy's code and regenerate it from its \*\*\*plain alone - every command and rule you added along the way, built again from the start:

```
/regenerate tidy from scratch
```

It starts at once, and the code it deletes stays in `/lineage`. The new code will not be the same code, but it does what the \*\*\*plain says - try it again and see.

## Where next

- [shorty](shorty.md) - conformance tests where they matter, decided for you.
- [The standard library](../docs/authoring-plain.md#the-standard-library) - every stack, and what each settles.
