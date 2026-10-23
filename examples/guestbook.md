# A backend and a frontend, growing together: guestbook

You will build **guestbook**: a backend API that keeps messages, and a dedicated frontend - a web app of its own, run apart from the backend and talking to it only over its API. It starts as a page that only lists messages, and grows a form, a length limit and timestamps while it regenerates. Backend and frontend are two modules on two stacks, regenerated side by side.

You need the toolchain of the backend's language, and Node with npm for the frontend. `turri doctor` lists what is there.

```bash
mkdir ~/guestbook && cd ~/guestbook
turri init-config
turri
```

## 1. The smallest thing: a list of messages

> Let's build a guestbook: a FastAPI backend, and a separate React frontend that calls its API. The backend keeps
> messages in memory - `POST /messages` with `{"name", "text"}` adds one, and `GET /messages` lists them, newest
> first. The frontend is one page that lists them. Nothing else yet.

**turri** writes `backend.plain` and `frontend.plain`, each importing its stack from the standard library - `stdlib/backend/python-fastapi` and `stdlib/frontend/react-vite` - and each module's unit testing script. Each script is named in a stack file after its module - `config.turri.backend.yaml` and `config.turri.frontend.yaml` - so each module is built with its own. The frontend is its own codebase in `plain_modules/frontend`: a single-page app built into `dist/` and served on a port of its own. It reaches the backend at the base URL it is built with - `VITE_API_URL` - and only through its API layer, one typed function per call. It never shares code with the backend. Then **turri** starts regenerating both modules at once. The two share nothing but what their \*\*\*plain says about the API, so their pulses run side by side.

## 2. Add a feature while it regenerates

Don't wait for the first pulses. Say the next thing now:

> Add a form on the page to sign the guestbook: a name and a message, and the new message appears at the top
> without reloading.

That is a \*\*\*plain change to `frontend.plain`. The page's first pulse is still running, and it goes on: the form is new work, regenerated in a pulse of its own once the list has landed. The backend already has `POST /messages`, so it has nothing to do.

## 3. Try what has landed

Each pulse that lands is released and running: the backend on its port, and the frontend on its own, pointed at the backend. Ask where to open it:

> Where is the frontend running?

The list is there. The form may still be regenerating: try it again once its pulse lands. The sentinel tries each release too, and tells you in the chat when something does not work.

## 4. Change a rule mid-build

While the form regenerates:

> A message is at most 280 characters, and the form says how many are left.

The backend's pulse for the limit is new work. The form's pulse is building the functional spec you just changed, so it is not stopped: it is **steered**. Its coding agent is told about the change in its next turn, and the pulse lands the form as it now reads, counter included. Nothing is rolled back, and nothing is built twice.

## 5. A change across both modules

> Messages should show how long ago they were posted - "3 minutes ago".

The backend has to say when each message was posted, and the page has to show it. So the change goes into both modules' \*\*\*plain, and is regenerated in both, side by side, each on its own stack. Reload once both have landed.

## Try it: regenerate from scratch

The \*\*\*plain is the software; the code is just one regeneration of it. Delete the frontend's code and regenerate it from its \*\*\*plain alone - every feature you added along the way, built again from the start, the backend left as it is:

```
/regenerate frontend from scratch
```

It starts at once, and the code it deletes stays in `/lineage`. The new code will not be the same code, but it does what the \*\*\*plain says - try it again and see.

## Where next

- [tidy](tidy.md) - trying one command while the next regenerates, and dropping a feature mid-build.
- [Stacks](../docs/config.md#stacks) - each part's testing scripts in its own `config.turri.<stack>.yaml`.
