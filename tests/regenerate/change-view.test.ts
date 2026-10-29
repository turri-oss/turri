import { describe, expect, it } from "vitest";
import { agentChanges, changeDiff, changeDiffInFiles } from "../../src/regenerate/change-view.ts";
import { diffView, locateDiffLines } from "../../src/regenerate/diff-view.ts";
import type { SpecChange } from "../../src/regenerate/spec-steps.ts";

const item = (markdown: string, extra: Record<string, unknown> = {}) => JSON.stringify({ markdown, ...extra });
const add = (section: string, position: number, markdown: string, extra?: Record<string, unknown>): SpecChange => ({
  id: `${section}-${position}`,
  section,
  kind: "add",
  after: item(markdown, extra),
  position,
});

const app = [
  "***definitions***",
  "",
  "- :User: is a person.",
  "- :Board: is a grid.",
  "",
  "***functional specs***",
  "",
  "- A :User: sees the :Board:.",
  "",
].join("\n");
const imported = ["***definitions***", "", "- :Engine: draws the :Board:.", "", "***implementation reqs***", "", "- Use the engine.", ""].join("\n");
const files = [
  { name: "app.plain", text: app },
  { name: "template/engine.plain", text: imported },
];
const locate = (diff: string) => locateDiffLines(diff, files);

describe("a job's change as its agent is given it", () => {
  it("shows each item in the file it is written in - an import's in the import's - under its section, with its line", () => {
    const changes = [
      add("definitions", 1, "- :Engine: draws the :Board:."),
      add("definitions", 2, "- :User: is a person."),
      add("implementation reqs", 1, "- Use the engine."),
      add("functional specs", 1, "- A :User: sees the :Board:."),
    ];
    const { diff, where } = changeDiffInFiles(changes, "app.plain", locate);
    const shown = diffView(diff, 80, undefined, where).map((line) => line.trimEnd());

    expect(shown).toContain("app.plain  +2");
    expect(shown).toContain("template/engine.plain  +2");
    expect(shown).toContain("3 + - :User: is a person.");
    expect(shown).toContain("8 + - A :User: sees the :Board:.");
    expect(shown).toContain("3 + - :Engine: draws the :Board:.");
    expect(shown).toContain("7 + - Use the engine.");
    // Only what the job takes: the definition no functional spec of it uses is not there.
    expect(shown.some((line) => line.includes(":Board: is a grid"))).toBe(false);
  });

  it("puts each file's items in the order the file has them, not the order the spec is read in", () => {
    const later = add("definitions", 1, "- :Board: is a grid.");
    const earlier = add("definitions", 2, "- :User: is a person.");
    const { diff } = changeDiffInFiles([later, earlier], "app.plain", locate);
    expect(diff.indexOf(":User: is a person")).toBeLessThan(diff.indexOf(":Board: is a grid"));
  });

  it("writes a changed functional spec out and in under its func-id heading, as its file has it - its scenarios are not in that file", () => {
    const diff = changeDiff(
      [{ id: "f", section: "functional specs", kind: "change", before: item("One.", { id: "one" }), after: item("One, loudly.", { id: "one", acceptance_tests: [{ id: "loud", text: "It is loud." }] }), position: 1 }],
      "app.plain",
    );
    expect(diff).toContain(" ***functional specs***\n-# one\n-One.\n+# one\n+One, loudly.");
    expect(diff).not.toContain("It is loud.");
  });

  it("lays out a conformance job's changed scenarios as a diff of the functional spec's test plain file alone - nothing of the module's file, which did not change", () => {
    const change: SpecChange = {
      id: "f", section: "functional specs", kind: "change", position: 1,
      before: item("One.", { id: "one", conformance_tests: [], acceptance_tests: [{ id: "loud", text: "It is loud." }] }),
      after: item("One.", { id: "one", conformance_tests: [], acceptance_tests: [{ id: "loud", text: "It is very loud." }] }),
    };
    const diff = changeDiff([change], "app.plain", { module: "app", pathOf: (funcId) => `tests/app/${funcId}.plain` });
    const block = diff.slice(diff.indexOf("diff --git a/tests/app/one.plain b/tests/app/one.plain"));
    expect(block).toContain("--- a/tests/app/one.plain\n+++ b/tests/app/one.plain");
    expect(block).toContain("-It is loud.");
    expect(block).toContain("+It is very loud.");
    // Only what changed, among the lines around it: the rest of the file is never taken out and put back.
    expect(block).not.toContain("-func_id: one");
    expect(diff).not.toContain("diff --git a/app.plain");
    expect(diff).not.toContain("***functional specs***");
    // Without a module to lay them out for - a code job - no test plain file is shown.
    expect(changeDiff([change], "app.plain")).not.toContain("tests/app/one.plain");
  });

  it("shows a scenario added to a test plain file as that scenario added, and a new test plain file as added whole", () => {
    const view = { module: "shorty", pathOf: (funcId: string) => `tests/shorty/${funcId}.plain` };
    const two = [{ id: "creates", text: "It answers 201." }, { id: "codes-differ", text: "Two codes differ." }];
    const added: SpecChange = {
      id: "f", section: "functional specs", kind: "change", position: 1,
      before: item("Creates a link.", { id: "create-link", conformance_tests: two, acceptance_tests: [] }),
      after: item("Creates a link.", { id: "create-link", conformance_tests: [...two, { id: "url-echoed", text: "The url comes back as given." }], acceptance_tests: [] }),
    };
    const block = changeDiff([added], "shorty.plain", view).split("diff --git a/tests/shorty/create-link.plain")[1]!;
    expect(block.split("\n").filter((line) => /^[-+](?![-+]{2} )/.test(line))).toEqual(["+", "+# url-echoed", "+The url comes back as given."]);
    const fresh: SpecChange = {
      id: "f", section: "functional specs", kind: "change", position: 1,
      before: item("Creates a link.", { id: "create-link", conformance_tests: [], acceptance_tests: [] }),
      after: item("Creates a link.", { id: "create-link", conformance_tests: two, acceptance_tests: [] }),
    };
    const all = changeDiff([fresh], "shorty.plain", view);
    const whole = all.split("diff --git a/tests/shorty/create-link.plain")[1]!;
    expect(whole).toContain("@@ -0,0 +1,");
    expect(whole).not.toMatch(/^-(?!-- )/m);
    // The test plain file alone: no section header of the module's over it, which a test plain file does not have.
    expect(all.startsWith("diff --git a/tests/shorty/create-link.plain")).toBe(true);
    expect(all).not.toContain("***functional specs***");
  });

  it("keeps a functional spec in the module's file when its text changed with its scenarios - its scenarios in its test plain file", () => {
    const view = { module: "shorty", pathOf: (funcId: string) => `tests/shorty/${funcId}.plain` };
    const both: SpecChange = {
      id: "f", section: "functional specs", kind: "change", position: 1,
      before: item("Creates a link.", { id: "create-link", conformance_tests: [], acceptance_tests: [] }),
      after: item("Creates a short link.", { id: "create-link", conformance_tests: [{ id: "creates", text: "It answers 201." }], acceptance_tests: [] }),
    };
    const diff = changeDiff([both], "shorty.plain", view);
    expect(diff).toContain(" ***functional specs***\n-# create-link\n-Creates a link.\n+# create-link\n+Creates a short link.");
    expect(diff.indexOf("diff --git a/shorty.plain")).toBeLessThan(diff.indexOf("diff --git a/tests/shorty/create-link.plain"));
  });

  it("shows a required module's functional spec under the functional specs heading its file has, never the parser's key for it", () => {
    const diff = changeDiff([add("required functional specs", 1, "- The :Engine: starts.")], "app.plain");
    expect(diff).toContain(" ***functional specs***\n+- The :Engine: starts.");
    expect(diff).not.toContain("required functional specs");
  });

  it("leaves the test reqs out of a code job's change, and keeps them in a conformance job's", () => {
    const changes = [add("test reqs", 1, "- Use pytest."), add("functional specs", 1, "- One.")];
    expect(agentChanges(changes, "code").map((change) => change.section)).toEqual(["functional specs"]);
    expect(agentChanges(changes, "conformance")).toHaveLength(2);
  });
});
