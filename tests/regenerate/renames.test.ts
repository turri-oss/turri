import { describe, expect, it } from "vitest";
import type { MarshalledPlainSource } from "../../src/plain/spec.ts";
import { codeTree } from "../../src/regenerate/records.ts";
import { pureRenames, relabelled, renameText } from "../../src/regenerate/renames.ts";

const scenario = (id: string, text: string) => ({ id, text, linked_resources: [] });
const spec = (id: string, markdown: string, acceptance: Array<ReturnType<typeof scenario>> = [], extra: object = {}) => ({ id, markdown, linked_resources: [], conformance_tests: [], acceptance_tests: acceptance, ...extra });
const tree = (own: unknown[], required: unknown[] = []) => ({ "functional specs": own, ...(required.length > 0 ? { "required functional specs": required } : {}) }) as MarshalledPlainSource;

describe("a pure rename", () => {
  const built = tree([spec("add-task", "Add a task.", [scenario("adds", "A task is added.")]), spec("list-tasks", "List the tasks.")]);

  it("is a func-id renamed and nothing else - its text and scenarios the same - with the records as renamed", () => {
    const now = tree([spec("create-task", "Add a task.", [scenario("adds", "A task is added.")]), spec("list-tasks", "List the tasks.")]);
    const renamed = pureRenames(codeTree(built), built, now, "app");
    expect(renamed.renames.map(renameText)).toEqual(["app:add-task to app:create-task"]);
    expect((renamed.code?.["functional specs"] as Array<{ id: string }>).map((item) => item.id)).toEqual(["create-task", "list-tasks"]);
    expect((renamed.tests?.["functional specs"] as Array<{ id: string }>).map((item) => item.id)).toEqual(["create-task", "list-tasks"]);
  });

  it("is no rename when anything else changed with it - its text, or a scenario", () => {
    const reworded = tree([spec("create-task", "Add a task, named.", [scenario("adds", "A task is added.")]), spec("list-tasks", "List the tasks.")]);
    expect(pureRenames(codeTree(built), built, reworded, "app").renames).toEqual([]);
    const rescened = tree([spec("create-task", "Add a task.", [scenario("adds", "A task is added at once.")]), spec("list-tasks", "List the tasks.")]);
    expect(pureRenames(codeTree(built), built, rescened, "app").renames).toEqual([]);
  });

  it("is no rename of a functional spec regenerated again, or whose tests were written for other text", () => {
    const now = tree([spec("create-task", "Add a task.", [scenario("adds", "A task is added.")]), spec("list-tasks", "List the tasks.")]);
    const marked = tree([spec("add-task", "Add a task.", [], { regenerate_again: true }), spec("list-tasks", "List the tasks.")]);
    expect(pureRenames(codeTree(marked), built, now, "app").renames).toEqual([]);
    const older = tree([spec("add-task", "Add some task.", [scenario("adds", "A task is added.")]), spec("list-tasks", "List the tasks.")]);
    expect(pureRenames(codeTree(built), older, now, "app").renames).toEqual([]);
  });

  it("is a functional spec of a module below renamed, by its module", () => {
    const below = (id: string) => ({ ...spec(id, "Users register."), module: "base" });
    const renamed = pureRenames(codeTree(tree([], [below("register")])), null, tree([], [below("sign-up")]), "app");
    expect(renamed.renames.map(renameText)).toEqual(["base:register to base:sign-up"]);
  });

  it("is a scenario-id renamed under a functional spec otherwise unchanged - one changed too is no rename", () => {
    const now = tree([spec("add-task", "Add a task.", [scenario("is-added", "A task is added.")]), spec("list-tasks", "List the tasks.")]);
    expect(pureRenames(codeTree(built), built, now, "app").renames.map(renameText)).toEqual(["acceptance scenario adds of app:add-task to is-added"]);
    const moved = tree([{ ...spec("add-task", "Add a task."), conformance_tests: [scenario("is-added", "A task is added.")] }, spec("list-tasks", "List the tasks.")]);
    expect(pureRenames(codeTree(built), built, moved, "app").renames).toEqual([]);
  });
});

describe("relabelling", () => {
  it("rewrites a renamed func-id's labels and its scenarios', on the whole key only", () => {
    const text = "# conformance tests of app:add-task\n# acceptance scenario adds of app:add-task\n# conformance tests of app:add-task-2\n# conformance tests of base:add-task\n";
    expect(relabelled(text, [{ kind: "func-id", module: "app", from: "add-task", to: "create-task" }])).toBe(
      "# conformance tests of app:create-task\n# acceptance scenario adds of app:create-task\n# conformance tests of app:add-task-2\n# conformance tests of base:add-task\n",
    );
    expect(relabelled(text, [{ kind: "scenario-id", module: "app", funcId: "add-task", scenario: "acceptance", from: "adds", to: "is-added" }])).toContain("# acceptance scenario is-added of app:add-task\n");
  });
});
