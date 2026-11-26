import { Container, ScrollView, Text, stripTerminalSequences, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { expect, it } from "vitest";
import { chatTabHeader } from "../src/chat-tab-header.ts";
import { chatTabs } from "../src/chat-tabs.ts";

it("keeps one tab row directly below the banner until it scrolls out of view, then restores it when scrolling back", () => {
  let welcome = true;
  const clicks: string[] = [];
  const header = chatTabHeader(chatTabs(() => [], (text) => text, (action) => clicks.push(action.kind)), () => !welcome);
  const chat = new Container();
  const doc = new Container();
  doc.addChild(chat);
  const view = new ScrollView(doc, { follow: "end" });
  const screen = { documentContainer: doc, chatContainer: chat, transcriptScrollView: view, fullscreenLayoutRoot: view };
  const [sticky] = header.mount(screen, [doc]);
  const stop = header.watch(screen, { mode: "fullscreen", terminal: {} } as TUI);
  const banner = Object.assign(new Text("a wrapped warning\n───", 0, 0), { entry: {} });
  chat.addChild(banner);
  header.afterBanner(chat, banner.entry, () => welcome);
  chat.addChild(new Text(Array.from({ length: 14 }, (_, i) => `message ${i}`).join("\n"), 0, 0));

  const frame = () => {
    let redraw: boolean;
    for (let pass = 0; pass < 4; pass++) {
      redraw = false;
      const { lines } = renderLayoutFrame(screen.fullscreenLayoutRoot, 40, 8, () => { redraw = true; });
      if (!redraw) return lines.map((line) => stripTerminalSequences(line).trimEnd());
    }
    throw new Error("the tab row did not settle");
  };
  try {
    const bar = " + ".padEnd(28) + " ***plain ›";
    expect(frame()[0]).toBe(bar);
    view.scrollToStart();
    const top = frame();
    expect(top.slice(0, 4)).toEqual(["a wrapped warning", "───", bar, "message 0"]);
    expect(top.filter((line) => line === bar)).toHaveLength(1);
    view.scrollToEnd();
    const end = frame();
    expect(end[0]).toBe(bar);
    expect(end.at(-1)).toBe("message 13");
    welcome = false;
    view.scrollToStart();
    const compact = frame();
    expect(compact.slice(0, 2)).toEqual([bar, "message 0"]);
    expect(compact.filter((line) => line === bar)).toHaveLength(1);
    for (const type of ["press", "click"] as const) sticky!.handleMouse?.({ type, button: "left", width: 40, x: 1, y: 0, height: 1 } as TuiMouseEvent);
    expect(clicks).toEqual(["open"]);
    view.scrollToEnd();
    expect(frame()[0]).toBe(bar);
  } finally {
    stop();
  }
});
