import { describe, expect, it } from "vitest";
import { type Component, stripTerminalSequences } from "@earendil-works/pi-tui";
// How pi's full screen lays out its root in the terminal's rows: not among what pi-tui's index exports.
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { padScreen, paddedColumns, paddedRows, SCREEN_PADDING, unpadded } from "../src/screen-padding.ts";
import { narrowChat } from "../src/regenerate/panel-dock.ts";

/** A chat that says how wide it was last drawn. */
const chat = () => {
  const drawn = { width: 0 };
  const component: Component = {
    render: (width) => {
      drawn.width = width;
      return ["chat"];
    },
    invalidate() {},
  };
  return { drawn, component };
};

/** pi's full screen, as far as the padding reaches it. */
const fullScreen = (root: Component | undefined) => ({
  layoutRoot: root,
  setLayoutRoot(next: Component | undefined) {
    this.layoutRoot = next;
  },
  render: () => [],
});

describe("the padding round the screen", () => {
  it("leaves the screen what is inside it", () => {
    expect(paddedColumns(120)).toBe(120 - SCREEN_PADDING.left - SCREEN_PADDING.right);
    expect(paddedRows(40)).toBe(40 - SCREEN_PADDING.top - SCREEN_PADDING.bottom);
    expect(paddedColumns(1)).toBe(1);
  });

  it("puts pi's full screen layout in the middle of blank rows and columns, once", () => {
    const { drawn, component } = chat();
    const screen = fullScreen(component);
    padScreen(screen);
    padScreen(screen);
    expect(unpadded(screen.layoutRoot!)).toBe(component);
    const lines = renderLayoutFrame(screen.layoutRoot!, 120, 10, () => {}).lines.map(stripTerminalSequences);
    expect(drawn.width).toBe(paddedColumns(120));
    expect(lines).toHaveLength(10);
    expect(lines.slice(0, SCREEN_PADDING.top).every((line) => line.trim() === "")).toBe(true);
    expect(lines[SCREEN_PADDING.top]!.indexOf("chat")).toBe(SCREEN_PADDING.left);
    expect(lines.slice(10 - SCREEN_PADDING.bottom).every((line) => line.trim() === "")).toBe(true);
  });

  it("pads a layout pi gives the screen after, and waits for the first", () => {
    const { component } = chat();
    const screen = fullScreen(undefined);
    padScreen(screen);
    screen.setLayoutRoot(component);
    expect(screen.layoutRoot).toBe(component);
    padScreen(screen);
    const { component: next } = chat();
    screen.setLayoutRoot(next);
    expect(unpadded(screen.layoutRoot!)).toBe(next);
    screen.setLayoutRoot(undefined);
    expect(screen.layoutRoot).toBeUndefined();
  });

  it("draws pi's regular screen indented in fewer columns, with blank lines above and below", () => {
    class Screen {
      widths: number[] = [];
      render(width: number): string[] {
        this.widths.push(width);
        return ["chat", "editor"];
      }
    }
    const screen = new Screen();
    padScreen(screen);
    const lines = screen.render(120);
    expect(screen.widths).toEqual([paddedColumns(120)]);
    const left = " ".repeat(SCREEN_PADDING.left);
    expect(lines).toEqual([...new Array<string>(SCREEN_PADDING.top).fill(""), `${left}chat`, `${left}editor`, ...new Array<string>(SCREEN_PADDING.bottom).fill("")]);
  });

  it("keeps the chat narrowed beside the docked panel inside it, and pads it whole again once undocked", () => {
    const { drawn, component } = chat();
    const screen = fullScreen(component);
    padScreen(screen);
    const undock = narrowChat(screen, () => 40);
    expect(unpadded(screen.layoutRoot!)).not.toBe(component);
    renderLayoutFrame(screen.layoutRoot!, 120, 10, () => {});
    expect(drawn.width).toBe(paddedColumns(120) - 40);
    undock();
    expect(unpadded(screen.layoutRoot!)).toBe(component);
    renderLayoutFrame(screen.layoutRoot!, 120, 10, () => {});
    expect(drawn.width).toBe(paddedColumns(120));
  });

  it("narrows pi's regular screen beside the docked panel inside it", () => {
    class Screen {
      widths: number[] = [];
      render(width: number): string[] {
        this.widths.push(width);
        return [];
      }
    }
    const screen = new Screen();
    padScreen(screen);
    const undock = narrowChat(screen, () => 40);
    screen.render(120);
    undock();
    screen.render(120);
    expect(screen.widths).toEqual([paddedColumns(120 - 40), paddedColumns(120)]);
  });
});
