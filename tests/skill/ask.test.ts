import { describe, expect, it } from "vitest";
import { peekKeyListener } from "../../src/panel-view.ts";

describe("peeking while a question waits", () => {
  it("opens the panel on ctrl+h while a question has the keys - unless the panel shows, whose own ctrl+h closes it - and lets every other key through", () => {
    let shown = false;
    const opened: string[] = [];
    const listen = peekKeyListener({ open: () => opened.push("panel"), shown: () => shown });
    expect(listen("\x08")).toEqual({ consume: true });
    expect(opened).toEqual(["panel"]);
    // Any other key is the question's.
    expect(listen("a")).toBeUndefined();
    expect(listen("\r")).toBeUndefined();
    // The panel shows: its listener has ctrl+h.
    shown = true;
    expect(listen("\x08")).toBeUndefined();
    expect(opened).toEqual(["panel"]);
  });
});
