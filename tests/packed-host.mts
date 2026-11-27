// A desktop consumer, compiled and run by scripts/package-check.mjs from inside the clean install.
import assert from "node:assert/strict";
import { join } from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { createTurri, createJobRegistry, createWorkLoop, functionalityCompletion, projectStanding, pi, type JobRegistry, type WorkLoop } from "@turri-dev/cli/host";

const cwd = process.cwd();
const file = join(cwd, "app.plain");
const looker = createWorkLoop({ cwd, registry: createJobRegistry(), planner: false });
assert.deepEqual(projectStanding(cwd, { loop: looker, files: [file] })[0]?.completion, functionalityCompletion(file));
const host = await createTurri({ agentDir: process.env.PI_CODING_AGENT_DIR, sessionDir: join(cwd, "sessions") });
try {
  const jobs: JobRegistry = host.jobs;
  assert.deepEqual(jobs.list(), []);
  assert.throws(() => host.loop, /No chat is open/);
  const chat = await host.openChat();
  assert.ok(chat.session instanceof pi.AgentSession);
  assert.ok(chat.session instanceof AgentSession);
  const loop: WorkLoop = host.loop;
  assert.equal(host.loop, loop);
  assert.deepEqual(loop.drift(file), looker.drift(file));
  assert.deepEqual(jobs.list(), []);
} finally {
  await host.dispose();
}
