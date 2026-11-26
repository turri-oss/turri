import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTES_APP, writeCodebase } from "./fixture.ts";
import { newState, saveState } from "../../src/capture/state.ts";
import { projectModels, readProjectConfig } from "../../src/config.ts";
import { findTestScripts } from "../../src/regenerate/test-scripts.ts";

/**
 * A whole capture with stand-in agents: the survey names one part on Flask, the codebase is split into storage and an
 * api, each is outlined, its features written - one sent back once, two defining the same concept in different words -
 * the concepts reconciled, a module made more readable; then the files are written, parse, and the report says what
 * was left out. Stopped part-way, it goes on without asking again what it was told; finished, it is never run over.
 */
type StubSession = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>; label: string; task?: string };

/** Each agent's label, in the order they were asked, and the follow-ups they were sent. */
const asked: string[] = [];
const followUps: Array<{ label: string; text: string }> = [];
/** The model each agent was started on, by its label. */
const agentModels = new Map<string, { role?: string; model?: string }>();
/** The tools each agent was given, by its label. */
const agentTools = new Map<string, string[]>();
/** Labels whose agent throws, as if turri were stopped while it worked. */
let crashes = new Set<string>();

vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  const activity = await import("../../src/regenerate/activity.ts");
  return {
    ...actual,
    createExecutor: vi.fn(async (opts: { customTools: StubSession["tools"]; label?: string; task?: string; model?: string; role?: string }) => {
      agentModels.set((opts.label ?? "").replace(/^capture /, ""), { role: opts.role, model: opts.model });
      agentTools.set((opts.label ?? "").replace(/^capture /, ""), opts.customTools.map((tool) => tool.name));
      return { tools: opts.customTools, label: opts.label ?? "", task: opts.task, dispose() {} };
    }),
    ask: vi.fn(async (session: StubSession, given: string) => {
      const label = session.label.replace(/^capture /, "");
      if (given === actual.BEGIN) {
        asked.push(label);
        // What a session reports as its agent reads: a tool call, and what the model's answer cost.
        activity.reportActivity(`(capture) ○ read ${join(root, "app", "routes.py")}   (model 1.2s)`);
        activity.reportUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
      } else followUps.push({ label, text: given });
      if (crashes.has(label)) throw new Error("stopped");
      const submit = (name: string, params: Record<string, unknown>) => session.tools.find((tool) => tool.name === name)!.execute("id", params);
      const answer = STUB[label.split(" ")[0]!]?.(label, given, session.task ?? "");
      if (answer !== undefined) await submit(answer[0], answer[1]);
      return "Done.";
    }),
  };
});

const STUB: Record<string, (label: string, given: string, task: string) => [string, Record<string, unknown>] | undefined> = {
  // Most tests exercise staged writers on this deliberately small fixture. Its compact writer asks for them.
  compact: () => ["submit_capture_compact", { expand: "capture storage and the HTTP interface separately" }],
  survey: () => [
    "submit_capture_survey",
    {
      parts: [
        {
          name: "notes",
          about: "a service that keeps short notes",
          paths: ["."],
          stdlib_stack: "stdlib/backend/python-flask",
          stdlib_conformance: true,
          implementation_reqs: [":Implementation: keeps every :Note: in SQLite through Flask-SQLAlchemy."],
          conventions: [{ text: "An error answers a JSON body with its `error` message.", where: ["app/routes.py"] }],
          test_reqs: [],
          definitions: [
            { concept: ":User:", text: ":User: is someone who uses the service." },
            { concept: ":Note:", text: ":Note: is a short text a :User: keeps." },
          ],
        },
      ],
      left_out: [{ path: "README.md", why: "the docs" }],
      assumptions: ["Notes are never shared between users."],
    },
  ],
  split: () => [
    "submit_capture_areas",
    {
      // In the wrong order: the api imports storage, so it is built after it.
      areas: [
        { name: "api", about: "the HTTP api for notes", paths: ["app/__init__.py", "app/routes.py", "app/static", "tests"] },
        { name: "storage", about: "where notes are kept", paths: ["app/models.py"] },
      ],
      left_out: [{ path: "README.md", why: "the docs" }, { path: "requirements.txt", why: "the manifest" }],
    },
  ],
  outline: (label) =>
    label.endsWith("storage")
      ? ["submit_capture_features", { features: [{ name: "note-storage", title: "Keeping notes", about: "notes outlive a restart", paths: ["app/models.py"] }], left_out: [] }]
      : [
          "submit_capture_features",
          {
            features: [
              { name: "add-note", title: "Adding a note", about: "a user adds a note", paths: ["app/routes.py"] },
              { name: "list-notes", title: "Listing notes", about: "a user sees their notes", paths: ["app/routes.py", "tests/test_notes.py"] },
            ],
            left_out: [],
          },
        ],
  feature: (label, given) => {
    if (label.endsWith("#note-storage")) {
      return ["submit_capture_feature", { functional_specs: [{ func_id: "keep-notes", text: "Every :Note: is kept between restarts, with its :NoteTime:." }], definitions: [{ concept: ":NoteTime:", text: ":NoteTime: is when a :Note: was added." }], assumptions: [], uncertain: [], dropped: [] }];
    }
    if (label.endsWith("#add-note")) {
      // The first answer has a func-id that is not kebab-case: sent back, then fixed.
      const funcId = given.startsWith("That does not hold") ? "add-note" : "Add Note";
      return [
        "submit_capture_feature",
        {
          functional_specs: [
            {
              func_id: funcId,
              text: "A :User: can add a :Note: with `POST /notes`, giving its text; the answer is 201 with its :NoteId:.",
              conformance: [{ scenario_id: "add-one", text: 'Posting a :Note: with the text "hi" answers 201.' }],
              acceptance: [{ scenario_id: "no-text", text: "Posting a :Note: with no text answers 400." }],
            },
          ],
          definitions: [{ concept: ":NoteId:", text: ":NoteId: is a :Note:'s number." }],
          assumptions: [],
          uncertain: ["Whether an empty text is refused - the code does not check it."],
          dropped: [],
        },
      ];
    }
    return [
      "submit_capture_feature",
      {
        functional_specs: [{ func_id: "list-notes", text: "`GET /notes` answers the text of every :Note:, newest :NoteTime: first, each with its :NoteId:." }],
        definitions: [
          { concept: ":NoteId:", text: ":NoteId: identifies a :Note:." },
          { concept: ":NoteTime:", text: ":NoteTime: is when a :Note: was added." },
        ],
        assumptions: [],
        uncertain: [],
        dropped: ["The debug route /notes/raw."],
      },
    ];
  },
  check: (label, given, task) =>
    label.startsWith("check reference")
      ? STUB.checkReference?.(label, given, task)
      : ["submit_capture_conventions", { conventions: [{ text: "An error answers a JSON body with its `error` message.", where: ["app/routes.py"] }], changes: [] }],
  interface: () => [
    "submit_capture_interface",
    {
      title: "Deleting a note",
      functional_specs: [{ func_id: "delete-note", text: "`DELETE /notes/{id}` deletes the :Note: and answers 204." }],
      definitions: [],
      assumptions: [],
      uncertain: [],
      dropped: [],
    },
  ],
  verify: () => ["submit_capture_corrections", { corrections: [] }],
  divide: () => [
    "submit_capture_owners",
    {
      features: [
        { feature: "notes/storage#note-storage", owns: "Keeping notes between restarts." },
        { feature: "notes/api#add-note", owns: "Adding a note: `POST /notes`." },
        { feature: "notes/api#list-notes", owns: "Listing notes: `GET /notes`." },
      ],
      merged: [],
    },
  ],
  // The modules as the code's areas make them, in the order of their code: each needing the one before it.
  modules: (_label, _given, task) => [
    "submit_capture_modules",
    {
      modules: [...task.slice(task.indexOf("<modules as the code's areas make them>")).matchAll(/^- (\S+) - (.+): (.+)$/gm)].map((match, at, all) => ({
        name: match[1],
        about: match[2],
        features: match[3]!.split(", "),
        needs: at > 0 ? [all[at - 1]![1]] : [],
      })),
      rewrites: [],
    },
  ],
  // Every scenario held on the original.
  trial: (_label, _given, task) => [
    "submit_capture_trial",
    {
      scenarios: [...task.slice(task.indexOf("<scenarios to try>")).matchAll(/^### (\S+), scenario (\S+) \(/gm)].map((match) => ({ func_id: match[1], scenario_id: match[2], outcome: "held", ran: "ran it: the original did what it says" })),
      functional_specs: [],
      test_reqs: [],
    },
  ],
  concepts: () => ["submit_capture_concepts", { definitions: [{ concept: ":NoteId:", text: ":NoteId: is the number that identifies a :Note:." }] }],
  readability: (label) =>
    label.endsWith("api") ? ["submit_capture_edits", { edits: [{ func_id: "list-notes", text: "`GET /notes` answers every :Note:, newest first, each with its :NoteId:." }] }] : ["submit_capture_edits", { edits: [] }],
};

const capture = await import("../../src/capture/capture.ts");
const { CaptureError, plainDirState } = capture;
type ScriptRequest = import("../../src/capture/scripts.ts").ScriptRequest;

/** The testing scripts asked for, by part and kind; a kind whose stand-in skill fails, and why. */
const scriptsAsked: string[] = [];
let scriptFails: Partial<Record<"unit" | "conformance", string>> = {};
/** The model each testing script was asked on. */
const scriptModels: Array<string | undefined> = [];

/** Writes a testing script as turri's skill would - into test_scripts/ - or fails as it might. */
async function standInScript(request: ScriptRequest): Promise<void> {
  scriptsAsked.push(`${request.part.name}:${request.kind}`);
  scriptModels.push(request.model);
  const fails = scriptFails[request.kind];
  if (fails !== undefined) throw new Error(fails);
  mkdirSync(join(request.plainDir, "test_scripts"), { recursive: true });
  writeFileSync(join(request.plainDir, "test_scripts", request.kind === "unit" ? "run_unittests_python.sh" : "run_conformance_tests_python.sh"), "#!/usr/bin/env bash\n");
}

/** A capture whose testing scripts the stand-in writes: no test runs turri's own skills. */
const runCapture = (options: Parameters<typeof capture.runCapture>[0]) => capture.runCapture({ writeScript: standInScript, ...options });
const { buildMap } = await import("../../src/capture/map.ts");
const { filesOf, linesOf } = await import("../../src/capture/area.ts");

let root = "";
beforeEach(() => {
  scriptsAsked.length = 0;
  scriptModels.length = 0;
  agentModels.clear();
  agentTools.clear();
  scriptFails = {};
  asked.length = 0;
  followUps.length = 0;
  crashes = new Set();
  root = writeCodebase(NOTES_APP);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Lines enough for the api to be outlined whole, too few for the codebase: it is split once. */
function leafLines(): number {
  return linesOf(filesOf(buildMap(root), ["app/__init__.py", "app/routes.py", "app/static", "tests"]));
}

describe("a capture", () => {
  it("captures a small program with one writer, keeps its checks and resumes without planning or writing it again", async () => {
    const entries = ["POST /notes", "GET /notes"].map((name) => ({ kind: "route", name, where: "app/routes.py:6", aliases: [], choices: [], details: [], also: [] }));
    STUB.reference = () => ["submit_capture_reference", { entries, excluded: [] }];
    STUB.checkReference = () => ["submit_capture_reference_checked", { entries, excluded: [], changes: [] }];
    const original = STUB.compact!;
    STUB.compact = () => ["submit_capture_compact", { feature: {
      functional_specs: [{ func_id: "keep-notes", text: "Using :NotesInterface:, `POST /notes` keeps a :Note: and `GET /notes` lists them.", conformance: [{ scenario_id: "one-note", text: "Adding a :Note: with text `hi` answers 201." }] }],
      definitions: [], assumptions: [], uncertain: [], dropped: [],
    } }];
    try {
      crashes.add("trial notes");
      await expect(runCapture({ root, model: "p/talk:high" })).rejects.toThrow("stopped");
      expect(agentModels.get("reference notes")).toEqual({ role: "capture-exploration", model: "p/talk:low" });
      expect(asked).toEqual(["survey", "check notes", "reference notes", "check reference notes", "compact notes", "verify notes", "trial notes"]);
      const compactAgents = asked.length;
      // A changed split threshold after a stop must not turn a completed compact draft into a new set of features.
      asked.length = 0;
      crashes.clear();
      const result = await runCapture({ root, leafLines: 1 });
      expect(asked).toEqual(["trial notes"]);
      expect(result).toMatchObject({ modules: ["notes"], specs: 1, failing: 0, uncaptured: 0 });
      expect(readFileSync(result.reportFile, "utf8")).toContain("Pipeline: compact");
      expect(result.summary).toContain("1 of the 1 scenario tried on the original held");
      expect(existsSync(join(result.plainDir, "resources", "interface", "notes.md"))).toBe(true);
      expect(scriptsAsked).toEqual(expect.arrayContaining(["notes:unit", "notes:conformance"]));

      // Compare the same map with a checkpoint from before compact capture. It follows the staged path, even unsplit.
      const plainDir = join(root, "previous");
      saveState(plainDir, newState(root));
      asked.length = 0;
      const staged = await runCapture({ root, plainDir });
      expect(staged.failing).toBe(0);
      expect(asked).toContain("outline notes");
      expect(asked).not.toContain("compact notes");
      expect(asked.length).toBeGreaterThan(compactAgents);
    } finally {
      STUB.compact = original;
      delete STUB.reference;
      delete STUB.checkReference;
    }
  });

  it("expands a small project's pipeline when its behaviour needs separate writers, keeping the survey and reference", async () => {
    const original = STUB.compact!;
    STUB.compact = () => ["submit_capture_compact", { expand: "separate concerns" }];
    try {
      crashes.add("outline notes");
      await expect(runCapture({ root })).rejects.toThrow("stopped");
      crashes.clear();
      asked.length = 0;
      const result = await runCapture({ root });
      expect(asked[0]).toBe("outline notes");
      expect(asked).not.toContain("compact notes");
      expect(result.failing).toBe(0);
      expect(readFileSync(result.reportFile, "utf8")).toContain("Pipeline: staged - expanded from compact: separate concerns");
    } finally {
      STUB.compact = original;
    }
  });

  it("does not accept an incomplete compact draft or mix it with the staged writers' specs", async () => {
    const original = STUB.compact!;
    STUB.compact = () => ["submit_capture_compact", { feature: { functional_specs: [{ func_id: "partial-draft", text: "A :User: stores notes." }] } }];
    try {
      const result = await runCapture({ root });
      expect(followUps.find((call) => call.label === "compact notes")?.text).toContain("Neither captured nor dropped:");
      expect(asked.filter((label) => label === "survey")).toHaveLength(1);
      expect(asked).toContain("outline notes");
      expect(result.failing).toBe(0);
      expect(readFileSync(join(result.plainDir, "notes.plain"), "utf8")).not.toContain("partial-draft");
    } finally {
      STUB.compact = original;
    }
  });

  it("captures the codebase into modules in build order, with an import module, scenarios, config and a report", async () => {
    // A module of one functional spec at most: each area is a module of its own.
    const harnessModel = "amazon-bedrock/global.anthropic.claude-opus-5-5:medium";
    const result = await runCapture({ root, harnessModel, leafLines: leafLines(), parallel: 2, moduleSpecs: 1 });
    const plain = join(root, "plain");
    const read = (path: string) => readFileSync(join(plain, ...path.split("/")), "utf8");

    expect(result).toMatchObject({ modules: ["storage", "api"], specs: 3, uncaptured: 0, failing: 0 });
    expect(asked.filter((label) => label.startsWith("feature"))).toHaveLength(3);
    // The api's feature written wrong once was sent back with why.
    expect(followUps.find((followUp) => followUp.label.endsWith("#add-note"))?.text).toMatch(/kebab-case/);

    const shared = read("template/notes-shared.plain");
    expect(shared).toContain("  - stdlib/backend/python-flask\n  - stdlib/backend/conformance/python-flask");
    // Defined by features of both modules: shared - after the core concepts it uses.
    expect(shared).toMatch(/- :Note: is a short text[\s\S]*- :NoteTime: is when a :Note: was added\./);
    expect(shared).toContain("- :Implementation: keeps every :Note: in SQLite through Flask-SQLAlchemy.\n- An error answers a JSON body with its `error` message.");

    const storage = read("storage.plain");
    expect(storage).toContain("import:\n  - notes-shared");
    expect(storage).not.toContain("requires:");
    // Functional specs one after another, no comment line naming their feature.
    expect(storage).toContain("***functional specs***\n\n# keep-notes\nEvery :Note: is kept between restarts");
    expect(storage).not.toMatch(/^>/m);

    const api = read("api.plain");
    expect(api).toContain("requires:\n  - storage");
    // Defined in the api's features alone, in different words: reconciled, and kept in the module.
    expect(api).toContain("- :NoteId: is the number that identifies a :Note:.");
    expect(shared).not.toContain(":NoteId: is");
    // The readability pass's text.
    expect(api).toContain("# list-notes\n`GET /notes` answers every :Note:, newest first, each with its :NoteId:.");

    expect(read("tests/api/add-note.plain")).toBe(
      ["---", "module: api", "func_id: add-note", "---", "", "***conformance tests***", "", "# add-one", 'Posting a :Note: with the text "hi" answers 201.', "", "***acceptance tests***", "", "# no-text", "Posting a :Note: with no text answers 400.", ""].join("\n"),
    );
    expect(existsSync(join(plain, "tests", "api", "list-notes.plain"))).toBe(false);

    const config = readProjectConfig(plain);
    expect(projectModels(config)).toMatchObject({ harness: { model: harnessModel.split(":")[0], thinking: "medium" }, coding: { model: "amazon-bedrock/global.anthropic.claude-haiku-5-5", thinking: "low" } });
    expect(config).toMatchObject({ conformanceTests: true, baseFolder: "assets", testingScriptsRunOn: "in-place", unittestsScript: "test_scripts/run_unittests_python.sh", conformanceTestsScript: "test_scripts/run_conformance_tests_python.sh" });
    expect(findTestScripts(plain, join(plain, "api.plain"))).toMatchObject({ unit: join(plain, "test_scripts", "run_unittests_python.sh"), conformance: join(plain, "test_scripts", "run_conformance_tests_python.sh") });
    expect(existsSync(join(plain, "assets", "app", "static", "logo.png"))).toBe(true);
    expect(read(".gitignore")).toBe("plain_modules/**/.plaingit/\n");

    const report = read(".turri/capture/report.md");
    expect(report).toContain("README.md - the docs");
    expect(report).toContain("Notes are never shared between users.");
    expect(report).toContain("Whether an empty text is refused");
    expect(report).toContain("The debug route /notes/raw.");
    expect(report).toContain("Every module parses.");
    expect(report).toContain("- notes: An error answers a JSON body with its `error` message. (decided in app/routes.py)");
    expect(report).toContain("No feature was merged.");
    expect(report).toContain("None: the ***plain names every one.");
    // Its file holds the original's tests of it, and it was captured with none.
    expect(report).toMatch(/## Tested by the original, with no scenario\n\n.*\n\n- notes\/api#list-notes - tests\/test_notes\.py \(\d+ lines\)\n/);
    // The original is never written.
    expect(readFileSync(join(root, "app", "routes.py"), "utf8")).toBe(NOTES_APP["app/routes.py"]);
  });

  it("gathers areas split for their agents' sake into one module while their functional specs fit in it", async () => {
    const result = await runCapture({ root, leafLines: leafLines() });
    expect(result.modules).toEqual(["notes"]);
    const notes = readFileSync(join(root, "plain", "notes.plain"), "utf8");
    expect(notes).not.toContain("requires:");
    expect(notes).toMatch(/# keep-notes[\s\S]*# add-note[\s\S]*# list-notes/);
    expect(notes).not.toMatch(/^>/m);
    // One module: what only it uses is its own, the core concepts apart.
    expect(notes).toContain("- :NoteTime: is when a :Note: was added.");
    expect(existsSync(join(root, "plain", "tests", "notes", "add-note.plain"))).toBe(true);
  });

  it("goes on from where it was stopped, asking no agent again what it answered", async () => {
    crashes = new Set(["feature notes/api#list-notes"]);
    await expect(runCapture({ root, leafLines: leafLines(), parallel: 1 })).rejects.toThrow("stopped");
    expect(plainDirState(join(root, "plain")).kind).toBe("resume");
    const before = [...asked];
    expect(before).toContain("survey");

    crashes = new Set();
    asked.length = 0;
    const result = await runCapture({ root, leafLines: leafLines(), parallel: 1 });
    expect(result.specs).toBe(3);
    expect(asked).not.toContain("survey");
    expect(asked).not.toContain("split notes");
    expect(asked).not.toContain("divide notes");
    expect(asked).not.toContain("check notes");
    expect(asked.filter((label) => label.startsWith("feature"))).toEqual(["feature notes/api#list-notes"]);
  });

  it("says where it is while it runs: its stage, each agent at work and what it did last, the features done and the cost", async () => {
    const seen: Array<{ stage: string; agents: string[]; did: Array<string | undefined>; outlined: number; done: number; cost: number }> = [];
    await runCapture({
      root,
      leafLines: leafLines(),
      parallel: 1,
      watch: (status) => seen.push({ stage: status.stage, agents: status.agents.map((agent) => agent.label), did: status.agents.map((agent) => agent.did), ...status.features, cost: status.cost }),
    });

    expect(seen.map((status) => status.stage).filter((stage, at, all) => stage !== all[at - 1])).toEqual(["mapping", "surveying", "checking", "extracting", "compact-writing", "outlining", "dividing", "capturing", "gathering", "reconciling", "reading", "verifying", "trying", "writing", "scripts"]);
    expect(seen.some((status) => status.agents[0] === "survey" && status.did[0] === "○ read app/routes.py")).toBe(true);
    expect(seen.some((status) => status.agents[0] === "feature notes/api#add-note" && status.outlined === 3)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ agents: [], outlined: 3, done: 3 });
    expect(seen.at(-1)!.cost).toBeCloseTo(asked.length * 0.01);
  });

  it("gives each behaviour to one feature before any is written: one merged is not written, its files are the other's, and every writer sees what each owns", async () => {
    const tasks = new Map<string, string>();
    const original = { feature: STUB.feature!, divide: STUB.divide! };
    STUB.divide = (_label, _given, task) => (
      tasks.set("divide", task),
      [
        "submit_capture_owners",
        {
          features: [
            { feature: "notes/api#add-note", owns: "Adding a note and keeping it between restarts." },
            { feature: "notes/api#list-notes", owns: "Listing notes, newest first." },
          ],
          merged: [{ feature: "notes/storage#note-storage", into: ["notes/api#add-note"], why: "keeping a note is part of adding it" }],
        },
      ]
    );
    STUB.feature = (label, given, task) => (tasks.set(label, task), original.feature(label, given, task));
    try {
      const result = await runCapture({ root, leafLines: leafLines() });
      expect(tasks.get("divide")).toContain("## notes/storage - where notes are kept\n- notes/storage#note-storage - Keeping notes: notes outlive a restart\n  built in: app/models.py");
      expect(asked.filter((label) => label.startsWith("feature")).sort()).toEqual(["feature notes/api#add-note", "feature notes/api#list-notes"]);

      const addNote = tasks.get("feature notes/api#add-note")!;
      expect(addNote).toContain("What it owns: Adding a note and keeping it between restarts.");
      expect(addNote).toContain("Merged into it: notes/storage#note-storage - notes outlive a restart (keeping a note is part of adding it)");
      expect(addNote).toContain("Where it is built: app/routes.py, app/models.py");
      expect(tasks.get("feature notes/api#list-notes")).toContain(
        "## notes/api - the HTTP api for notes\n   notes/api#add-note - Adding a note: Adding a note and keeping it between restarts.\n-> notes/api#list-notes - Listing notes: Listing notes, newest first.\n</features of notes>",
      );

      expect(result.modules).toEqual(["notes"]);
      expect(readFileSync(join(root, "plain", "notes.plain"), "utf8")).not.toContain("# keep-notes");
      expect(readFileSync(result.reportFile, "utf8")).toContain("- notes/storage#note-storage - merged into notes/api#add-note: keeping a note is part of adding it");
    } finally {
      Object.assign(STUB, original);
    }
  });

  it("tells each writer the conventions the survey settled, the interface in its files, and the original's tests there with the scenarios they earn it", async () => {
    const tasks = new Map<string, string>();
    const original = STUB.feature!;
    STUB.feature = (label, given, task) => (tasks.set(label, task), original(label, given, task));
    try {
      await runCapture({ root, leafLines: leafLines() });
    } finally {
      STUB.feature = original;
    }
    const listNotes = tasks.get("feature notes/api#list-notes")!;
    expect(listNotes).toContain("### The part's conventions - settled from its code: every functional spec and scenario follows them, and none decides them again\n- An error answers a JSON body with its `error` message.");
    expect(listNotes).toMatch(/<the original's tests>\nThe original tests your feature's files in \d+ lines - you may write up to 8 scenarios, the most where these are densest:\n- tests\/test_notes\.py - \d+ lines: test_add_note, test_list_notes\n<\/the original's tests>/);
    expect(tasks.get("feature notes/api#add-note")).toContain("No file of your feature is a test of the original - its tests may be elsewhere: grep for what it does. You may write up to 8 scenarios.");
    expect(listNotes).toContain(
      "<the interface in your files>\nEvery option, command, route, screen and environment variable the code defines in your feature's files - capture exactly each your feature owns:\n- app/routes.py: `POST /notes`, `GET /notes`\n</the interface in your files>",
    );
  });

  it("gives the interface no feature captured to a writer of its own, as a feature of the area whose code defines it", async () => {
    writeFileSync(join(root, "app", "routes.py"), `${NOTES_APP["app/routes.py"]}\n@bp.delete("/notes/<int:note_id>")\ndef delete_note(note_id):\n    return "", 204\n`);
    const tasks = new Map<string, string>();
    const original = STUB.interface!;
    STUB.interface = (label, given, task) => (tasks.set(label, task), original(label, given, task));
    try {
      const result = await runCapture({ root, leafLines: leafLines() });
      expect(tasks.get("interface notes/api#interface")).toContain(
        "<the interface to capture>\nNamed in no functional spec of the part - capture each exactly, or drop it, by name, with why:\n- `DELETE /notes/<int:note_id>` (route, app/routes.py)\n</the interface to capture>",
      );
      expect(readFileSync(join(root, "plain", "notes.plain"), "utf8")).toMatch(/# list-notes[\s\S]*# delete-note\n`DELETE \/notes\/\{id\}` deletes the :Note: and answers 204\.\n$/);
      expect(result.summary).not.toContain("named nowhere");
      expect(readFileSync(result.reportFile, "utf8")).toContain("None: the ***plain names every one.");
    } finally {
      STUB.interface = original;
    }
  });

  it("takes the interface from the code as data, and keeps it as the reference the ***plain links", async () => {
    const tasks = new Map<string, string>();
    const original = { reference: STUB.reference, feature: STUB.feature! };
    STUB.reference = (label, _given, task) => (
      tasks.set(label, task),
      [
        "submit_capture_reference",
        {
          entries: [
            { kind: "route", name: "POST /notes", aliases: [], choices: [], details: ["body `text`: the note's text", "201: the note's `id`"], where: "app/routes.py:6", also: [] },
            { kind: "route", name: "GET /notes", aliases: [], choices: [], details: ["200: every note's text, newest first"], where: "app/routes.py:12", also: [] },
          ],
          excluded: [],
        },
      ]
    );
    STUB.feature = (label, given, task) => (tasks.set(label, task), original.feature(label, given, task));
    // The check corrects what it was given against the code: here, the add route's help - its function's docstring is none, so a detail.
    STUB.checkReference = (label, _given, task) => (
      tasks.set(label, task),
      [
        "submit_capture_reference_checked",
        {
          entries: [
            { kind: "route", name: "POST /notes", aliases: [], choices: [], details: ["body `text`: the note's text", "201: the note's `id`"], where: "app/routes.py:6", also: [] },
            { kind: "route", name: "GET /notes", aliases: [], choices: [], details: ["200: every note's text, newest first"], where: "app/routes.py:12", also: [] },
          ],
          excluded: [],
          changes: ["GET /notes: its answer lists the newest first - app/routes.py orders by Note.id descending."],
        },
      ]
    );
    try {
      const result = await runCapture({ root, leafLines: leafLines(), model: "p/talk:high", codingModel: "p/code:high" });
      expect(agentModels.get("check reference notes")).toEqual({ role: "capture-analysis", model: "p/code:low" });
      expect(tasks.get("check reference notes")).toContain("<the reference>\nAs it was taken from app/routes.py:");
      expect(tasks.get("reference notes")).toContain("<files>\n- app/routes.py - 14 lines; the map found `POST /notes`, `GET /notes`\n</files>");
      const read = (path: string) => readFileSync(join(root, "plain", ...path.split("/")), "utf8");
      // The concept that links it, in what every module of the part imports - and the reference beside the ***plain.
      expect(read("template/notes-shared.plain")).toContain(
        "- :NotesInterface: is every command, argument, option, route and environment variable of notes a user, a client or a script calls, each exactly as [its interface reference](resources/interface/notes.md) lists it",
      );
      expect(read("resources/interface/notes.md")).toContain("## Routes\n\n- `POST /notes`\n  - body `text`: the note's text\n  - 201: the note's `id`\n- `GET /notes`\n");
      // Each writer is given the reference's entries in its files, exact, and told what to do with them.
      expect(tasks.get("feature notes/api#add-note")).toContain("<the interface in your files>\nTaken from the code, every literal checked against it: :NotesInterface:'s reference");
      expect(tasks.get("feature notes/api#add-note")).toContain("- route `POST /notes` (app/routes.py:6)\n- route `GET /notes` (app/routes.py:12)");
      expect(result.failing).toBe(0);
      expect(readFileSync(result.reportFile, "utf8")).toContain("- notes: `resources/interface/notes.md`, linked by :NotesInterface: - 2 routes");
      expect(readFileSync(result.reportFile, "utf8")).toContain("- notes: checked against the code - GET /notes: its answer lists the newest first - app/routes.py orders by Note.id descending.");
    } finally {
      Object.assign(STUB, original);
      delete STUB.checkReference;
    }
  });

  it("says why a writer left a surface out of the interface, and counts those no writer settled in its summary", async () => {
    writeFileSync(join(root, "app", "routes.py"), `${NOTES_APP["app/routes.py"]}\n@bp.delete("/notes/<int:note_id>")\ndef delete_note(note_id):\n    return "", 204\n@bp.get("/debug/raw")\ndef raw():\n    return ""\n`);
    const original = STUB.interface!;
    STUB.interface = () => [
      "submit_capture_interface",
      {
        title: "Deleting a note",
        functional_specs: [{ func_id: "delete-note", text: "`DELETE /notes/{id}` deletes the :Note: and answers 204." }],
        definitions: [],
        assumptions: [],
        uncertain: [],
        // A dropped surface is named as the code names it: the list-notes writer's "/notes/raw" answers for no other route.
        dropped: ["`GET /debug/raw` is a developer's debug route, never linked or documented."],
      },
    ];
    try {
      const result = await runCapture({ root, leafLines: leafLines() });
      expect(result.summary).not.toContain("named nowhere");
      const report = readFileSync(result.reportFile, "utf8");
      expect(report).toMatch(/## The interface named nowhere in the \*\*\*plain\n\n.*\n\n- `GET \/debug\/raw` \(route, app\/routes\.py\) - dropped: `GET \/debug\/raw` is a developer's debug route, never linked or documented\.\n\n/);
    } finally {
      STUB.interface = original;
    }
  });

  it("counts the interface that no writer settled in its summary, and lists it", async () => {
    writeFileSync(join(root, "app", "routes.py"), `${NOTES_APP["app/routes.py"]}\n@bp.delete("/notes/<int:note_id>")\ndef delete_note(note_id):\n    return "", 204\n`);
    const original = STUB.interface!;
    STUB.interface = () => undefined;
    try {
      const result = await runCapture({ root, leafLines: leafLines() });
      expect(result.summary).toContain("1 option, command, route or variable of the code's interface is named nowhere in the ***plain - the report lists them.");
      expect(readFileSync(result.reportFile, "utf8")).toContain("- `DELETE /notes/<int:note_id>` (route, app/routes.py)\n");
    } finally {
      STUB.interface = original;
    }
  });

  it("checks the conventions against the code before any writer is given them, and says what it corrected", async () => {
    const tasks = new Map<string, string>();
    const original = { check: STUB.check!, feature: STUB.feature! };
    STUB.check = (_label, _given, task) => (
      tasks.set("check", task),
      ["submit_capture_conventions", { conventions: [{ text: "An error answers 400 with a JSON body holding its `error` message.", where: ["app/routes.py"] }], changes: ["The status is 400: app/routes.py answers every error with it."] }]
    );
    STUB.feature = (label, given, task) => (tasks.set(label, task), original.feature(label, given, task));
    try {
      const result = await runCapture({ root, leafLines: leafLines() });
      expect(tasks.get("check")).toContain("<conventions>\n1. An error answers a JSON body with its `error` message.\n   decided in: app/routes.py\n</conventions>");
      expect(tasks.get("feature notes/api#add-note")).toContain("- An error answers 400 with a JSON body holding its `error` message.");
      expect(readFileSync(join(root, "plain", "template", "notes-shared.plain"), "utf8")).toContain("- An error answers 400 with a JSON body holding its `error` message.");
      expect(readFileSync(result.reportFile, "utf8")).toContain("- notes: The status is 400: app/routes.py answers every error with it.");
    } finally {
      Object.assign(STUB, original);
    }
  });

  it("corrects the interface against the code once the ***plain reads well - a functional spec and a scenario - and says why", async () => {
    const original = STUB.verify!;
    STUB.verify = (_label, _given, task) =>
      task.includes("# add-note")
        ? [
            "submit_capture_corrections",
            {
              corrections: [
                { func_id: "add-note", text: "A :User: can add a :Note: with `POST /notes`, giving its `text`; the answer is 201 with its :NoteId: as `id`.", why: "app/routes.py reads `text` and answers `id`." },
                { func_id: "add-note", scenario_id: "add-one", text: 'Posting a :Note: with the text "hi" answers 201 with its `id`.', why: "app/routes.py answers the id." },
              ],
            },
          ]
        : ["submit_capture_corrections", { corrections: [] }];
    try {
      const result = await runCapture({ root, leafLines: leafLines() });
      const notes = readFileSync(join(root, "plain", "notes.plain"), "utf8");
      expect(notes).toContain("# add-note\nA :User: can add a :Note: with `POST /notes`, giving its `text`; the answer is 201 with its :NoteId: as `id`.");
      // What the check corrected nothing of stays as it was.
      expect(notes).toContain("# list-notes\n`GET /notes` answers the text of every :Note:, newest :NoteTime: first, each with its :NoteId:.");
      expect(readFileSync(join(root, "plain", "tests", "notes", "add-note.plain"), "utf8")).toContain('# add-one\nPosting a :Note: with the text "hi" answers 201 with its `id`.');
      const report = readFileSync(result.reportFile, "utf8");
      expect(report).toContain("- notes:add-note - app/routes.py reads `text` and answers `id`.");
      expect(report).toContain("- notes:add-note, scenario add-one - app/routes.py answers the id.");
    } finally {
      STUB.verify = original;
    }
  });

  it("gathers the features into modules by concern - not by size - in the order they are built, rewriting a scenario that needs a later one", async () => {
    const tasks = new Map<string, string>();
    const original = { modules: STUB.modules!, reference: STUB.reference };
    STUB.reference = () => [
      "submit_capture_reference",
      { entries: [{ kind: "route", name: "POST /notes", aliases: [], choices: [], details: [], where: "app/routes.py:6", also: [] }, { kind: "route", name: "GET /notes", aliases: [], choices: [], details: [], where: "app/routes.py:12", also: [] }], excluded: [] },
    ];
    // The code's areas, gathered by size, make one module of everything. By concern, the api and keeping notes are two -
    // the api first: keeping notes is tried by adding them through it. Its scenario that needed keeping is rewritten.
    STUB.modules = (_label, _given, task) => (
      tasks.set("modules", task),
      [
        "submit_capture_modules",
        {
          modules: [
            { name: "notes-api", about: "Adding and listing notes over HTTP.", features: ["notes/api#add-note", "notes/api#list-notes"], needs: [] },
            { name: "keeping", about: "Notes outlive a restart.", features: ["notes/storage#note-storage"], needs: ["notes-api"] },
          ],
          rewrites: [{ feature: "notes/api#add-note", func_id: "add-note", scenario_id: "add-one", text: 'Posting a :Note: with the text "hi" answers 201, whether or not it is kept.', why: "keeping notes is a module built after it" }],
        },
      ]
    );
    try {
      const result = await runCapture({ root, leafLines: leafLines() });
      expect(result.modules).toEqual(["notes-api", "keeping"]);
      // Shown every feature, area by area, with what it owns, its functional specs and its scenarios, and the modules as
      // the code's areas make them.
      const task = tasks.get("modules")!;
      expect(task).toContain(
        "<features of notes, area by area, in the order of their code>\n## notes/storage - where notes are kept\n### notes/storage#note-storage - Keeping notes: Keeping notes between restarts.\n- keep-notes: Every :Note: is kept between restarts, with its :NoteTime:.\n\n## notes/api - the HTTP api for notes\n### notes/api#add-note - Adding a note: Adding a note: `POST /notes`.\n",
      );
      expect(task).toContain('  - scenario add-one: Posting a :Note: with the text "hi" answers 201.\n  - scenario no-text: Posting a :Note: with no text answers 400.');
      expect(task).toContain("<modules as the code's areas make them>\n- notes - a service that keeps short notes: notes/storage#note-storage, notes/api#add-note, notes/api#list-notes\n</modules as the code's areas make them>");

      const read = (path: string) => readFileSync(join(root, "plain", ...path.split("/")), "utf8");
      expect(existsSync(join(root, "plain", "notes.plain"))).toBe(false);
      expect(read("notes-api.plain")).not.toContain("requires:");
      expect(read("notes-api.plain")).toContain('description: "Adding and listing notes over HTTP."');
      expect(read("keeping.plain")).toContain("requires:\n  - notes-api");
      expect(read("tests/notes-api/add-note.plain")).toContain('# add-one\nPosting a :Note: with the text "hi" answers 201, whether or not it is kept.');
      expect(result.failing).toBe(0);

      const report = readFileSync(result.reportFile, "utf8");
      expect(report).toContain("- `keeping.plain` (requires notes-api) - Notes outlive a restart.");
      expect(report).toContain("- notes: notes-api, keeping\n- keeping needs notes-api\n- notes/api#add-note: add-note, scenario add-one - rewritten: keeping notes is a module built after it\n");
    } finally {
      Object.assign(STUB, original);
    }
  });

  it("tries every scenario on a copy of the original before it is written, keeping what the original does and what a test must set up", async () => {
    const tasks = new Map<string, string>();
    let copied = false;
    const original = STUB.trial!;
    STUB.trial = (label, _given, task) => {
      tasks.set(label, task);
      const folder = /<your folder>\n(.+) - a copy of the original codebase/.exec(task)![1]!;
      copied = existsSync(join(folder, "app", "routes.py")) && existsSync(join(folder, "tests", "test_notes.py")) && existsSync(join(folder, "uv.lock"));
      return [
        "submit_capture_trial",
        {
          scenarios: [
            { func_id: "add-note", scenario_id: "add-one", outcome: "corrected", ran: 'curl -d text=hi :5000/notes: 201 {"id": 1}', text: 'Posting a :Note: with the text "hi" answers 201 with its `id`.', why: "the original answers the note's id" },
            { func_id: "add-note", scenario_id: "no-text", outcome: "removed", ran: "", why: "the original's test mocks the database; nothing outside can make it fail" },
          ],
          functional_specs: [],
          test_reqs: [":ConformanceTests: start the service with `FLASK_DEBUG=0`, its database a file of the test's own."],
        },
      ];
    };
    // A lock file beside the manifest: left out of the map, yet copied, so the copy installs what the original pins.
    writeFileSync(join(root, "uv.lock"), "version = 1\n");
    try {
      const result = await runCapture({ root, leafLines: leafLines() });
      // An agent with a shell, on a copy of the original, its lock file with it - removed once it was done.
      expect(agentTools.get("trial notes")).toContain("bash");
      expect(agentTools.get("feature notes/api#add-note")).not.toContain("bash");
      expect(copied).toBe(true);
      expect(existsSync(join(root, "plain", ".turri", "capture", "trial", "notes"))).toBe(false);

      const task = tasks.get("trial notes")!;
      expect(task).toContain("<how its conformance tests run>\n### stdlib/backend/conformance/python-flask\n");
      expect(task).toContain('<scenarios to try>\n### add-note, scenario add-one (conformance)\nPosting a :Note: with the text "hi" answers 201.\n\n### add-note, scenario no-text (acceptance)\nPosting a :Note: with no text answers 400.\n</scenarios to try>');
      expect(task).toContain("nothing installed.\n</your folder>");

      const read = (path: string) => readFileSync(join(root, "plain", ...path.split("/")), "utf8");
      const scenarios = read("tests/notes/add-note.plain");
      expect(scenarios).toContain('# add-one\nPosting a :Note: with the text "hi" answers 201 with its `id`.');
      expect(scenarios).not.toContain("no-text");
      expect(read("template/notes-shared.plain")).toContain("***test reqs***\n\n- :ConformanceTests: start the service with `FLASK_DEBUG=0`, its database a file of the test's own.");
      expect(result.summary).toContain("0 of the 2 scenarios tried on the original held as written, 1 corrected to what it does, 1 removed.");
      const report = readFileSync(result.reportFile, "utf8");
      expect(report).toContain("- notes:add-note, scenario add-one - corrected: the original answers the note's id");
      expect(report).toContain("- notes:add-note, scenario no-text - removed: the original's test mocks the database; nothing outside can make it fail");
      expect(report).toContain("- notes: added to the test reqs - :ConformanceTests: start the service with `FLASK_DEBUG=0`, its database a file of the test's own.");
      // The original is never written.
      expect(readFileSync(join(root, "app", "routes.py"), "utf8")).toBe(NOTES_APP["app/routes.py"]);
    } finally {
      STUB.trial = original;
    }
  });

  it("shows the readability pass each functional spec with its scenarios, which say what its text need not", async () => {
    const tasks: string[] = [];
    const original = STUB.readability!;
    STUB.readability = (label, given, task) => (tasks.push(task), original(label, given, task));
    try {
      await runCapture({ root, leafLines: leafLines() });
    } finally {
      STUB.readability = original;
    }
    expect(tasks.join("\n")).toContain('# add-note\nA :User: can add a :Note: with `POST /notes`, giving its text; the answer is 201 with its :NoteId:.\n<scenarios of add-note>\n- conformance add-one: Posting a :Note: with the text "hi" answers 201.\n- acceptance no-text: Posting a :Note: with no text answers 400.\n</scenarios of add-note>');
  });

  it("writes each part's testing scripts once its ***plain is written, and says in the report where they are", async () => {
    const result = await runCapture({ root, leafLines: leafLines() });
    expect(scriptsAsked.sort()).toEqual(["notes:conformance", "notes:unit"]);
    expect(result.summary).toMatch(/ and its testing scripts, into /);
    const report = readFileSync(result.reportFile, "utf8");
    expect(report).toContain("- notes, the unit testing script: `test_scripts/run_unittests_python.sh`");
    expect(report).toContain("- notes, the conformance testing script: `test_scripts/run_conformance_tests_python.sh`");
    expect(report).toContain("Its testing scripts are written, and conformance tests are on.");
  });

  it("says a testing script it could not write, and what to ask turri for, and captures the rest", async () => {
    scriptFails = { conformance: "no test framework to go by" };
    const result = await runCapture({ root, leafLines: leafLines() });
    expect(result.summary).toContain("1 testing script was not written - the report says why.");
    const report = readFileSync(result.reportFile, "utf8");
    expect(report).toContain("- notes, the unit testing script: `test_scripts/run_unittests_python.sh`");
    expect(report).toContain("- notes, the conformance testing script: not written - no test framework to go by. Ask turri for it: `implement-conformance-testing-script`.");
    expect(report).toContain("Ask turri for the testing scripts not written above, then regenerate it");
  });

  it("starts the project it writes as the config in use - its models, thinking and settings - without what was the original's own", async () => {
    const here = mkdtempSync(join(tmpdir(), "turri-capture-here-"));
    try {
      writeFileSync(
        join(here, "config.turri.yaml"),
        [
          "# my settings",
          "harness-model: p/talk:high   # you talk to it",
          "coding-model: p/code:low",
          "module: legacy-app",
          "test-dir: specs",
          "unittests-script: scripts/unit.sh",
          "base-folder: skeleton",
          "debug: true",
          "conformance-tests: false",
          "",
        ].join("\n"),
      );
      const result = await runCapture({ root, leafLines: leafLines(), configFrom: here });
      for (const label of ["survey", "feature notes/api#add-note", "modules notes"]) {
        expect(agentModels.get(label), label).toEqual({ role: "capture", model: "p/talk:medium" });
      }
      expect(agentModels.get("reference notes")).toEqual({ role: "capture-exploration", model: "p/code:low" });
      for (const label of ["check notes", "verify notes", "trial notes", "split notes", "outline notes/api", "divide notes"]) {
        expect(agentModels.get(label), label).toEqual({ role: "capture-analysis", model: "p/code:low" });
      }
      expect(scriptModels).toEqual(["p/talk:medium", "p/talk:medium"]);
      const config = readFileSync(join(result.plainDir, "config.turri.yaml"), "utf8");
      expect(config).toContain(`# It started as the config in use where the capture was started - ${join(here, "config.turri.yaml")}`);
      expect(config).toContain("# my settings\nharness-model: p/talk:high   # you talk to it\ncoding-model: p/code:low\n");
      expect(config).toContain("debug: true");
      expect(config).toContain("conformance-tests: true");
      expect(config).toContain("base-folder: assets");
      expect(config).not.toMatch(/module:|test-dir:|unittests-script: scripts|skeleton|conformance-tests: false/);
    } finally {
      rmSync(here, { recursive: true, force: true });
    }
  });

  it("refuses to start from a config in use that does not parse, and writes nothing", async () => {
    const here = mkdtempSync(join(tmpdir(), "turri-capture-here-"));
    try {
      writeFileSync(join(here, "config.turri.yaml"), "coding-model: p/code:low\nsentinel: false\nsentinel: ask\n");
      await expect(runCapture({ root, leafLines: leafLines(), configFrom: here })).rejects.toThrow(/^config\.turri\.yaml, line 3: sentinel is set twice \(.*\)\. A capture starts from the config in use/);
      expect(existsSync(join(root, "plain"))).toBe(false);
    } finally {
      rmSync(here, { recursive: true, force: true });
    }
  });

  it("never runs over a finished capture, nor a folder that is not one", async () => {
    await runCapture({ root, leafLines: leafLines() });
    await expect(runCapture({ root, leafLines: leafLines() })).rejects.toThrow(/finished capture already/);

    const other = join(root, "elsewhere");
    mkdirSync(other);
    writeFileSync(join(other, "mine.plain"), "***functional specs***\n");
    await expect(runCapture({ root, plainDir: other })).rejects.toBeInstanceOf(CaptureError);
    expect(readFileSync(join(other, "mine.plain"), "utf8")).toBe("***functional specs***\n");
  });

  it("leaves a feature whose writer never holds uncaptured, and captures the rest", async () => {
    const original = STUB.feature!;
    STUB.feature = (label, given, task) => (label.endsWith("#list-notes") ? ["submit_capture_feature", { functional_specs: [], definitions: [], assumptions: [], uncertain: [], dropped: [] }] : original(label, given, task));
    try {
      const result = await runCapture({ root, leafLines: leafLines() });
      expect(result).toMatchObject({ specs: 2, uncaptured: 1, failing: 0 });
      expect(readFileSync(result.reportFile, "utf8")).toMatch(/feature list-notes of notes\/api \(app\/routes\.py, tests\/test_notes\.py\): what its writer handed over did not hold/);
    } finally {
      STUB.feature = original;
    }
  });
});
