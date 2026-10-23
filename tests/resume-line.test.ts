import { describe, expect, it } from "vitest";
import { withoutResumeLine } from "../src/resume-line.ts";

describe("the resume line", () => {
  it("is left out of what pi prints on the way out", () => {
    expect(withoutResumeLine("\x1b[2mTo resume this session:\x1b[22m pi --session 01a13e52\n")).toBe("");
    expect(withoutResumeLine("To resume this session: pi --session-dir /tmp/s --session 01a13e52\n")).toBe("");
  });

  it("leaves any other output as it is", () => {
    expect(withoutResumeLine("pi --session 1\n")).toBe("pi --session 1\n");
  });
});
