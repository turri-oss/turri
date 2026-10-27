import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLoadedTemplates, liquidErrorMessage } from "../../src/plain/files.ts";
import { resolveLinkedResource } from "../../src/plain/parser.ts";
import { PlainSyntaxError } from "../../src/plain/errors.ts";

/** Port of the tests in tests/test_loaders.py this parser has a counterpart for. */

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "turri-loaders-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const templates = "tests/data/templates";
const fixture = (name: string) => readFileSync(join(templates, `${name}.plain`), "utf8");

describe("loaders", () => {
  it("names only the missing template when an include is not found", () => {
    let message = "";
    try {
      getLoadedTemplates([tmp()], "{% include 'nope.plain' %}");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("nope.plain");
    expect(message).not.toContain("--template-dir");
  });

  it("finds no linked resource that is in none of the folders", () => {
    expect(resolveLinkedResource([tmp()], "missing.md")).toBeNull();
  });

  it("takes a linked resource from the first folder that has it", () => {
    const [first, second] = [tmp(), tmp()];
    for (const dir of [first, second]) writeFileSync(join(dir, "notes.md"), "x");
    expect(resolveLinkedResource([first, second], "notes.md")).toBe(join(first, "notes.md"));
  });

  it("falls back to a later folder for a linked resource", () => {
    const [first, second] = [tmp(), tmp()];
    writeFileSync(join(second, "notes.md"), "x");
    expect(resolveLinkedResource([first, second], "notes.md")).toBe(join(second, "notes.md"));
  });

  it("resolves a linked resource in a parent folder", () => {
    const root = tmp();
    const specDir = join(root, "plain");
    mkdirSync(specDir);
    writeFileSync(join(root, "shared.md"), "x");
    expect(resolveLinkedResource([specDir], "../shared.md")).toBe(join(specDir, "../shared.md"));
  });

  it("lets a folder of the name in the first folder shadow a file in the second", () => {
    // Existence, not being a file, decides the match.
    const [first, second] = [tmp(), tmp()];
    mkdirSync(join(first, "notes.md"));
    writeFileSync(join(second, "notes.md"), "x");
    expect(resolveLinkedResource([first, second], "notes.md")).toBe(join(first, "notes.md"));
  });

  it("reports a malformed Liquid tag as a plain syntax error naming the template", () => {
    expect(() => getLoadedTemplates([templates], fixture("malformed_tag"), "malformed_tag")).toThrow(PlainSyntaxError);
    expect(() => getLoadedTemplates([templates], fixture("malformed_tag"), "malformed_tag")).toThrow(
      "Plain syntax error: Invalid Liquid at malformed_tag:3:",
    );
  });

  it("reports unterminated Liquid output as a plain syntax error naming the template", () => {
    expect(() => getLoadedTemplates([templates], fixture("unterminated_output"), "unterminated_output")).toThrow(
      "Plain syntax error: Invalid Liquid at unterminated_output:4:",
    );
  });

  it("says where a Liquid syntax error is only as far as it is known", () => {
    expect(liquidErrorMessage(new Error("missing expression"), "header")).toBe(
      "Plain syntax error: Invalid Liquid in header: missing expression",
    );
    expect(liquidErrorMessage(new Error("missing expression"))).toBe("Plain syntax error: Invalid Liquid: missing expression");
  });
});
