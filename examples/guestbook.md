# A backend and a frontend, quickly: guestbook

You will build **guestbook**, the smallest app with both halves: a backend API that keeps messages, and a web page that shows them and lets you sign. It is two modules on two stacks, each with its own testing scripts, written in one interview and regenerated at the same time.

It takes twenty minutes or so, most of it the agents' time. You need the toolchain of the backend's language and Node with npm for the web app; `turri doctor` lists what is there.

## 1. The project

```bash
mkdir ~/guestbook && cd ~/guestbook
turri init-config
turri
```

## 2. Say what you want

> /brood Let's build guestbook: a backend API and a web app, both at once. The backend keeps messages in memory:
> `POST /messages` with `{"name", "text"}` adds one - both required, `text` at most 280 characters - and
> `GET /messages` lists them, newest first. The web app is one page that lists the messages, newest first, with
> a form to sign the guestbook.

`/brood` starts the interview, with your words as its brief. Keep it short:

- **How many questions.** Choose **light**. Your message says most of it, and what it leaves open **turri** decides itself and names in each phase's summary.
- **Stack.** A backend stack and a frontend stack from the standard library your machine can build - FastAPI and React are quick. It writes `backend.plain` and `frontend.plain`, and each module's unit testing script, named in a stack file after the module - `config.turri.backend.yaml`, `config.turri.frontend.yaml` - so each module is built with its own, with nothing to choose.
- **Testing.** Say **no** to conformance tests: it keeps the builds quick.
- **Product.** A question or two. Each answer is a spec change that starts regenerating at once - in the backend, the web app, or both.

## 3. Watch both regenerate

The two modules share nothing but what the specs say about the API, so their pulses run at the same time, each with its own testing scripts. The panel above the input shows a pulse running for each, and `ctrl+h` opens regen with a row for each module.

## 4. Try it

When both are built:

> Release both, and tell me where to open the web app.

**turri** starts the backend and the web app on this machine, the web app pointed at the backend, and says where each runs. Sign the guestbook, reload, and your message is there - until the backend restarts, as it keeps them in memory.

## 5. Change your mind

> Messages should show how long ago they were posted - "3 minutes ago".

The backend has to say when each was posted and the page has to show it, so the change is written into both specs and regenerated in both modules, each on its own stack.

## Where next

- [Stacks](../docs/config.md#stacks) - each part's testing scripts in its own `config.turri.<stack>.yaml`, and which stack builds which module.
