import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Test plain files for a test project. A functional spec with no scenarios has none - a missing one is valid, and an
 * empty one is a syntax error - so only a functional spec given scenarios is given one.
 */

/** A test plain file's text: its binding, and each section that has scenarios, with them - a section with none is left out. */
export function testPlainFile(module: string, funcId: string, scenarios: { conformance?: string[]; acceptance?: string[] } = {}): string {
  const section = (title: string, items: string[] | undefined) =>
    (items ?? []).length === 0 ? "" : `\n***${title}***\n\n${(items ?? []).map((item) => `${item.trim()}\n`).join("\n")}`;
  return `---\nmodule: ${module}\nfunc_id: ${funcId}\n---\n${section("conformance tests", scenarios.conformance)}${section("acceptance tests", scenarios.acceptance)}`;
}

/** The func-ids of a module's functional specs, as its text writes them. */
export function funcIdsIn(text: string): string[] {
  const after = text.split("***functional specs***")[1] ?? "";
  return [...after.matchAll(/^# ([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/gm)].map((match) => match[1]!);
}

/** Write a module. Its functional specs need no test plain files: one with no scenarios has none. */
export function writePlain(projectDir: string, name: string, text: string): void {
  writeFileSync(join(projectDir, name), text);
}

/** A git diff that adds a file, as a ***plain change adds a test plain file. */
export function newFileDiff(path: string, text: string): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`), ""].join("\n");
}
