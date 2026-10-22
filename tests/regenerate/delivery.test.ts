import { describe, expect, it } from "vitest";
import { tryItCommand } from "../../src/regenerate/delivery.ts";

describe("the offer to try what a job built", () => {
  it("names the command on the command line, which has no one to ask", () => {
    expect(tryItCommand(`${process.cwd()}/app.plain`)).toBe("To try it: turri release app.plain");
  });
});
