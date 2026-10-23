import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { animateJellyfish, shownFrame } from "../src/extension.ts";
import { JELLYFISH_FRAME_MS, JELLYFISH_FRAMES, JELLYFISH_REST, JELLYFISH_SEQUENCE } from "../src/jellyfish.ts";

/** A chat on a screen `rows` tall, its conversation `lines()` long: the jellyfish's clock started on it. */
function screen(rows: number, lines: () => number) {
  const renders: number[] = [];
  const tui = {
    terminal: { columns: 80, rows },
    render: () => Array.from({ length: lines() }, () => ""),
    requestRender: () => void renders.push(shownFrame()),
  };
  const ctx = { ui: { setWidget: (_key: string, factory: (tui: unknown) => unknown) => void factory(tui) } } as unknown as ExtensionContext;
  animateJellyfish(ctx);
  return { renders };
}

describe("the banner's jellyfish", () => {
  afterEach(() => vi.useRealTimers());

  it("comes to rest swimming, whole, once the conversation outgrows the screen - never on a polyp half grown", () => {
    vi.useFakeTimers();
    let lines = 10;
    const { renders } = screen(40, () => lines);
    // Into the lifecycle, the polyp growing: past the first frames, short of the swim.
    vi.advanceTimersByTime(JELLYFISH_FRAME_MS * 8);
    expect(shownFrame()).not.toBe(JELLYFISH_SEQUENCE[JELLYFISH_REST]);
    lines = 60;
    vi.advanceTimersByTime(JELLYFISH_FRAME_MS);
    expect(shownFrame()).toBe(JELLYFISH_SEQUENCE[JELLYFISH_REST]);
    expect(renders.at(-1)).toBe(JELLYFISH_SEQUENCE[JELLYFISH_REST]);
    // Stopped: no frame after it.
    const drawn = renders.length;
    vi.advanceTimersByTime(JELLYFISH_FRAME_MS * 20);
    expect(renders).toHaveLength(drawn);
  });

  it("rests on the jellyfish's own pose, swimming", () => {
    // The two swimming strokes are the last frames; the rest is the first of them.
    expect(JELLYFISH_SEQUENCE[JELLYFISH_REST]).toBe(JELLYFISH_FRAMES.length - 2);
  });
});
