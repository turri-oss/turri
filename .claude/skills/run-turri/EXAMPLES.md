# Examples to run

Each example is a scripted conversation: the messages to send, **when** to send each (the moment), and what to try once it lands. The first three are the repo's own - `examples/<name>.md` at the root of the turri clone; read the file, it is the script. The rest are written out here.

Pick by what the run is for:

| example | kind, stack | exercises | for | about |
| --- | --- | --- | --- | --- |
| [guestbook](#guestbook) | backend + frontend, FastAPI + React | two modules side by side, a feature added mid-pulse, a steer, a change across both | run-turri, run-turri-launch | 30-45 min |
| [tidy](#tidy) | CLI, Go | trying one command while the next builds, a feature dropped mid-pulse (stop + roll back) | run-turri | 25-35 min |
| [shorty](#shorty) | backend, any + SQLite | conformance tests, a rule change reaching every functional spec | run-turri, run-turri-launch | 40-60 min |
| [textstats](#textstats) | library, Python | launch and the sentinel with nothing to serve | run-turri-launch | 15-20 min |
| [squatter](#squatter) | backend, FastAPI | the first launch meets a port already held | run-turri-launch | 15 min |
| [ledgerbook](#ledgerbook) | existing Flask app via `base-folder:` | building on code turri did not write | run-turri | 20-30 min |
| [steer-storm](#steer-storm) | CLI, Python | three steers into one running pulse - the third must stop it | run-turri | 15-20 min |
| [crash-mid-pulse](#crash-mid-pulse) | any example | turri killed mid-pulse, restarted - the pulse rolled back whole and run again | run-turri | +10 min on its base |
| [stack smoke](#stack-smoke) | one per stack family | each stdlib stack builds, tests and launches | run-turri | 10-15 min each |

With no example named: **guestbook** for run-turri, **shorty** for run-turri-launch. The toolchains each needs: `turri doctor` in the run folder says what is missing.

**Ports.** Every stdlib backend listens on `PORT`, 8000 when unset, whatever its framework's own habit. Two examples with a backend on this machine at once meet on 8000 - run them one after another, or count the meeting as part of the test.

**Time to first landed pulse** is from sending the first message to the first landed pulse's `job.finished`.

Every example can end with its **regenerate from scratch** tail (`/regenerate <module> from scratch`) - worth a run of its own: the same \*\*\*plain, new code, tried again.

---

## guestbook

Script: `examples/guestbook.md`. Send step 1, then step 2's message at `started:1` - before the list's pulse lands. Step 4's message once the form's pulse has started (a second `job.started` for `frontend`) and before it finishes: it must **steer** that pulse, not stop it - a `⇢ steered` in the transcript, no rollback. Step 5 once both modules are idle.

Try: `POST /messages` then `GET /messages` (newest first), a 281-character message refused, the built frontend served and pointed at the backend (`VITE_API_URL`), "x minutes ago" on each message.

## tidy

Script: `examples/tidy.md`. Step 2's message at `started:1` - the planner may still fold `plan` and `apply` into one pulse, after which step 3's "try plan while apply builds" is not exercised: say so. Step 4: send `--by-date`, wait for its pulse to start (`started:N` one more than before), then "Actually, forget `--by-date`." before it lands - expected: that pulse stopped and rolled back (`job.finished` not landed, stopped by turri), nothing of `--by-date` in `plain_modules/tidy/code`. Step 5 once idle.

Step 3's `.svg` change may already be true - the chat often puts `.svg` under images from the start. Check the `.plain` first; if it is, send `.json goes under documents, not code.` instead.

Try on a folder of mixed files you make under the run folder (never a real Downloads), from a neutral working folder: `plan` prints `<file> -> <kind>/` and moves nothing; `apply` moves, never overwrites (` (2)`); hidden files and subfolders left alone; a `.svg` where step 3 put it.

## shorty

Script: `examples/shorty.md`, adapted - the file still describes a test advisor turri no longer has:

- Conformance tests are **off** by default. After step 1's message, once the chat's turn ends, send `/conform` to turn them on - that is the person's call, and this example is about them.
- Skip step 5's "Does expiry need tests?"; send "Write conformance scenarios for listing links." as written. The chat writes scenarios itself for functional specs it judges need them (`genome/rules/test-plain-files.md`) - note which it chose and whether the choice is defensible.
- Step 4's three messages one after another, each once the chat's turn ends. Step 8 once idle.

Each launch replaces `dist/shorty` whole, SQLite database included, so links made before a launch are gone after it; "old 7-character codes keep working" can only be tried by putting such a row in the database yourself.

Try: a 7-then-6-character code, the redirect, the click count rising, `410` on an expired link and its click not counted, the list newest first. Check `plain_modules/shorty/tests/` has a test labelled by each scenario-id, and the last conformance run passed.

## textstats

A library: nothing to serve. Launch should end with commands to paste from `dist/textstats`, and the sentinel should test by running them, not by waiting for a URL.

1. > Let's build textstats, a Python library. `word_count(text)` returns the number of words - runs of letters, digits
   > and apostrophes - in a string. Nothing else yet.
2. At `started:1`:
   > Add `top_words(text, n)`: the n most frequent words, lowercased, as (word, count) pairs, most frequent first;
   > words with the same count in alphabetical order.
3. Once idle:
   > `word_count` should not count a lone apostrophe as a word.

Try from `dist/textstats`: `word_count("it's a dog's life")` is 4; `top_words("b a b a c", 2)` is `[("a", 2), ("b", 2)]` - the tie broken alphabetically; `word_count("' '")` is 0. Check: `launch.finished` is `launched` without any `activate`d process, and the sentinel's session shows it running Python against `dist/`.

## squatter

The first launch finds its port taken. Before sending anything, hold port 8000 (FastAPI's usual) in a second tmux window that does not take the keys: `tmux new-window -d -t <session> -n squatter 'python3 -m http.server 8000'` (if 8000 is already held by something not yours, that is your squatter - leave it). Send to `<session>:0`.

1. > Let's build a tiny status API in FastAPI: `GET /health` returns `{"ok": true}`, and `GET /time` returns the
   > server's time as ISO 8601. Nothing else.

Expected: the launch is `failed`, saying what holds 8000; nothing started on another port; the sentinel's notice says what holds it and offers to launch again once the port is free. Stop the squatter yourself (`tmux kill-window -t <session>:squatter`), then accept that action - and the next launch comes up on 8000. If the agent picks a port other than 8000 on its own, note which and squat that one on a second try.

Then, so at least two pulses land and launch (run-turri-launch needs them), once the chat's turn is over:

2. > `GET /health` also returns `uptime_seconds`, the whole seconds since the server started.
3. At `started:` one more than before:
   > `GET /time` also returns `epoch`, the same time as whole seconds since 1970.

## ledgerbook

An existing codebase turri builds on. Make it before step 1, in the project folder (`$P`):

```bash
mkdir -p existing-app && cd existing-app
cat > app.py <<'PY'
from flask import Flask, jsonify, request
app = Flask(__name__)
ENTRIES = []

@app.get("/entries")
def entries():
    return jsonify(ENTRIES)

@app.post("/entries")
def add():
    body = request.get_json()
    ENTRIES.append({"what": body["what"], "amount": float(body["amount"])})
    return jsonify(ENTRIES[-1]), 201
PY
printf 'flask\n' > requirements.txt
```

and set `base-folder: existing-app` in `config.turri.yaml`. Flask's default port is 5000, which macOS's AirPlay Receiver often holds; if nothing holds it here, hold it yourself (`tmux new-window -d -t <session> -n squatter 'python3 -m http.server 5000'`) to see the first launch meet it - unless the stdlib's 8000 applies (the chat may leave the Flask template out).

1. > This project has an existing Flask app in existing-app: a ledger of entries, each with what and amount. Keep
   > what it does. Add `GET /balance`, the sum of every entry's amount.
2. At `started:1`:
   > `POST /entries` refuses an amount that is not a number, with 400 and `{"error": "amount must be a number"}`.

Compare old and new behaviour from copies under `$RUN` (or `python -B`) - importing from `existing-app` writes `__pycache__` into the base folder. Check: `code/.turri-base.json` records the base; `app.py`'s two endpoints still behave as before; the new ones work. Watch whether the chat's \*\*\*plain describes the existing behaviour or only the additions, and whether a pulse rewrote what it was not asked to.

## steer-storm

Three changes to the functional spec a running pulse is building. Two steer it; the third must stop it and leave the change to the next pulse (`docs/regenerating.md`, "A change inside what the running job regenerates steers it").

1. > Let's build `greet`, a Python CLI: `greet <name>` prints `Hello, <name>!`.
2. At `started:1`, then each time the chat's turn ends, while that pulse still runs:
   > `greet` prints `Hi, <name>!` instead.

   > `greet` prints `Hi, <name>.` - a full stop, not an exclamation mark.

   > `greet` prints `Hi there, <name>.`

A steer shows as another `job.diff` event for the same pulse (`ledger.mjs summary` counts them) and, in the coding agent's saved session (`.turri/sessions/`), as a user message `The spec changed while you work…` - not in the job log. Expected: the first two each a `⇢ steered`, the third stops the pulse (or, under `allow-to-stop-jobs: false`, leaves it to the next); whatever lands at the end prints `Hi there, <name>.`. A pulse that is too quick to steer three times is "not exercised" - say so, and try again with a bigger first message.

## crash-mid-pulse

On any example: kill turri while a pulse is truly mid-way - its agent at work, its first unit test run not yet passed (the pulse line on the screen shows the stage) - not seconds before it lands. `kill -9` turri's own process: the pid ending the newest ledger file's name (`.turri/ledger/…-p<pid>.jsonl`), not the pane's. Then start `caffeinate -is turri --continue` in a new tmux session in the project folder, and tell the chat `turri was killed mid-pulse and restarted - carry on.`: nothing is reset or planned again until the person speaks.

Expected, once you have spoken: the half-done work is undone (`history.reset` or a rollback - `plain_modules/<m>` matches its last commit, `git status` clean apart from ignored files); the work loop plans it again and the pulse runs from the start; nothing it half-wrote is in what lands; a left-behind launch is stopped (`launch.left-behind`). Then finish the base example.

## stack smoke

One per stdlib stack family, to see each builds, tests and launches. Two messages: the first, and the second at `started:1`. Name the stack in the first so the chat picks it.

| stack | first message | second message |
| --- | --- | --- |
| `backend/go-gin` (Go 1.25 - set `GOROOT` with a user-installed Go) | A Go Gin API: `GET /ping` returns `{"pong": true}`. | `GET /echo?msg=<text>` returns `{"msg": "<text>"}`, 400 when msg is missing. |
| `backend/typescript-express` | A TypeScript Express API keeping notes in memory: `POST /notes` with `{"text"}`, `GET /notes`. | `DELETE /notes/<id>` removes one, 404 when there is none. |
| `backend/rust-axum` | A Rust Axum API: `GET /add?a=&b=` returns the sum of two integers. | 400 with a message when a or b is not an integer. |
| `cli/typescript-commander` | A TypeScript CLI, `slug <text>`: lowercase, words joined by hyphens, everything else dropped. | `--max <n>` cuts the slug to at most n characters, never mid-word. |
| `cli/rust-clap` | A Rust CLI, `roll <NdM>`: rolls N M-sided dice and prints each and the total. | `--seed <n>` makes the rolls repeatable. |
| `library/typescript` | A TypeScript library: `chunk(array, size)` splits an array into arrays of at most size. | `size` below 1 throws a RangeError. |
| `frontend/react-vite` | A React page on its own, no backend: a counter with + and - buttons. | A reset button, and the count never goes below zero. |
| `backend/java-springboot` | A Spring Boot API: `GET /hello?name=` returns `Hello, <name>`. | `name` missing returns `Hello, world`. Slow to build - run it last. |

Before the first message, check the stack's extra tools as run-turri's step 4 says - Rust's `rustfmt` and `clippy` (`rustup component list --installed`), the version `stdlib/lang/<language>.plain` pins. Try each against what the two messages say - a server at its URL; a CLI or library from what the launch left in `dist/<module>`, an unbuilt `dist/` a finding. Run the backend stacks one at a time - each listens on 8000. A frontend's port (5173, 4173) may be held by the person's own dev server: the notice then offers only to launch once it is free - answer `Say what to do instead…` with `Launch it on another port.`, and never stop the person's server. Record per stack: landed or not, wall-clock to first landed pulse, launched or not and on which port, the toolchain it used.
