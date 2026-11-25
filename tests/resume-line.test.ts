import { describe, expect, it } from "vitest";
import { withoutResumeLine } from "../src/resume-line.ts";

describe("the resume line", () => {
  it("is left out of what pi prints on the way out, the command on the line under it with it", () => {
    expect(withoutResumeLine("\x1b[2mTo resume this session:\x1b[22m\npi --session 01a13e52\n")).toBe("");
    expect(withoutResumeLine("To resume this session:\npi --session-dir /tmp/s --session 01a13e52\n")).toBe("");
  });

  it("leaves what was printed before and after it as it is", () => {
    expect(withoutResumeLine("bye\n\x1b[2mTo resume this session:\x1b[22m\npi --session 01a13e52\nafter\n")).toBe("bye\nafter\n");
  });

  it("leaves any other output as it is", () => {
    expect(withoutResumeLine("pi --session 1\n")).toBe("pi --session 1\n");
  });
});
