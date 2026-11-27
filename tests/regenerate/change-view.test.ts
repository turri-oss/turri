import { describe, expect, it } from "vitest";
import { diffView } from "../../src/regenerate/diff-view.ts";
import { locateDiffLines } from "@turri-dev/core/terminal";
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
    const diff = ["--- a/app.plain", "+++ b/app.plain", "@@ -0,0 +1,4 @@", "+- :User: is a person.", "+- A :User: sees the :Board:.", "+- :Engine: draws the :Board:.", "+- Use the engine."].join("\n");
    const where = locate(diff);
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
});
