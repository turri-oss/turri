import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkClaudeSubscription, checkGit, checkProject, checkSandbox, checkShell } from "../src/setup.ts";
import { scriptAgainstMachine, stackOf } from "../src/stack.ts";

/** What doctor and setup check, now that agents' commands run on this machine. */

describe("bash", () => {
  it("is what every command runs with: missing, it says how to get one - Git Bash on Windows", () => {
    expect(checkShell(true).level).toBe("ok");
    expect(checkShell(false, "win32")).toMatchObject({ level: "missing", fix: expect.stringContaining("Git for Windows") });
    expect(checkShell(false, "linux")).toMatchObject({ level: "missing", fix: expect.stringContaining("package manager") });
  });
});

describe("git", () => {
  it("is what each module's history is kept in: missing, it stops the run", () => {
    expect(checkGit(true).level).toBe("ok");
    expect(checkGit(false)).toMatchObject({ level: "missing", fix: expect.stringContaining("package manager") });
  });
});

describe("the OS sandbox", () => {
  it("says which wall is up", () => {
    expect(checkSandbox({ kind: "seatbelt" })).toMatchObject({ level: "ok", detail: expect.stringContaining("Seatbelt") });
    expect(checkSandbox({ kind: "bubblewrap", proc: "bind" })).toMatchObject({ level: "ok", detail: expect.stringContaining("the host's /proc bound") });
  });

  it("says why none starts, and how to give it one - and that the check and the audit hold alone", () => {
    const none = checkSandbox({ kind: "none", why: "this machine does not let an unprivileged process create a user namespace", fix: "in Docker, run the container with `--security-opt seccomp=unconfined`" }, "linux");
    expect(none).toMatchObject({ level: "limited", fix: expect.stringContaining("seccomp=unconfined") });
    expect(none.detail).toContain("the command check and the audit hold alone");
    expect(checkSandbox({ kind: "none", why: "Windows has no OS sandbox turri drives" }, "win32").level).toBe("info");
  });
});

describe("a project, against this machine", () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "turri-doctor-"));
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("says which toolchains its modules' implementation reqs name and this machine lacks", async () => {
    writeFileSync(join(project, "api.plain"), "***implementation reqs***\n\n- :Implementation: is written in Python with FastAPI.\n\n***functional specs***\n\n# serve\nServe.\n");
    writeFileSync(join(project, "game.plain"), "***implementation reqs***\n\n- :Implementation: is written in Zig.\n\n***functional specs***\n\n# draw\nDraw.\n");
    const checks = await checkProject(project, { has: (command) => command === "python3" });
    expect(checks).toEqual([
      { level: "ok", name: "api", detail: "has Python" },
      { level: "missing", name: "game", detail: "its implementation reqs need Zig (zig), which this machine lacks", fix: expect.stringContaining("install Zig on this machine") },
    ]);
  });

  it("counts Java as missing when java is found with no JDK behind it - macOS's stub that only asks to install one", async () => {
    writeFileSync(join(project, "server.plain"), "***implementation reqs***\n\n- :Implementation: is written in Java 21 with Spring Boot.\n\n***functional specs***\n\n# serve\nServe.\n");
    const has = (command: string) => command === "java";
    expect(await checkProject(project, { has, jdk: () => false })).toEqual([
      { level: "missing", name: "server", detail: "its implementation reqs need Java (java, spring boot), which this machine lacks", fix: expect.stringContaining("install Java") },
    ]);
    expect(await checkProject(project, { has, jdk: () => true })).toEqual([{ level: "ok", name: "server", detail: "has Java" }]);
  });

  it("says what in its testing scripts this machine does not have", async () => {
    mkdirSync(join(project, "test_scripts"));
    writeFileSync(join(project, "test_scripts", "run_unittests_java.sh"), "#!/bin/bash\nexport JAVA_HOME=$(/usr/libexec/java_home -v 21)\nmvn -q test\n");
    const checks = await checkProject(project, { has: () => false, exists: () => false });
    expect(checks).toEqual([
      {
        level: "limited",
        name: join("test_scripts", "run_unittests_java.sh"),
        detail: "does not fit this machine - it is yours to fix:",
        more: ["names `/usr/libexec/java_home`, which this machine does not have", "runs `mvn`, which is not on this machine's PATH"],
      },
    ]);
  });
});

describe("what a testing script needs of this machine", () => {
  it("is what it names by its whole path and the toolchains it runs - not its comments, its variables or the folders it is handed", () => {
    const script = [
      "#!/bin/bash",
      "# runs pytest in a venv",
      'cd "$1" && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt',
      "PYTHONPATH=src timeout 300 pytest -q | tee /tmp/out.log",
      "ls /usr/share/doc > /dev/null",
    ].join("\n");
    expect(scriptAgainstMachine(script, { has: (command) => command !== "pytest", exists: (path) => path !== "/usr/share/doc" })).toEqual([
      "runs `pytest`, which is not on this machine's PATH",
      "names `/usr/share/doc`, which this machine does not have",
    ]);
    expect(scriptAgainstMachine(script, { has: () => true, exists: () => true })).toEqual([]);
  });
});

describe("what a project's implementation reqs need", () => {
  it("is the toolchains they name, read by keyword, each with the commands that show it is there", () => {
    expect(stackOf("- :Implementation: uses Python 3.12 with FastAPI.\n- The frontend is React, built with Vite.").map((need) => need.toolchain)).toEqual(["Python", "Node"]);
    expect(stackOf("- :Implementation: is written in Rust with Axum.")[0]).toEqual({ toolchain: "Rust", commands: ["cargo"], words: ["rust", "axum"] });
  });
});

describe("the toolchains a stack can be chosen from", () => {
  it("says which of the standard library's languages this machine can build, which it lacks, and to offer only the first", async () => {
    const { toolchainsBlock, languagesOnMachine } = await import("../src/stack.ts");
    // A laptop with uv and Node, no Go, no Rust, no JDK.
    const has = (command: string) => ["uv", "node", "npm"].includes(command);
    expect(languagesOnMachine(has).ready.map((entry) => entry.language)).toEqual(["Python", "TypeScript"]);
    const block = toolchainsBlock(has);
    expect(block).toContain("It can build and test now: Python (uv), TypeScript (node, npm).");
    expect(block).toContain("It lacks, to build: Go (go), Rust (cargo), Java (java) - not installed.");
    expect(block).toContain("offer only those in a language it can build now, and choose only among them");
    // Node without npm builds no TypeScript stack.
    expect(languagesOnMachine((command) => command === "node").ready).toEqual([]);
  });

  it("counts Java only with a JDK behind it, as a project's modules are checked", async () => {
    const { toolchainCheck } = await import("../src/stack.ts");
    const has = (command: string) => command === "java" || command === "go";
    expect(toolchainCheck(has, () => false)("java")).toBe(false);
    expect(toolchainCheck(has, () => true)("java")).toBe(true);
    expect(toolchainCheck(has, () => false)("go")).toBe(true);
  });
});

describe("doctor's Claude subscription check", () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "turri-doctor-claude-"));
    writeFileSync(join(project, "config.turri.yaml"), "harness-model: claude-code/claude-opus-5-5:medium\ncoding-model: claude-code/claude-sonnet-5:low\n");
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  /** This machine as the check sees it: the extension, claude on the PATH, what `claude auth status` says. */
  const machine = (over: Partial<{ installed: boolean; claude: string | undefined; status: object | undefined }> = {}) => {
    const seen = { installed: true, claude: "/usr/local/bin/claude" as string | undefined, status: { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" } as object | undefined, ...over };
    const asked: Array<{ command: string; configDir?: string }> = [];
    return {
      asked,
      probe: {
        installed: async () => seen.installed,
        which: (command: string) => (command === "claude" || command.startsWith("/") ? seen.claude : undefined),
        status: async (command: string, env: NodeJS.ProcessEnv) => (asked.push({ command, ...(env.CLAUDE_CONFIG_DIR !== undefined ? { configDir: env.CLAUDE_CONFIG_DIR } : {}) }), seen.status),
      },
    };
  };
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: "/usr/bin", ...extra });

  it("is ready with the extension installed and Claude Code signed in to a subscription - and says which", async () => {
    const { probe, asked } = machine();
    expect(await checkClaudeSubscription(project, env(), probe)).toEqual([
      { level: "ok", name: "Claude subscription", detail: "pi-claude-code installed, Claude Code signed in to max - for claude-code/claude-opus-5-5, claude-code/claude-sonnet-5" },
    ]);
    expect(asked).toEqual([{ command: "/usr/local/bin/claude" }]);
  });

  it("is not there for a project that names no claude-code model", async () => {
    writeFileSync(join(project, "config.turri.yaml"), "harness-model: anthropic/claude-opus-5-5\ncoding-model: anthropic/claude-haiku-5-5\n");
    expect(await checkClaudeSubscription(project, env(), machine().probe)).toEqual([]);
  });

  it("says what is missing, in the order it is needed: the extension, Claude Code, its sign-in, a subscription", async () => {
    const first = async (over: Parameters<typeof machine>[0]) => (await checkClaudeSubscription(project, env(), machine(over).probe))[0]!;
    expect(await first({ installed: false })).toMatchObject({ level: "missing", fix: "pi install https://github.com/earendil-works/pi-claude-code" });
    expect(await first({ claude: undefined })).toMatchObject({ level: "missing", detail: expect.stringContaining("is not on the PATH"), fix: expect.stringContaining("npm install -g @anthropic-ai/claude-code") });
    expect(await first({ status: { loggedIn: false } })).toMatchObject({ level: "missing", detail: expect.stringContaining("is not signed in"), fix: expect.stringContaining("claude auth login") });
    expect(await first({ status: undefined })).toMatchObject({ level: "missing", detail: expect.stringContaining("is not signed in") });
    expect(await first({ status: { loggedIn: true, authMethod: "console" } })).toMatchObject({ level: "missing", detail: "Claude Code is signed in (console), but not to a Claude subscription" });
  });

  it("says which of the environment it refuses is set - a key, a base URL, another backend - and to unset it", async () => {
    const [check] = await checkClaudeSubscription(project, env({ ANTHROPIC_API_KEY: "sk-ant", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "0" }), machine().probe);
    expect(check).toMatchObject({ level: "missing", detail: expect.stringContaining("ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK are set"), fix: "unset ANTHROPIC_API_KEY CLAUDE_CODE_USE_BEDROCK where turri starts - your shell's profile, say" });
  });

  it("asks the Claude Code pi-claude-code is told to use - PI_CLAUDE_CODE_COMMAND, PI_CLAUDE_CODE_CONFIG_DIR", async () => {
    const { probe, asked } = machine({ claude: "/opt/claude" });
    await checkClaudeSubscription(project, env({ PI_CLAUDE_CODE_COMMAND: "/opt/claude", PI_CLAUDE_CODE_CONFIG_DIR: "/home/me/.claude-work" }), probe);
    expect(asked).toEqual([{ command: "/opt/claude", configDir: "/home/me/.claude-work" }]);
  });
});
