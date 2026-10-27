import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Test plain files for a test project: every functional spec has one, in `tests/<module>/`, or its module does not
 * parse. These write the empty one - both sections, no scenario - that a functional spec with no tests has.
 */

/** A test plain file's text: its binding, and its two sections, each with the scenarios given. */
export function testPlainFile(module: string, funcId: string, scenarios: { conformance?: string[]; acceptance?: string[] } = {}): string {
  const section = (items: string[] | undefined) => (items ?? []).map((item) => `${item.trim()}\n`).join("\n");
  return `---\nmodule: ${module}\nfunc_id: ${funcId}\n---\n\n***conformance tests***\n\n${section(scenarios.conformance)}\n***acceptance tests***\n\n${section(scenarios.acceptance)}`;
}

/** The func-ids of a module's functional specs, as its text writes them. */
export function funcIdsIn(text: string): string[] {
  const after = text.split("***functional specs***")[1] ?? "";
  return [...after.matchAll(/^# ([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/gm)].map((match) => match[1]!);
}

/**
 * Every functional spec of the modules in a project's folder given an empty test plain file, where it has none - and the
 * empty ones of functional specs taken out, or of modules gone, removed. A test plain file with scenarios is left as it is.
 */
export function syncTestPlainFiles(projectDir: string, testDir = "tests"): void {
  const modules = new Map<string, string[]>();
  for (const name of readdirSync(projectDir).filter((entry) => entry.endsWith(".plain"))) {
    modules.set(basename(name, ".plain"), funcIdsIn(readFileSync(join(projectDir, name), "utf8")));
  }
  const root = join(projectDir, testDir);
  // Taken out: the empty test plain files of functional specs, or modules, that are no more.
  if (existsSync(root)) {
    for (const module of readdirSync(root)) {
      const folder = join(root, module);
      let files: string[];
      try {
        files = readdirSync(folder).filter((entry) => entry.endsWith(".plain"));
      } catch {
        continue;
      }
      for (const file of files) {
        const funcId = basename(file, ".plain");
        if (modules.get(module)?.includes(funcId) === true) continue;
        if (readFileSync(join(folder, file), "utf8") === testPlainFile(module, funcId)) rmSync(join(folder, file));
      }
    }
  }
  for (const [module, funcIds] of modules) {
    for (const funcId of funcIds) {
      const folder = join(root, module);
      const bound = existsSync(folder) && readdirSync(folder).some((file) => file.endsWith(".plain") && new RegExp(`^func_id: ${funcId}\\s*$`, "m").test(readFileSync(join(folder, file), "utf8")));
      if (bound) continue;
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${funcId}.plain`), testPlainFile(module, funcId));
    }
  }
}

/** Write a module and keep its test plain files in step with it. */
export function writePlain(projectDir: string, name: string, text: string): void {
  writeFileSync(join(projectDir, name), text);
  syncTestPlainFiles(projectDir);
}

/** A git diff that adds a file, as a ***plain change adds a test plain file. */
export function newFileDiff(path: string, text: string): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`), ""].join("\n");
}
