import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChatLink } from "../src/chats.ts";
import { doneLine, failedTask, ownChanges, runDetails, skillRunDelivery, startedText } from "../src/background-skills.ts";

describe("a skill run in the background", () => {
  it("is said to be running as it starts - on which model, for which module - and the chat told to go on, not wait", () => {
    const text = startedText("implement-unit-testing-script", { model: "anthropic/claude-sonnet-5-5", plainFile: "app.plain", kind: "unit" });
    expect(text).toContain("implement-unit-testing-script is writing the unit testing script for app.plain in the background, on anthropic/claude-sonnet-5-5.");
    expect(text).toContain("Do not wait for it");
    expect(text).toContain("a module's pulses wait for its unit testing script while it is written");
  });

  it("that wrote its script ends in a line naming the file", () => {
    expect(doneLine("implement-conformance-testing-script", ["test_scripts/run_conformance_tests_python.sh"], "conformance")).toBe(
      "Conformance testing script written: test_scripts/run_conformance_tests_python.sh.",
    );
    expect(doneLine("tidy", ["notes.md"])).toBe("tidy finished in the background: notes.md.");
  });

  it("that did not ends in a task for the chat: why, what it said, what it holds up - asking the person nothing", () => {
    const task = failedTask("implement-unit-testing-script", "ended having changed no file in the project", "No test framework to go by.", "unit");
    expect(task).toContain("implement-unit-testing-script, which you started in the background, ended having changed no file in the project.");
    expect(task).toContain("<artifact>\nNo test framework to go by.\n</artifact>");
    expect(task).toContain("the module's pulses cannot be built until it has a unit testing script");
    expect(task).toContain("Ask the person nothing.");
  });
});

describe("what a host is told of a background run", () => {
  it("is the script it writes and the module it is for, each left out when there is none", () => {
    expect(runDetails("unit", "hello.plain")).toEqual({ kind: "unit", plainFile: "hello.plain" });
    expect(runDetails("conformance", undefined)).toEqual({ kind: "conformance" });
    expect(runDetails(undefined, "hello.plain")).toEqual({ plainFile: "hello.plain" });
    expect(runDetails(undefined, undefined)).toEqual({});
  });

  it("names every run that did not do its work in the one message they send - its skill, script and module - and none that did", async () => {
    const entries: Array<{ type: string; data: unknown }> = [];
    const messages: Array<{ message: { customType: string; content: string; details?: unknown }; options: unknown }> = [];
    const pi = {
      registerEntryRenderer: () => {},
      on: () => {},
      appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
      sendMessage: async (message: { customType: string; content: string; details?: unknown }, options: unknown) => {
        messages.push({ message, options });
      },
    } as unknown as ExtensionAPI;
    // An idle chat: its agent done, nobody typing.
    const link = { session: () => ({ isStreaming: false, isCompacting: false, isRetrying: false }) } as unknown as ChatLink;
    const delivery = skillRunDelivery(pi, link, () => undefined);
    delivery.put({ skill: "implement-unit-testing-script", ok: false, line: "x", task: "the unit one failed", kind: "unit", plainFile: "hello.plain" });
    delivery.put({ skill: "tidy", ok: false, line: "y", task: "tidy failed" });
    delivery.put({ skill: "implement-conformance-testing-script", ok: true, line: "Conformance testing script written: run.sh.", kind: "conformance", plainFile: "hello.plain" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(entries).toEqual([{ type: "turri_skill_run", data: { text: "Conformance testing script written: run.sh." } }]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.message.customType).toBe("turri_skill_run");
    expect(messages[0]!.message.content).toBe("the unit one failed\n\n---\n\ntidy failed");
    expect(messages[0]!.message.details).toEqual({
      skills: ["implement-unit-testing-script", "tidy"],
      runs: [{ skill: "implement-unit-testing-script", kind: "unit", plainFile: "hello.plain" }, { skill: "tidy" }],
    });
    expect(messages[0]!.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  it("counts as a script run's own only its script, a prepare script and a config naming them - not what the chat wrote meanwhile", () => {
    const changed = ["quotes.plain", "test_scripts/run_conformance_tests_python.sh", "tests/quotes/health.plain", "config.turri.yaml", "test_scripts/prepare_environment_python.sh"];
    expect(ownChanges(changed, "conformance")).toEqual(["test_scripts/run_conformance_tests_python.sh", "config.turri.yaml", "test_scripts/prepare_environment_python.sh"]);
    expect(ownChanges(changed, "unit")).toEqual(["config.turri.yaml"]);
    expect(ownChanges(changed)).toEqual(changed);
  });
});
