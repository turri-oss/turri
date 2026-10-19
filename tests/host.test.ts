import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { askUserVia, chatAskUserTool, createTurriExtension } from "../src/extension.ts";
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

  it("publishes the host entry, compiled, as @turri-dev/cli/host", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { exports: Record<string, { import?: string; types?: string }> };
    expect(manifest.exports["./host"]).toEqual({ types: "./dist/host.d.ts", import: "./dist/host.js" });
  });
});
