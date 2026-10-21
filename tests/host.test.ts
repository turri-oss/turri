import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askUserVia, chatAskUserTool, createTurriExtension, type TurriHost } from "../src/extension.ts";
import { sideQuestionPrompt } from "../src/btw.ts";
import { TURRI_IDENTITY } from "../src/identity.ts";
import { stopJob } from "../src/loop-tools.ts";
import { refusal, TOOLS_NOT_CLI } from "../src/self-invocation.ts";
import type { AskUserIO } from "../src/ask.ts";
import type { Job, JobRegistry } from "../src/regenerate/jobs.ts";

/** A host's dialogs that answer each question with `answer`, keeping what they were asked. */
function hostDialogs(answer: (options: string[]) => string | undefined) {
  const asked: Array<{ title: string; options?: string[]; context?: string }> = [];
  const dialogs: AskUserIO = {
    select: async (title, options, context) => {
      asked.push({ title, options, ...(context !== undefined ? { context } : {}) });
      return answer(options);
    },
    input: async (title, context) => {
      asked.push({ title, ...(context !== undefined ? { context } : {}) });
      return answer([]);
    },
  };
  return { dialogs, asked };
}

/** pi as the extension sees it, doing nothing with what is registered: enough for the extension to set itself up. */
const quietPi = () => new Proxy({}, { get: () => () => undefined }) as never;

/** pi keeping the extension's handlers, so a turn's start can be run through them as pi runs it. */
function handlersPi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const pi = new Proxy({}, {
    get: (_target, key) =>
      key === "on" ? (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]) : () => undefined,
  }) as never;
  return { pi, handlers };
}

/** The system prompt a turn starts with, turri's before_agent_start handlers run over pi's own, in order, as pi chains them. */
async function systemPromptFor(host?: TurriHost, base = "pi's own prompt"): Promise<string> {
  const { pi, handlers } = handlersPi();
  createTurriExtension(host)(pi);
  let prompt = base;
  for (const handler of handlers.get("before_agent_start") ?? []) {
    const result = (await handler({ systemPrompt: prompt, systemPromptOptions: { skills: [] } }, { hasUI: false })) as { systemPrompt?: string } | undefined;
    if (result?.systemPrompt !== undefined) prompt = result.systemPrompt;
  }
  return prompt;
}

const SURFACE = "The person uses the desktop app. The Pulses view lists every pulse; its Halt button stops one.";

describe("turri for a host that runs it itself", () => {
  it("puts ask_user's question in the host's own dialogs, with no terminal to draw one", async () => {
    const { dialogs, asked } = hostDialogs((options) => options[1]);
    const kept: string[] = [];
    const answer = await askUserVia({ hasUI: false } as never, (question, answered) => kept.push(`${question} ${answered}`), undefined, dialogs)({
      question: "Which CRM first?",
      options: ["HubSpot", "Salesforce"],
      context: "Both have an API.",
    });
    expect(answer).toBe("Salesforce");
    expect(asked[0]).toMatchObject({ title: "Which CRM first?", context: "Both have an API." });
    expect(asked[0]!.options).toEqual(expect.arrayContaining(["HubSpot", "Salesforce"]));
    expect(kept).toEqual(["Which CRM first? Salesforce"]);
  });

  it("asks the conversation's ask_user in the host's dialogs too", async () => {
    const { dialogs } = hostDialogs((options) => options[0]);
    const tool = chatAskUserTool(dialogs);
    const result = await (tool.execute as (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>)(
      "id",
      { question: "Ship it?", options: ["Yes", "Not yet"] },
      undefined,
      undefined,
      { hasUI: false },
    );
    expect(result.content[0]!.text).toContain("Yes");
  });

  it("hands the host the conversation's jobs, and tells it of each job as it changes and ends", async () => {
    let registry: JobRegistry | undefined;
    const changes: Array<Pick<Job, "id" | "status">> = [];
    createTurriExtension({ onJobs: (jobs) => (registry = jobs), onJobChange: (job) => changes.push({ id: job.id, status: job.status }) })(quietPi());
    expect(registry).toBeDefined();
    const job = registry!.start({ kind: "test", summary: "a job the host sees", run: async () => ({ report: "done" }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(changes.filter((change) => change.id === job.id).map((change) => change.status)).toContain("succeeded");
  });

  it("writes a project's first config.turri.yaml with the models of the vendor the host chose", async () => {
    const { initConfig, VENDORS } = await import("../src/host.ts");
    const dir = mkdtempSync(join(tmpdir(), "turri-host-"));
    const result = await initConfig(dir, { vendor: "anthropic" });
    const written = readFileSync(join(dir, "config.turri.yaml"), "utf8");
    expect(result.written).toBe(true);
    expect(written).toContain(`harness-model: ${VENDORS.anthropic.harness}`);
    expect(written).toContain(`coding-model: ${VENDORS.anthropic.coding}`);
  });

  it("gives a host the ledger, to hear live and to read back earlier sessions' pulses", async () => {
    const host = await import("../src/host.ts");
    for (const name of ["onLedgerEvent", "readLedger", "ledgerDir", "runViews", "pulseView", "describePulseView", "describeRuns", "ledgerProjects", "earlierPulses", "asJob"] as const) {
      expect(typeof host[name], name).toBe("function");
    }
  });

  it("publishes the host entry, compiled, as @turri-dev/cli/host", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { exports: Record<string, { import?: string; types?: string }> };
    expect(manifest.exports["./host"]).toEqual({ types: "./dist/host.d.ts", import: "./dist/host.js" });
  });
});

describe("what a host says of its own surface", () => {
  it("leaves the terminal's prompt as it is when the host describes none", async () => {
    const prompt = await systemPromptFor({});
    expect(prompt).toBe(await systemPromptFor());
    expect(prompt.startsWith(`pi's own prompt\n\n${TURRI_IDENTITY}\n\n${TOOLS_NOT_CLI}\n\n`)).toBe(true);
    expect(prompt).toContain("regen is the side panel (ctrl+h)");
    expect(prompt).not.toContain("<surface>");
  });

  it("tells the model the host's surface in place of the terminal's keys, side panel, regen and /pulses", async () => {
    const prompt = await systemPromptFor({ surface: SURFACE });
    expect(prompt).toContain(`<surface>\n${SURFACE}\n</surface>\n</turri>`);
    for (const terminal of ["ctrl+h", "ctrl+", "side panel", "/pulses", "regen is", "Say regen"]) expect(prompt, terminal).not.toContain(terminal);
  });

  it("hands the host the whole prompt as turri built it, and sends what it returns", async () => {
    let seen = "";
    const prompt = await systemPromptFor({
      surface: SURFACE,
      systemPrompt: (built) => {
        seen = built;
        return `${built}\n\n<app>the host's own words</app>`;
      },
    });
    expect(seen).toContain("pi's own prompt");
    expect(seen).toContain(`<surface>\n${SURFACE}\n</surface>`);
    expect(seen).toContain(TOOLS_NOT_CLI);
    expect(prompt).toBe(`${seen}\n\n<app>the host's own words</app>`);
  });

  it("says the host's words deep in the tools and side questions too - a pulse not found, a run refused", () => {
    let jobs: JobRegistry | undefined;
    createTurriExtension({ surface: SURFACE, onJobs: (registry) => (jobs = registry) })(quietPi());
    expect(stopJob(jobs!, "nope")).toBe("No pulse nope. The pulses tool lists them.");
    let terminalJobs: JobRegistry | undefined;
    createTurriExtension({ onJobs: (registry) => (terminalJobs = registry) })(quietPi());
    expect(stopJob(terminalJobs!, "nope")).toBe("No pulse nope. /pulses shows them.");

    expect(refusal("regenerate")).toContain("the panel and /halt");
    expect(refusal("regenerate", SURFACE)).not.toContain("panel");

    const side = { question: "Why?", conversation: "", pulses: [], projectDir: "/p", harnessDir: "/t" };
    expect(sideQuestionPrompt(side)).toContain("ctrl+h");
    const hosted = sideQuestionPrompt({ ...side, surface: SURFACE });
    expect(hosted).toContain(SURFACE);
    expect(hosted).not.toContain("ctrl+h");
  });
});

describe("the skills the person starts with a command", () => {
  /** pi keeping the commands and tools the extension registers, and the messages it sends as the person. */
  function registeringPi() {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
    const sent: string[] = [];
    const pi = new Proxy({}, {
      get: (_target, key) =>
        key === "registerCommand"
          ? (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command)
          : key === "registerTool"
            ? (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }) => tools.set(tool.name, tool)
            : key === "sendUserMessage"
              ? (text: string) => sent.push(text)
              : () => undefined,
    }) as never;
    return { pi, commands, tools, sent };
  }

  it("have a command each, which puts what was typed in the chat as the person's message", async () => {
    const { pi, commands, sent } = registeringPi();
    createTurriExtension()(pi);
    for (const name of ["brood", "spawn", "bud"]) expect(commands.has(name), name).toBe(true);
    expect(commands.has("add-concept")).toBe(false);
    await commands.get("spawn")!.handler("  a small server ", {});
    expect(sent).toEqual(["/spawn a small server"]);
  });

  it("are refused when the model starts one without the person's command", async () => {
    const { pi, tools } = registeringPi();
    createTurriExtension()(pi);
    const result = await tools.get("cultivate")!.execute("id", { skill: "spawn" }, undefined, undefined, { hasUI: false });
    expect(result.content[0]!.text).toContain("Not started: spawn is started only by the person, with /spawn");
  });
});

describe("config settings for a host", () => {
  it("lists every setting /turri-config changes, rules-off offering turri's own rules, and reads what the file has", async () => {
    const host = await import("../src/host.ts");
    const keys = host.configSettings().map((setting) => setting.key);
    expect(keys).toEqual(expect.arrayContaining(["harness-model", "review", "mutation-testing", "release-after-pulse", "parallel-jobs", "models.coding"]));
    const review = host.configSettings().find((setting) => setting.key === "review")!;
    expect(review).toMatchObject({ kind: "boolean", unset: "true" });
    expect(host.EFFECT_TEXT[review.effect]).toMatch(/next pulse/);
    expect(host.configSettings().find((setting) => setting.key === "rules-off")!.options).toContain("turri-regeneration");
    expect(host.currentValue("review: false\nmodels:\n  coding: anthropic/claude-opus-5-5:low\n", "models.coding")).toBe("anthropic/claude-opus-5-5:low");
  });
});
