import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { focusOf, lineDiff, type MarkedPage } from "@turri-dev/core";
import { createSidePanel } from "../../src/regenerate/side-panel.ts";
import { createSpecMapState, columnHeadings, legendLines, specMapHeader, specMapLines, switchTab, tabBar, wordDiff } from "../../src/regenerate/spec-map-view.ts";
import type { TranscriptStyle } from "../../src/regenerate/transcript-view.ts";
import { PLAIN_PAINT } from "../../src/regenerate/diff-view.ts";

/**
 * What the CLI draws of the spec map. The map itself - each module's items, marked built, regenerating, planned or
 * waiting - is the core's (`work.map()`, `map` events): its marking is tested there. Here the pages are as the core
 * marked them for each case, kept in marked-pages.json, the project's folder written <dir>.
 */
const MARKED = JSON.parse(readFileSync(new URL("./marked-pages.json", import.meta.url), "utf8")) as Record<string, MarkedPage[][]>;

let dir: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-spec-map-"));
  cwd = process.cwd();
  process.chdir(dir);
  writeFileSync(join(dir, "config.yaml"), "conformance-tests: true\n");
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

/** The pages the core marked for a case - its `at`th map - in this test's project folder. */
const marked = (name: string, at = 0): MarkedPage[] => JSON.parse(JSON.stringify(MARKED[name]![at]).split("<dir>").join(dir)) as MarkedPage[];

const id = (text: string) => text;
/** A style that shows what is struck, added and removed as text. */
const style: TranscriptStyle = {
  heading: id,
  muted: id,
  accent: id,
  error: id,
  success: id,
  warning: id,
  added: (text) => `{+${text}+}`,
  removed: (text) => `[-${text.replace(/\x1b\[\d+m/g, "")}-]`,
};

describe("the regeneration drawn", () => {
  it("strikes a ghost through, word-diffs a changed first line, and shows only the sub-bullet that changed under a changed item", () => {
    // Its first item changed in a sub-bullet, its second removed and another added.
    const { lines } = specMapLines(marked("ghost"), createSpecMapState(), 100, style);
    const text = lines.join("\n");
    expect(text).toContain("- Register a user.");
    expect(text).toContain("  - The response is [-200.-]{+201.+}");
    expect(text).not.toContain("Emails are lowercased");
    expect(text).toContain("[-- Search for users by name.-]");
    expect(lines.find((line) => line.includes("# search-for"))).toMatch(/^ +− /);
  });

  it("wraps an item too long for the width, its lines after the first hanging past the bullet, never cutting it short", () => {
    const long = "- :UserAdmin: is the local administration entry point whose successful provisioning output follows `[resource]user-created.schema.json` exactly.";
    const lines = specMapLines(marked("wraps"), createSpecMapState(), 60, style).lines;
    const at = lines.findIndex((line) => line.includes(":UserAdmin:"));
    const rows = lines.slice(at).filter((line) => line.includes("│"));
    expect(lines.join("\n")).not.toContain("…");
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(60);
    // Each line after the first starts under the text, past "- ".
    expect(rows[1]).toMatch(/^ {8}│ {3}\S/);
    expect(rows.map((row) => row.slice(row.indexOf("│") + 2).trim()).join(" ")).toBe(long);
  });

  it("opens an item to the rest of its text and its acceptance tests - where it stands is beside its mark, not repeated under it", () => {
    // A new functional spec planned in a pulse, beside one built.
    const [planned] = marked("opens-item", 0);
    const state = createSpecMapState();
    for (const entry of planned!.items) state.open.add(`${planned!.plainFile}\n${entry.key}`);
    const lines = specMapLines([planned!], state, 120, style).lines;
    const text = lines.join("\n");
    expect(text).not.toMatch(/│ [◇○◆] /);
    // Nor what its first line was: the word diff on the row says it.
    expect(text).not.toContain("was:");
    expect(text).not.toContain("not regenerated yet");
    // A changed item's lines that did not change are the spec's, as any: not dimmed.
    const [markedChange] = marked("opens-item", 1);
    const openChange = createSpecMapState();
    for (const entry of markedChange!.items) openChange.open.add(`${markedChange!.plainFile}\n${entry.key}`);
    const shownChange = specMapLines([markedChange!], openChange, 120, { ...style, muted: (t: string) => `<dim>${t}</dim>` }).lines.join("\n");
    expect(shownChange).toContain("│   - In the order received.");
    expect(shownChange).not.toContain("<dim>  - In the order received.</dim>");
    expect(text).toContain("  - The response is 201.");
    expect(text).not.toContain("used by");
  });

  it("opens a functional spec's scenarios as its test plain file has them - each kind under a heading drawn as a section's, each scenario under its id - and says nothing of tests where it has none", () => {
    // A functional spec with conformance and acceptance tests.
    const [patched] = marked("scenarios");
    const state = createSpecMapState();
    for (const entry of patched!.items) state.open.add(`${patched!.plainFile}\n${entry.key}`);
    const painted: TranscriptStyle = { ...style, diff: { ...PLAIN_PAINT, syntax: (role, text) => (role === "section" ? `<section>${text}</section>` : text) } };
    const lines = specMapLines([patched!], state, 120, painted).lines;
    const row = lines.findIndex((line) => line.includes("# patch"));
    expect(lines[row]).toMatch(/│ # patch$/);
    expect(lines[row + 1]).toBe("        │ Patch the records.");
    expect(lines.join("\n")).not.toContain("not conform");
    const conformance = lines.findIndex((line) => line.includes("conformance tests"));
    expect(lines[conformance - 1]!.trimEnd()).toMatch(/│$/);
    // Each kind's heading and its scenarios indented under the functional spec, a blank line after each scenario.
    expect(lines.slice(conformance, conformance + 4)).toEqual(["        │   <section>***conformance tests***</section>", "        │   # patches", "        │   A record is patched.", "        │"]);
    const heading = lines.findIndex((line) => line.includes("acceptance tests"));
    expect(lines[heading]).toBe("        │   <section>***acceptance tests***</section>");
    expect(lines[heading - 1]).toBe("        │");
    expect(lines[heading - 2]).not.toBe("        │");
    expect(lines.slice(heading + 1, heading + 7)).toEqual(["        │   # lookup", "        │   A lookup becomes an `@odata.bind` entry.", "        │", "        │   # empty-record", "        │   An empty record patches nothing.", "        │"]);
  });

  it("shows the files a module imports under its own text, each closed until opened - the module it requires is a tab of its own", () => {
    // top requires base, and imports two files of the standard library - one of its items changed.
    const pages = marked("imports");
    const state = createSpecMapState();
    const text = specMapLines(pages, state, 100, style).lines.join("\n");
    // The module asked for is shown; the one it requires is not drawn under it.
    expect(text).toContain("- Say hello.");
    expect(text).toContain("imported (2)");
    expect(text).toContain("▸ from stdlib/lang/python · 1 req · all built");
    expect(text).toContain("▸ from stdlib/backend/python-fastapi · 1 req · 1 changing");
    expect(text).not.toContain("Use FastAPI");
    expect(text).not.toContain("required (");
    expect(text).not.toContain("- Store a value.");
    // Opened, an import block shows its items, word by word where they changed.
    state.imports.set(`${join(dir, "top.plain")}\nstdlib/backend/python-fastapi`, true);
    expect(specMapLines(pages, state, 100, style).lines.join("\n")).toContain("- Use [-Flask.-]{+FastAPI.+}");
    // ← goes to the module it requires.
    switchTab(pages, state, -1);
    expect(specMapLines(pages, state, 100, style).lines.join("\n")).toContain("- Store a value.");
  });

  it("has a tab a module of the chain, in its order, the one shown marked - fitted to the width around it, the rest counted", () => {
    // A chain of seven modules, each requiring the one before.
    const names = ["version_api", "function_executor", "http_client", "auth", "utils", "listing", "restore_api"];
    const chain = marked("chain-tabs");
    const shown = chain.find((page) => page.module === "auth")!;
    expect(tabBar(chain, shown, 200, style, 0).line).toBe("version_api  function_executor  http_client  [auth]  utils  listing  restore_api");
    const { line: narrow } = tabBar(chain, shown, 40, style, 0);
    expect(narrow).toContain("[auth]");
    expect(narrow).toMatch(/^‹ \d+ {2}.*\[auth\].* \d+ ›$/);
    expect(narrow.length).toBeLessThanOrEqual(40);
    // A chain of many modules draws only the one shown, not each nested in the next.
    const lines = specMapLines(chain, createSpecMapState(), 120, style).lines.join("\n");
    const focus = focusOf(chain)!;
    expect(lines).toContain(`- ${focus.module} works.`);
    expect(names.filter((name) => name !== focus.module).some((name) => lines.includes(`- ${name} works.`))).toBe(false);
  });

  it("heads the map with its count and status, and its two columns with status and the module's file", () => {
    // One of its two functional specs built, nothing asked of it.
    const top = marked("header")[0]!;
    const head = specMapHeader(top, 160, style);
    expect(head).not.toContain("top.plain");
    expect(columnHeadings(top, 160, style)).toEqual([" status │ top.plain", "        │"]);
    expect(head).toContain("1 of 2 functionalities built · not asked to build - regenerate plans it");
  });

  it("highlights the spec as plyn does - its section headings, concepts and literals - the words a diff keeps too", () => {
    const paint = { ...PLAIN_PAINT, syntax: (role: string, text: string) => `<${role}>${text}</${role}>` };
    // log-out changed a word: "log out" is "sign out" now.
    const text = specMapLines(marked("highlights"), createSpecMapState(), 300, { ...style, diff: paint }).lines.join("\n");
    expect(text).toContain("<section>***functional specs***</section>");
    expect(text).toContain("<bullet>-</bullet> A <concept>:User:</concept> can log in via <literal>`POST /auth/login`</literal>.");
    expect(text).toContain("A <concept>:User:</concept> can [-log-]{+sign+} out via <literal>`POST /auth/logout`</literal>.");
  });

  it("diffs a line word by word and an item line by line", () => {
    expect(wordDiff("3 to 30 characters", "3 to 20 characters", style)).toBe("3 to [-30-]{+20+} characters");
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([{ was: "a", now: "a" }, { was: "b", now: "B" }, { was: "c", now: "c" }]);
  });
});

describe("the side panel's two views", () => {
  const job = (id: string) => ({ id, kind: "regenerate", summary: "app.plain log in", module: "app", status: "running" as const, sequence: 1, queuedAt: 0, startedAt: Date.now(), waitingOn: [], tail: "", activity: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, agents: [], transcript: [] });

  /** Drive the panel by what is actually on screen, including the dock's coordinate translation. */
  function clickLabel(panel: ReturnType<typeof createSidePanel>, text: string, width: number) {
    const lines = panel.render(width);
    const y = lines.findIndex((line) => line.includes(text));
    expect(y, `visible label: ${text}`).toBeGreaterThanOrEqual(0);
    const x = lines[y]!.indexOf(text);
    for (const type of ["press", "click"] as const) {
      panel.handleMouse({ type, button: "left", x, y, screenX: x + width + 2, screenY: y + 1, width, height: lines.length, shift: false, alt: false, ctrl: false });
    }
    return panel.render(width);
  }

  it("opens a spec on a wrapped summary after scrolling, and leaves keyboard navigation on that spec", () => {
    // Twelve functional specs, then follow-link: none built.
    const pages = marked("scroll");
    const mapState = createSpecMapState();
    const panel = createSidePanel({ jobs: () => [], map: () => pages, mapState, rows: () => 25, style, key: "ctrl+h", back() {}, close() {} });
    panel.render(40);
    panel.handleInput("G");
    panel.render(40);
    panel.handleMouse({ type: "wheel", button: "none", x: 10, y: 15, width: 40, height: 25, screenX: 54, screenY: 16, wheelDelta: 8, shift: false, alt: false, ctrl: false });
    expect(mapState.top).toBeGreaterThan(0);
    clickLabel(panel, "destination.", 40);
    expect(mapState.open.has(mapState.cursorKey!)).toBe(true);
    expect(panel.render(40).find((line) => line.startsWith("›"))).toContain("# follow-link");
    panel.handleInput("\r");
    expect(mapState.open.size).toBe(0);
  });

  it("toggles an imported file and switches to another module by clicking its name", () => {
    // app requires base, and imports Python from the standard library.
    const lib = "stdlib/lang/python";
    const pages = marked("import-click");
    const panel = createSidePanel({ jobs: () => [], map: () => pages, rows: () => 40, style, key: "ctrl+h", back() {}, close() {} });
    expect(clickLabel(panel, `▸ from ${lib}`, 90).join("\n")).toContain("Use Python.");
    expect(clickLabel(panel, `▾ from ${lib}`, 90).join("\n")).not.toContain("Use Python.");
    expect(clickLabel(panel, "base  [app]", 90).join("\n")).toContain("status │ base.plain");
  });

  it("opens pulse sections, pulses and diff files by clicking their labels", () => {
    const jobs = [{ ...job("done"), status: "succeeded" as const, diff: "--- a/app.plain\n+++ b/app.plain\n@@ -1 +1,2 @@\n+- Keep the query.\n" }];
    const panel = createSidePanel({ jobs: () => jobs, rows: () => 35, style, key: "ctrl+h", back() {}, close() {} });
    expect(clickLabel(panel, "finished (1)", 70).join("\n")).toContain("app regenerate");
    expect(clickLabel(panel, "app regenerate", 70).join("\n")).toContain("Keep the query.");
    expect(clickLabel(panel, "app.plain", 70).join("\n")).not.toContain("Keep the query.");
    expect(clickLabel(panel, "app.plain", 70).join("\n")).toContain("Keep the query.");
  });

  it("opens either view from its tab even with no spec, and clicking the selected tab keeps that view", () => {
    let closed = 0;
    let highlighted = "";
    const panel = createSidePanel({ jobs: () => [], map: () => [], rows: () => 20, style, key: "ctrl+h", back() {}, close() { closed++; }, tabLabel(text, active) { if (active) highlighted = text; return text; } });
    const click = (x: number) => {
      for (const type of ["press", "click"] as const) panel.handleMouse({ type, button: "left", x, y: 0, screenX: 72 + x, screenY: 1, width: 68, height: 20, shift: false, alt: false, ctrl: false });
    };
    const [tabs] = panel.render(68);
    expect(tabs).toMatch(/^ \*\*\*plain {3}pulses +× close $/);
    expect(highlighted).toBe(" ***plain ");
    click(tabs!.indexOf("pulses"));
    expect(panel.render(68)[0]).toBe(tabs);
    expect(highlighted).toBe(" pulses ");
    expect(panel.render(68).slice(1, 3)).toEqual(["", "pulses"]);
    click(tabs!.indexOf("pulses"));
    expect(panel.render(68)[2]).toBe("pulses");
    click(tabs!.indexOf("plain"));
    expect(panel.render(68).join("\n")).toContain("No .plain file to map");
    expect(closed).toBe(0);
    click(tabs!.indexOf("close"));
    expect(closed).toBe(1);
  });

  it("opens on regen, and p goes to the pulse regenerating the item under the cursor and back to the item", () => {
    // log-in regenerating in pulse 1, the row job1.
    const pages = marked("regen-p");
    const panel = createSidePanel({ jobs: () => [job("job1")], map: () => pages, rows: () => 20, style, back() {}, close() {}, key: "ctrl+h" });
    const [, gap, title] = panel.render(100);
    expect(gap).toBe("");
    expect(title).toContain("regen");
    panel.handleInput("\x1b[B");
    panel.handleInput("\x1b[B");
    panel.handleInput("p");
    const pulses = panel.render(100);
    expect(pulses[2]).toMatch(/^pulses/);
    // A line of space under the rule, before the first section.
    const rule = pulses.findIndex((line) => /^─+$/.test(line));
    expect(pulses[rule + 1]).toBe("");
    expect(pulses[rule + 2]).toMatch(/running \(\d+\)/);
    expect(pulses.find((line) => line.startsWith("›"))).toContain("app regenerate");
    panel.handleInput("p");
    const map = panel.render(100);
    expect(map.find((line) => line.startsWith("›"))).toContain("# log-in");
  });

  it("draws one mark a row on the ladder - planned, working, regenerated, validating, conform - the same whatever the config says of conformance tests, named in the legend in the corner", () => {
    // register conforms, log-in and log-out are built, search is to regenerate.
    const [ladder] = marked("ladder");
    const lines = specMapLines([ladder!], createSpecMapState(), 100, style).lines;
    // A mark alone, under the status column's heading.
    expect(lines.find((line) => line.includes("# register"))).toMatch(/^[ ›] {2}◆ {4}│ # register/);
    expect(lines.find((line) => line.includes("# log-in"))).toMatch(/^[ ›] {2}◇ {4}│ # log-in/);
    expect(lines.find((line) => line.includes("# search"))).toMatch(/^[ ›] {2}○ {4}│ # search/);
    // A line of space between one functional spec and the next, as the file writes them.
    const logIn = lines.findIndex((line) => line.includes("# log-in"));
    expect(lines[logIn - 1]).toBe("        │");
    expect(lines[logIn - 2]).toMatch(/│ \S/);
    // A functional spec with no scenarios says nothing of it on its row: its mark says where it stands.
    expect(lines.find((line) => line.includes("# log-in"))!.trimEnd()).toMatch(/# log-in$/);
    // The legend: up the ladder, every rung whatever the page has - to take out only where something is.
    expect(legendLines(ladder!, style)).toEqual(["○ planned", "⠋ working", "◇ regenerated", "⠋ validating", "◆ conform", "! needs you"]);
    const panel = createSidePanel({ jobs: () => [], map: () => [ladder!], rows: () => 20, style, back() {}, close() {}, key: "ctrl+h" });
    const drawn = panel.render(100);
    // In the upper right corner, beside the title and the keys - the keys at the top, where they are seen first.
    const plain = drawn.slice(2).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
    // Validating spins in the green of the rungs it is between, working in the accent: told apart at a glance.
    const painted = legendLines(ladder!, { ...style, accent: (text: string) => `<accent>${text}`, success: (text: string) => `<green>${text}` });
    expect(painted[1]).toBe("<accent>⠋ working");
    expect(painted[3]).toBe("<green>⠋ validating");
    const legend = ["○ planned", "⠋ working", "◇ regenerated", "⠋ validating", "◆ conform", "! needs you"];
    // A box in the upper right corner, the panel's first lines beside it.
    expect(plain[0]).toMatch(/ ┌─+┐$/);
    expect(plain.slice(1, 7).map((line) => line.slice(line.lastIndexOf("│ ", line.length - 2) + 2, -1).trim())).toEqual(legend);
    expect(plain[7]).toMatch(/ └─+┘$/);
    // The top line wraps beside it, never cut short; the keys under it - at the top, where they are seen first - and
    // the rule straight under them, stopping short of the box.
    expect(plain.join("\n")).not.toContain("...");
    const rule = plain.findIndex((line) => /^─+ +│/.test(line));
    expect(plain.slice(0, rule).join(" ")).toContain("↑↓ move");
    // A line of space under the title, and under the rule.
    const blankBeside = (line: string) => line.split(/[│┌└]/)[0]!.trim() === "";
    expect(blankBeside(plain[plain.findIndex((line) => line.startsWith("↑↓ move")) - 1]!)).toBe(true);
    expect(blankBeside(plain[rule + 1]!)).toBe(true);
    expect(plain[rule + 2]).toMatch(/^ status │ app\.plain/);
  });

  it("hands a module that needs the person to the chat on d, and offers the key only then", () => {
    // Pulse 3, which was to build log-in, did not land; then the same page with nothing wrong.
    const stuck = marked("stuck", 0);
    const discussed: string[] = [];
    let pages = marked("stuck", 1);
    const panel = createSidePanel({ jobs: () => [], map: () => pages, rows: () => 20, style, back() {}, close() {}, key: "ctrl+h", discuss: (shown) => discussed.push(shown.status) });
    expect(panel.render(100).join("\n")).not.toContain("d talk it through");
    panel.handleInput("d");
    expect(discussed).toEqual([]);
    pages = stuck;
    const lines = panel.render(100);
    expect(lines[2]).toContain("! needs you");
    expect(lines[4]).toMatch(/^d talk it through in the chat · /);
    panel.handleInput("d");
    expect(discussed).toEqual(["pulse 3 didn't land"]);
  });

  it("shows what failed when the map cannot be drawn, rather than throwing - a frame that throws freezes the screen", () => {
    const panel = createSidePanel({ jobs: () => [], map: () => { throw new Error("the plan could not be read"); }, rows: () => 20, style, back() {}, close() {}, key: "ctrl+h" });
    const lines = panel.render(100);
    expect(lines).toHaveLength(20);
    expect(lines.find((line) => line.includes("could not be drawn"))).toContain("could not be drawn: Error: the plan could not be read");
    expect(lines[4]).toContain("p the other view · esc or ctrl+h back to the chat");
    panel.handleInput("p");
    expect(panel.render(100)[2]).toMatch(/^pulses/);
  });

  it("goes from one module's tab to the next with ←→, follows the module regenerating until another tab is chosen, and opens an item with enter", () => {
    // top requires base, top asked for; then top's "- Two." regenerating in pulse 1.
    let pages = marked("tabs-keys", 0);
    const panel = createSidePanel({ jobs: () => [], map: () => pages, rows: () => 20, style, back() {}, close() {}, key: "ctrl+h" });
    // The module asked for is shown, its tab marked, the other beside it.
    let lines = panel.render(100);
    const heading = () => lines.find((line) => line.startsWith(" status │"))?.split("  ")[0];
    expect(heading()).toBe(" status │ top.plain");
    expect(lines[3]).toMatch(/^base {2}\[top\] /);
    expect(lines.join("\n")).toContain("- Two.");
    expect(lines.join("\n")).not.toContain("- One.");
    // ← to the module it is built on.
    panel.handleInput("\x1b[D");
    lines = panel.render(100);
    expect(heading()).toBe(" status │ base.plain");
    expect(lines[3]).toMatch(/^\[base\] {2}top /);
    expect(lines.join("\n")).toContain("- One.");
    // Enter opens the item under the cursor.
    panel.handleInput("\r");
    expect(panel.render(100).length).toBe(20);
    // Another module starts regenerating: the tab chosen gives way, and it is shown.
    pages = marked("tabs-keys", 1);
    // The top line wraps beside the legend as long as it needs to: the tabs are on the line after it.
    expect(panel.render(100).find((line) => line.startsWith("base"))).toMatch(/^base {2}\[\S+ top\] /);
  });
});
