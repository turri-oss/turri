import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseModuleChain, plainFileParser } from "../../src/plain/parser.ts";
import { MissingFunctionalitiesError, ModuleDoesNotExistError, PlainSyntaxError } from "../../src/plain/errors.ts";

/** Port of tests/test_requires.py. */

const data = "tests/data/requires";
const namesOf = (chain: Array<[string, unknown]>) => chain.map(([name]) => name);

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "turri-requires-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A module; `functionalSpec` null writes one without a ***functional specs*** section. */
function writeModule(
  directory: string,
  moduleName: string,
  exportedConcepts: string[],
  requiredModules: string[],
  definitions: string[],
  functionalSpec: string | null,
): void {
  const exports = exportedConcepts.map((concept) => `  - ${concept}\n`).join("");
  const requires = requiredModules.map((module) => `  - ${module}\n`).join("");
  writeFileSync(
    join(directory, `${moduleName}.plain`),
    "---\n" +
      (exportedConcepts.length > 0 ? `exported_concepts:\n${exports}` : "") +
      (requiredModules.length > 0 ? `requires:\n${requires}` : "") +
      "---\n\n" +
      "***definitions***\n\n" +
      definitions.map((definition) => `- ${definition}\n\n`).join("") +
      "***implementation reqs***\n\n- An implementation requirement.\n" +
      (functionalSpec !== null ? `\n***functional specs***\n\n- ${functionalSpec}\n` : ""),
  );
}

/**
 * One module per entry, requiring the listed ones. Each exports :<name>Concept: and uses the exported concept of every
 * module it requires, so an export that does not reach a dependent module fails the parse with "is not defined".
 */
function writeModulesUsingRequiredExports(directory: string, requiresByModule: Record<string, string[]>): void {
  for (const [moduleName, requiredModules] of Object.entries(requiresByModule)) {
    const used = requiredModules.map((module) => ` :${module}Concept:`).join("");
    writeModule(
      directory,
      moduleName,
      [`:${moduleName}Concept:`],
      requiredModules,
      [`:${moduleName}Concept: is defined by ${moduleName}.`],
      `:${moduleName}Concept: uses${used || " nothing"}.`,
    );
  }
}

describe("requires", () => {
  it("rejects a required module that does not exist", () => {
    expect(() => plainFileParser("non_existent_require.plain", [data])).toThrow(ModuleDoesNotExistError);
  });

  it("parses a module with a normal requires chain", () => {
    expect(() => plainFileParser("normal_requires_main.plain", [data])).not.toThrow();
  });

  it("orders the chain required modules first", () => {
    const chain = parseModuleChain("chain_top.plain", [data]);
    expect(namesOf(chain)).toEqual(["chain_base", "chain_middle", "chain_top"]);
    for (const [, tree] of chain) expect("functional specs" in tree).toBe(true);
  });

  it("gives the chain of a module that requires nothing as the module alone", () => {
    expect(namesOf(parseModuleChain("chain_base.plain", [data]))).toEqual(["chain_base"]);
  });

  it("lists an ancestor two modules share once", () => {
    expect(namesOf(parseModuleChain("chain_fork_top.plain", [data]))).toEqual(["chain_base", "chain_middle", "chain_fork_top"]);
  });

  it("passes on a required module's errors when walking the chain", () => {
    expect(() => parseModuleChain("non_existent_require.plain", [data])).toThrow("Module does not exist");
  });

  it("validates the required modules as it parses the top module", () => {
    expect(() => plainFileParser("invalid_ancestor_top.plain", [data])).toThrow("Concept :UndefinedThing: is not defined");
  });

  it("lets a middle module see the exports of a base module", () => {
    expect(() => plainFileParser("shared_export_top.plain", [data])).not.toThrow();
  });

  it("lets a middle module see the exports of a base module when parsing a module above them", () => {
    expect(namesOf(parseModuleChain("shared_export_above.plain", [data]))).toEqual([
      "shared_export_base",
      "shared_export_middle",
      "shared_export_top",
      "shared_export_above",
    ]);
  });

  it("rejects a middle module that defines again what a base module exports", () => {
    const dir = tmp();
    writeModule(dir, "Base", [":BaseConcept:"], [], [":BaseConcept: is defined by Base."], "Base works.");
    writeModule(dir, "Middle", [], ["Base"], [":BaseConcept: is defined again by Middle."], "Middle uses :BaseConcept:.");
    writeModule(dir, "Top", [], ["Base", "Middle"], [], "Top uses :BaseConcept:.");
    expect(() => parseModuleChain("Top.plain", [dir])).toThrow("Concepts were defined multiple times: :BaseConcept:");
  });

  it("lets a base module export nothing", () => {
    const dir = tmp();
    writeModule(dir, "Base", [], [], [":BaseConcept: is defined by Base."], "Base works.");
    writeModule(dir, "Middle", [":MiddleConcept:"], ["Base"], [":MiddleConcept: is defined by Middle."], "Middle works.");
    writeModule(dir, "Top", [], ["Base", "Middle"], [], "Top uses :MiddleConcept:.");
    expect(namesOf(parseModuleChain("Top.plain", [dir]))).toEqual(["Base", "Middle", "Top"]);
  });

  // In each diagram, a line down from one module to another means the upper module requires the lower one.
  describe("which requires chains are accepted", () => {
    it.each([
      //   Top
      //   |  \
      //   |  Middle
      //   |  /
      //   Base
      ["top also requires base before middle", { Top: ["Base", "Middle"], Middle: ["Base"], Base: [] }, ["Base", "Middle", "Top"]],
      //   Top
      //    ||     Top lists Base twice
      //   Base
      ["top lists base twice", { Top: ["Base", "Base"], Base: [] }, ["Base", "Top"]],
    ])("accepts the chain where %s", (_, requiresByModule, expected) => {
      const dir = tmp();
      writeModulesUsingRequiredExports(dir, requiresByModule);
      expect(namesOf(parseModuleChain("Top.plain", [dir]))).toEqual(expected);
    });

    it.each([
      // Same shape as the first accepted chain, but Top lists Base after Middle: an ancestor must be listed before its
      // dependent.
      ["top also requires base after middle", { Top: ["Middle", "Base"], Middle: ["Base"], Base: [] }],
      // Every module also requires every module below it: only the last module walked is recognised as repeated.
      [
        "upper also requires base and middle",
        { Top: ["Base", "Middle", "Upper"], Upper: ["Base", "Middle"], Middle: ["Base"], Base: [] },
      ],
      // Two branches that meet at a shared base.
      ["two branches share a base", { Top: ["Left", "Right"], Left: ["Base"], Right: ["Base"], Base: [] }],
      ["two branches share a base, right listed first", { Top: ["Right", "Left"], Left: ["Base"], Right: ["Base"], Base: [] }],
      [
        "two branches share a base two levels down",
        { Top: ["Left", "Right"], Left: ["LeftBase"], Right: ["RightBase"], LeftBase: ["Base"], RightBase: ["Base"], Base: [] },
      ],
      [
        "the branches below right share a base",
        { Top: ["Left", "Right"], Left: ["Base"], Other: ["Base"], Right: ["Left", "Other"], Base: [] },
      ],
      [
        "two branches share a base and top requires it too",
        { Top: ["Base", "Left", "Right"], Left: ["Base"], Right: ["Base"], Base: [] },
      ],
      // Branches that share no base.
      ["two modules without requires", { Top: ["Left", "Right"], Left: [], Right: [] }],
      ["branches without a shared base", { Top: ["Left", "Right"], Left: [], Right: ["Other"], Other: [] }],
      ["a module is listed twice around its dependent", { Top: ["Base", "Middle", "Base"], Middle: ["Base"], Base: [] }],
    ])("rejects the chain where %s with the fixed-order error", (_, requiresByModule) => {
      const dir = tmp();
      writeModulesUsingRequiredExports(dir, requiresByModule as Record<string, string[]>);
      expect(() => parseModuleChain("Top.plain", [dir])).toThrow("There must be a fixed order how required modules are dependent");
    });
  });

  // Two broken modules in one chain: each test pins which error is reported first.
  describe("which error comes first", () => {
    it("checks the top module's shape before reading its requires", () => {
      const dir = tmp();
      writeModule(dir, "Top", [], ["Missing"], [], null);
      expect(() => plainFileParser("Top.plain", [dir])).toThrow(MissingFunctionalitiesError);
    });

    it("checks the top module's shape before validating its required modules", () => {
      const dir = tmp();
      writeModule(dir, "Base", [], [], [], "Base uses :BaseMissing:.");
      writeModule(dir, "Top", [], ["Base"], [], null);
      expect(() => plainFileParser("Top.plain", [dir])).toThrow(MissingFunctionalitiesError);
    });

    it("reports a required module's parse errors before the top module's concept errors", () => {
      const dir = tmp();
      writeFileSync(join(dir, "Base.plain"), "***implementation reqs***\n\n- {% if %}\n\n***functional specs***\n\n- Base works.\n");
      writeModule(dir, "Top", [], ["Base"], [], "Top uses :TopMissing:.");
      expect(() => plainFileParser("Top.plain", [dir])).toThrow(PlainSyntaxError);
      expect(() => plainFileParser("Top.plain", [dir])).toThrow("Invalid Liquid");
    });

    it("reports the top module's concept errors before a required module's", () => {
      const dir = tmp();
      writeModule(dir, "Base", [], [], [], "Base uses :BaseMissing:.");
      writeModule(dir, "Top", [], ["Base"], [], "Top uses :TopMissing:.");
      expect(() => plainFileParser("Top.plain", [dir])).toThrow("Concept :TopMissing: is not defined");
    });

    it("validates the required modules top down", () => {
      const dir = tmp();
      writeModule(dir, "Base", [], [], [], "Base uses :BaseMissing:.");
      writeModule(dir, "Middle", [], ["Base"], [], "Middle uses :MiddleMissing:.");
      writeModule(dir, "Top", [], ["Middle"], [], "Top works.");
      expect(() => plainFileParser("Top.plain", [dir])).toThrow("Concept :MiddleMissing: is not defined");
    });

    it("rejects a required module without functional specs", () => {
      const dir = tmp();
      writeModule(dir, "Base", [], [], [], null);
      writeModule(dir, "Top", [], ["Base"], [], "Top works.");
      expect(() => plainFileParser("Top.plain", [dir])).toThrow(MissingFunctionalitiesError);
      expect(() => plainFileParser("Top.plain", [dir])).toThrow("Module 'Base'");
    });

    it("reports the top module's concept errors before a required module's structure errors", () => {
      const dir = tmp();
      writeModule(dir, "Base", [], [], [], null);
      writeModule(dir, "Top", [], ["Base"], [], "Top uses :TopMissing:.");
      expect(() => plainFileParser("Top.plain", [dir])).toThrow("Concept :TopMissing: is not defined");
    });
  });

  it("has a tree for every module the walk reaches", () => {
    const dir = tmp();
    writeModulesUsingRequiredExports(dir, { Top: ["Base", "Middle"], Middle: ["Base"], Base: [] });
    const chain = parseModuleChain("Top.plain", [dir]);
    expect(namesOf(chain)).toEqual(["Base", "Middle", "Top"]);
    for (const [, tree] of chain) expect("functional specs" in tree).toBe(true);
  });
});
