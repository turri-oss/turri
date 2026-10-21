import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServiceTools } from "../../src/regenerate/services.ts";
import { withPulse } from "../../src/regenerate/shell.ts";

let root: string;
let code: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "turri-services-")));
  code = join(root, "plain_modules", "app", "code");
  mkdirSync(code, { recursive: true });
  writeFileSync(join(code, "index.html"), "hello from app\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }> };
const call = async (tools: unknown[], name: string, params: object) =>
  (await (tools as Tool[]).find((tool) => tool.name === name)!.execute("id", params, undefined, undefined, {})).content.map((part) => part.text ?? "").join("");

/** A port nothing listens on now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise((done) => server.close(done));
  return port;
}

const reach = (port: number, path = "/") =>
  fetch(`http://127.0.0.1:${port}${path}`).then(
    (response) => response.text(),
    () => "down",
  );

/**
 * A worker that counts in `beat` ten times a second, and whether it still does: its own pid is no use to the test, as
 * behind bubblewrap's pid namespace `$$` is not a pid on this machine.
 */
const WORKER = "i=0; echo ready; while :; do i=$((i+1)); echo $i > beat; sleep 0.1; done";
async function beating(dir: string): Promise<boolean> {
  const read = () => (existsSync(join(dir, "beat")) ? readFileSync(join(dir, "beat"), "utf8") : "");
  const before = read();
  await new Promise((done) => setTimeout(done, 500));
  return read() !== before;
}

describe.skipIf(process.platform === "win32")("a service an agent starts on this machine", () => {
  it("runs until it is up, answers from outside, prints to a log - and is stopped, it and what it started", async () => {
    const port = await freePort();
    const services = createServiceTools({ dir: code });
    const up = await call(services.tools, "start_service", { name: "web", command: `python3 -m http.server ${port}`, port });
    expect(up).toContain(`web is up on port ${port}`);
    expect(await reach(port, "/index.html")).toBe("hello from app\n");
    expect(await call(services.tools, "service_logs", { name: "web" })).toContain('"GET /index.html HTTP/1.1" 200');
    expect(await call(services.tools, "start_service", { name: "web", command: "true" })).toContain("is running already");

    expect(await call(services.tools, "stop_service", { name: "web" })).toBe("web is stopped.");
    expect(await reach(port)).toBe("down");
  });

  it("says what it printed when it exits before it is up, and stops whatever is left when the agent's session ends", async () => {
    const services = createServiceTools({ dir: code });
    const failed = await call(services.tools, "start_service", { name: "broken", command: "echo cannot bind to port; exit 2", port: await freePort() });
    expect(failed).toContain("It exited before it was up");
    expect(failed).toContain("cannot bind to port");

    expect(await call(services.tools, "start_service", { name: "worker", command: WORKER, ready_log: "ready" })).toContain("worker is up");
    expect(await beating(code)).toBe(true);
    await services.stopAll();
    expect(await beating(code)).toBe(false);
  });

  it("is stopped when its pulse ends, though nothing asked", async () => {
    await withPulse(async () => {
      const services = createServiceTools({ dir: code });
      await call(services.tools, "start_service", { name: "worker", command: WORKER, ready_log: "ready" });
      expect(await beating(code)).toBe(true);
    });
    expect(await beating(code)).toBe(false);
  });

  it("is not started when the command check refuses it - the same check as the agent's shell", async () => {
    const services = createServiceTools({ dir: code });
    const refused = await call(services.tools, "start_service", { name: "web", command: `cat ${root}/app.plain; python3 -m http.server 8000`, port: 8000 });
    expect(refused).toMatch(/^Not started: .*is outside what this command may reach/);
  });

  it("starts in the module's own environment, not the person's", async () => {
    const services = createServiceTools({ dir: code });
    await call(services.tools, "start_service", { name: "env", command: 'echo "home=$HOME"; echo up; sleep 5', ready_log: "up" });
    expect(await call(services.tools, "service_logs", { name: "env" })).toContain(`home=${join(root, "plain_modules", ".turri", "home", "app")}`);
    await services.stopAll();
  });
});
