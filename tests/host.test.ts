import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { askUserVia, chatAskUserTool, createTurriCore, NO_USER_ANSWER, type TurriHost } from "../src/extension.ts";
import { sideQuestionPrompt } from "../src/btw.ts";
import { TURRI_IDENTITY } from "../src/identity.ts";
import { stopJob } from "../src/loop-tools.ts";
import { CONFORMANCE_OFF_REFUSAL } from "../src/conformance-switch.ts";
import { record, startLedger, stopLedger } from "../src/regenerate/ledger.ts";
import { refusal, TOOLS_NOT_CLI } from "../src/self-invocation.ts";
import { NEW_PROJECT } from "../src/new-project.ts";
import type { AskUserIO } from "../src/ask.ts";
import type { Job, JobRegistry } from "../src/regenerate/jobs.ts";

// No test calls a model: a pulse that fails for good is diagnosed by an agent on the coding model - here, by none.
vi.mock("../src/regenerate/diagnose.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/regenerate/diagnose.ts")>()),
  diagnoseFailure: async () => undefined,
}));

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
  createTurriCore(host).extension(pi);
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

  it("with nobody to answer - print mode - has the agent decide what is its own and leave the person's files as they are", async () => {
    const answer = await askUserVia({ hasUI: false } as never, () => {})({ question: "Should I rewrite the unit testing script?", options: ["Yes", "No"] });
    expect(answer).toBe(NO_USER_ANSWER);
    expect(answer).toContain("Decide yourself what is yours to decide");
    expect(answer).toContain("their testing scripts, their config, any file of theirs you would replace or delete - leave as it is");
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

  it("hands the host the session's jobs, and tells it of each job as it changes and ends", async () => {
    const changes: Array<Pick<Job, "id" | "status">> = [];
    const session = createTurriCore({ onJobChange: (job) => changes.push({ id: job.id, status: job.status }) });
    session.extension(quietPi());
    const registry: JobRegistry = session.jobs;
    const job = registry.start({ kind: "test", summary: "a job the host sees", run: async () => ({ report: "done" }) });
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

  it("tells the conversation to start a new project itself, without offering a skill", async () => {
    const prompt = await systemPromptFor();
    expect(prompt).toContain(`${TOOLS_NOT_CLI}\n\n${NEW_PROJECT}`);
    expect(NEW_PROJECT).toContain("start it yourself, without asking how");
    expect(NEW_PROJECT).not.toContain("/brood");
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
    const jobs = createTurriCore({ surface: SURFACE }).jobs;
    expect(stopJob(jobs, "nope")).toBe("No pulse nope. The pulses tool lists them.");
    const terminalJobs = createTurriCore({}).jobs;
    expect(stopJob(terminalJobs, "nope")).toBe("No pulse nope. /pulses shows them.");

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

  /** A project with a skill of its own that only the person starts - none of turri's own is - and turri run in it. */
  function inProject<T>(work: (project: string) => Promise<T>): Promise<T> {
    const project = mkdtempSync(join(tmpdir(), "turri-picked-"));
    const own = join(project, ".turri", "skills", "kickoff");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "SKILL.md"), "---\nname: kickoff\ndescription: start a project.\nallowed-tools: [read]\nmetadata:\n  command-only: true\n---\n\nStart it.\n");
    const before = process.cwd();
    process.chdir(project);
    return work(project).finally(() => process.chdir(before));
  }

  it("have a command each, which puts what was typed in the chat as the person's message", () =>
    inProject(async () => {
      const { pi, commands, sent } = registeringPi();
      createTurriCore().extension(pi);
      expect(commands.has("kickoff")).toBe(true);
      expect(commands.has("analyze-func-specs")).toBe(false);
      await commands.get("kickoff")!.handler("  a small server ", {});
      expect(sent).toEqual(["/kickoff a small server"]);
    }));

  it("are refused when the model starts one without the person's command", () =>
    inProject(async () => {
      const { pi, tools } = registeringPi();
      createTurriCore().extension(pi);
      const result = await tools.get("cultivate")!.execute("id", { skill: "kickoff" }, undefined, undefined, { hasUI: false });
      expect(result.content[0]!.text).toContain("Not started: kickoff is started only by the person, with /kickoff");
    }));

  it("start from an option starting with their command, picked in the conversation's question", () =>
    inProject(async (project) => {
      // An interrupted run of kickoff here: cultivate, let through, stops at it instead of running the skill.
      mkdirSync(join(project, ".turri", "runs", "kickoff"), { recursive: true });
      writeFileSync(join(project, ".turri", "runs", "kickoff", "run.json"), JSON.stringify({ skill: "kickoff", status: "running", updatedAt: "now" }));
      const { pi, tools } = registeringPi();
      const { dialogs } = hostDialogs((options) => options.find((option) => option.startsWith("/kickoff")));
      createTurriCore({ dialogs }).extension(pi);
      const cultivate = () => tools.get("cultivate")!.execute("id", { skill: "kickoff" }, undefined, undefined, { hasUI: false });
      expect((await cultivate()).content[0]!.text).toContain("Not started");
      const picked = await tools.get("ask_user")!.execute("q", { question: "How shall I start it?", options: ["/kickoff - something running in minutes", "Just do it - no skill"] }, undefined, undefined, { hasUI: false });
      expect(picked.content.map((part) => part.text).join("\n")).toContain('call cultivate with skill "kickoff" at once');
      expect((await cultivate()).content[0]!.text).toContain("There is an interrupted run of kickoff here");
    }));
});

describe("the pulses tool", () => {
  /** turri's extension built into a pi that keeps the tools it registers, in a folder of its own. */
  function chatTools() {
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
    const pi = new Proxy({}, {
      get: (_target, key) =>
        key === "registerTool" ? (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }) => tools.set(tool.name, tool) : () => undefined,
    }) as never;
    const core = createTurriCore();
    core.extension(pi);
    const pulse = async (id: string) => (await tools.get("pulses")!.execute("call", { job_id: id }, undefined, undefined, { hasUI: false })).content[0]!.text;
    return { core, tools, pulse };
  }

  it("is the one tool for a pulse and the runs before - no diagnose or ledger beside it", () => {
    const { tools } = chatTools();
    expect(tools.has("pulses")).toBe(true);
    expect(tools.has("diagnose")).toBe(false);
    expect(tools.has("ledger")).toBe(false);
  });

  it("says why a pulse did not land - its diagnosis and the stages that went wrong - and only its report for one that landed", async () => {
    const before = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), "turri-pulses-")));
    try {
      const { core, pulse } = chatTools();
      const failed = core.jobs.start({ kind: "regenerate", summary: "app pulse 1", module: "app", run: async () => ({ report: "", details: { passed: false, landed: false } }) });
      await core.jobs.wait(failed.id);
      core.jobs.get(failed.id)!.diagnosis = "The tests import a module the code never wrote.";
      const told = await pulse(failed.id);
      expect(told).toContain("<diagnosis>\nThe tests import a module the code never wrote.\n</diagnosis>");
      // One that landed after a struggle: its report, and the ledger's facts - the failing rounds - with it.
      startLedger({ mode: "chat", project: process.cwd() });
      const landed = core.jobs.start({
        kind: "regenerate",
        summary: "app pulse 2",
        module: "app",
        lanes: [join(process.cwd(), "plain_modules", "app", "code")],
        run: async () => {
          for (const round of [1, 2, 3]) record({ kind: "gate.round", gate: "unit tests", round, of: 20 });
          return { report: "Built say-hello.", details: { passed: true, landed: true } };
        },
      });
      await core.jobs.wait(landed.id);
      const fine = await pulse(landed.id);
      stopLedger();
      expect(fine).toContain("Built say-hello.");
      expect(fine).not.toContain("<diagnosis>");
      expect(fine).toContain("What the ledger recorded of it:");
      expect(fine).toContain("rounds: unit tests 3 of 20");
    } finally {
      process.chdir(before);
    }
  });
});

describe("the conform tool while conformance tests are off", () => {
  it("is refused, sending the chat to the person with why - it never turns them on itself", async () => {
    const before = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), "turri-conform-off-")));
    try {
      writeFileSync("app.plain", "***implementation reqs***\n\n- :Implementation: is Python.\n\n***functional specs***\n\n# say-hello\nSay hello.\n");
      const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
      const pi = new Proxy({}, {
        get: (_target, key) =>
          key === "registerTool" ? (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }) => tools.set(tool.name, tool) : () => undefined,
      }) as never;
      createTurriCore().extension(pi);
      expect(tools.has("turn_on_conformance_tests")).toBe(false);
      const result = await tools.get("conform")!.execute("call", { plain_file: "app.plain" }, undefined, undefined, { hasUI: false });
      expect(result.content[0]!.text).toBe(CONFORMANCE_OFF_REFUSAL);
      expect(existsSync("config.turri.yaml")).toBe(false);
    } finally {
      process.chdir(before);
    }
  });
});

describe("config settings for a host", () => {
  it("lists every setting /settings changes, rules-off offering turri's own rules, and reads what the file has", async () => {
    const host = await import("../src/host.ts");
    const keys = host.configSettings().map((setting) => setting.key);
    expect(keys).toEqual(expect.arrayContaining(["harness-model", "review", "mutation-testing", "launch-after-pulse", "parallel-jobs", "models.coding"]));
    const review = host.configSettings().find((setting) => setting.key === "review")!;
    expect(review).toMatchObject({ kind: "boolean", unset: "true" });
    expect(host.EFFECT_TEXT[review.effect]).toMatch(/next pulse/);
    expect(host.configSettings().find((setting) => setting.key === "rules-off")!.options).toContain("turri-regeneration");
    expect(host.currentValue("review: false\nmodels:\n  coding: anthropic/claude-opus-5-5:low\n", "models.coding")).toBe("anthropic/claude-opus-5-5:low");
  });
});
