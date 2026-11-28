import { describe, expect, it } from "vitest";
import { chatModels } from "../src/chat-models.ts";

describe("the two models of turri", () => {
  it("are the session's overrides, taken out of pi's arguments", () => {
    expect(chatModels(["--coding-model", "google/gemini-3.1-flash", "-c"])).toEqual({
      piArgs: ["-c"],
      overrides: { codingModel: "google/gemini-3.1-flash" },
    });
    expect(chatModels(["--harness-model=openai/gpt-5.5"])).toEqual({ piArgs: [], overrides: { harnessModel: "openai/gpt-5.5" } });
    expect(chatModels([])).toEqual({ piArgs: [], overrides: {} });
  });

  it("take pi's own --model as the chat's harness model, kept for pi, --harness-model winning over it", () => {
    expect(chatModels(["--model", "anthropic/claude-sonnet-5-5"])).toEqual({ piArgs: ["--model", "anthropic/claude-sonnet-5-5"], overrides: { harnessModel: "anthropic/claude-sonnet-5-5" } });
    expect(chatModels(["--model=a/b", "--harness-model", "c/d"]).overrides.harnessModel).toBe("c/d");
    expect(chatModels(["--provider=google"])).toEqual({ piArgs: ["--provider=google"], overrides: {} });
    expect(chatModels(["--coding-model=a/b", "--coding-model", "c/d"]).overrides.codingModel).toBe("c/d");
  });
});
