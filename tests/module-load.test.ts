import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Each module loaded first, in a process of its own, as `turri` and a host load them - not as vitest does, which loads
 * them in its own order and hides an import cycle that leaves a constant uninitialised when another module is first.
 */
const FIRST = [
  "src/chat-terminal.ts",
  "src/extension.ts",
  "src/host.ts",
  "src/chats.ts",
  "src/sentinel.ts",
  "src/sentinel-chat.ts",
  "src/regenerate/confine.ts",
  "src/regenerate/records.ts",
  "src/regenerate/testing.ts",
  "src/regenerate/environment-error.ts",
];

describe("each module, loaded first in a process of its own", () => {
  it.each(FIRST)("loads %s", (file) => {
    const said = execFileSync(process.execPath, ["-e", `import("./${file}").then(() => console.log("loaded"), (error) => console.log("failed: " + error.message))`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    expect(said.trim().split("\n").at(-1)).toBe("loaded");
  });
});
