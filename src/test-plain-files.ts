import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { testDirOf } from "./config.ts";
import { PLAIN_SOURCE_FILE_EXTENSION } from "./plain/parser.ts";
import { FUNC_ID_KEY, loadFrontmatter, MODULE_KEY } from "./plain/test-plain-file.ts";
import { projectDirOf } from "./regenerate/paths.ts";

/**
 * Where a project's test plain files are, and what each belongs to: `<test-dir>/<module>/`, every `.plain` file in it
 * a test plain file of that module - its functional specs' conformance and acceptance scenarios. turri finds modules
 * only in the project's folder and its `template/` folder, so a test plain file is never taken for a module; and no
 * tool takes one in place of its module.
 */

/** Every .plain file under a folder, at any depth, sorted by path; none when it is not there. */
function plainFilesUnder(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let directory = false;
    try {
      directory = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (directory) found.push(...plainFilesUnder(path));
    else if (name.endsWith(PLAIN_SOURCE_FILE_EXTENSION)) found.push(path);
  }
  return found;
}

/** A module's test plain files: every .plain file under `<test-dir>/<module>/`, sorted, as absolute paths. */
export function testPlainFilesOf(plainFile: string): string[] {
  return plainFilesUnder(join(testDirOf(plainFile), basename(plainFile, PLAIN_SOURCE_FILE_EXTENSION)));
}

/** Whether a path is a folder, or below one. */
function within(path: string, folder: string): boolean {
  const from = relative(folder, path);
  return from === "" || (!from.startsWith("..") && !from.startsWith(sep) && from !== "..");
}

/** The frontmatter of a .plain file, as a test plain file's is read; empty when it cannot be read. */
function frontmatterOf(path: string): Record<string, unknown> {
  try {
    return loadFrontmatter(readFileSync(path, "utf8").split("\r\n").join("\n")).metadata;
  } catch {
    return {};
  }
}

/** The modules of a project, by name: the .plain files in its folder and its `template/` folder. */
export function projectModules(projectDir: string): Map<string, string> {
  const modules = new Map<string, string>();
  for (const dir of [join(projectDir, "template"), projectDir]) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(PLAIN_SOURCE_FILE_EXTENSION));
    } catch {
      continue;
    }
    for (const name of names) modules.set(basename(name, PLAIN_SOURCE_FILE_EXTENSION), join(dir, name));
  }
  return modules;
}

/** What a path under a project's test folder is: the test folder itself, or a module's folder or file in it. */
export interface TestPlace {
  projectDir: string;
  testDir: string;
  /** The module whose folder it is in - `tests/<module>/...` - when it is in one. */
  folderModule?: string;
  /** For a file: the `module:` and `func_id:` it names. */
  module?: string;
  funcId?: string;
  directory: boolean;
}

/**
 * Where a path is, when it is a test plain file - under the project's test folder, or a .plain file whose frontmatter
 * binds it with `module:` and `func_id:` - or the test folder, or a folder in it. Undefined for anything else.
 */
export function testPlaceOf(path: string): TestPlace | undefined {
  const absolute = resolve(path);
  const directory = existsSync(absolute) && statSync(absolute).isDirectory();
  const projectDir = projectDirOf(directory ? join(absolute, "x.plain") : absolute);
  const testDir = testDirOf(join(projectDir, "x.plain"));
  const metadata = directory || !existsSync(absolute) ? {} : frontmatterOf(absolute);
  const bound = typeof metadata[MODULE_KEY] === "string" && typeof metadata[FUNC_ID_KEY] === "string";
  if (!within(absolute, testDir) && !bound) return undefined;
  const parts = within(absolute, testDir) ? relative(testDir, absolute).split(sep).filter(Boolean) : [];
  const folderModule = directory ? parts[0] : parts.length > 1 ? parts[0] : undefined;
  return {
    projectDir,
    testDir,
    directory,
    ...(folderModule !== undefined ? { folderModule } : {}),
    ...(bound ? { module: metadata[MODULE_KEY] as string, funcId: metadata[FUNC_ID_KEY] as string } : {}),
  };
}

/** A path as a person reads it in the project: from its folder. */
function shown(path: string, projectDir: string): string {
  return relative(projectDir, resolve(path)).split(sep).join("/");
}

/**
 * Why a tool refuses a path in place of a module: it is a test plain file - naming its module and the functional
 * spec it binds to - or a test folder. Undefined for a path that is not one.
 */
export function testPlainFileRefusal(path: string): string | undefined {
  const place = testPlaceOf(path);
  if (place === undefined) return undefined;
  const given = shown(path, place.projectDir) + (place.directory ? "/" : "");
  const module = place.module ?? place.folderModule;
  if (place.directory) {
    return module === undefined
      ? `\`${given}\` is the test folder of the project, which holds the test plain files; name a module's .plain file.`
      : `\`${given}\` is the test folder of \`${module}\`; name \`${module}.plain\`.`;
  }
  if (module === undefined) return `\`${given}\` is in the test folder, where test plain files are; name a module's .plain file.`;
  const funcId = place.funcId ?? basename(path, PLAIN_SOURCE_FILE_EXTENSION);
  return `\`${given}\` is a test plain file of \`${module}\`; name \`${module}.plain\`, or \`${module}:${funcId}\` for that one functional spec.`;
}

/** Refuse a path that is a test plain file or a test folder, as every tool that takes a module does. */
export function refuseTestPlainFile(path: string): void {
  const refusal = testPlainFileRefusal(path);
  if (refusal !== undefined) throw new Error(refusal);
}

/**
 * The test plain files of a project that are not where they belong, each with where it does: a file outside any
 * module's folder, in the folder of a module there is not, or in a module's folder its `module:` does not name. Strays
 * are not read when a module is parsed; this is where they are found.
 */
export function strayTestPlainFiles(projectDir: string): Array<{ file: string; problem: string }> {
  const testDir = testDirOf(join(projectDir, "x.plain"));
  const modules = projectModules(projectDir);
  const strays: Array<{ file: string; problem: string }> = [];
  for (const path of plainFilesUnder(testDir)) {
    const file = shown(path, projectDir);
    const folder = relative(testDir, dirname(path)).split(sep).filter(Boolean)[0];
    const metadata = frontmatterOf(path);
    const named = typeof metadata[MODULE_KEY] === "string" ? (metadata[MODULE_KEY] as string) : undefined;
    const home = (module: string) => `${shown(join(testDir, module), projectDir)}/`;
    if (folder === undefined) {
      strays.push({ file, problem: named === undefined ? "move it to the folder of its module, in the test folder" : `move it to ${home(named)} (its module: ${named})` });
    } else if (!modules.has(folder)) {
      strays.push({
        file,
        problem: named === undefined ? `no module ${folder}` : `no module ${folder}; module: ${named} is in ${home(named)}`,
      });
    } else if (named !== undefined && named !== folder) {
      strays.push({ file, problem: `its module: is ${named}, not ${folder}; move it to ${home(named)}` });
    }
  }
  return strays;
}

/** The module a test plain file belongs to, by its folder, and that module's .plain file when the project has one. */
export function moduleOfTestPlainFile(path: string): { module: string; plainFile: string | undefined } | undefined {
  const place = testPlaceOf(path);
  const module = place?.folderModule;
  if (place === undefined || module === undefined) return undefined;
  return { module, plainFile: projectModules(place.projectDir).get(module) };
}
