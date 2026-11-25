import { type Component, type Container, type ScrollView, type TUI, VStack } from "@earendil-works/pi-tui";
import type { ChatTabs } from "./chat-tabs.ts";
import { terminalPointer } from "./pointer-hover.ts";

export interface ChatScreen {
  fullscreenLayoutRoot: Component;
  documentContainer: Container;
  chatContainer: Container;
  transcriptScrollView: ScrollView;
}

/** Where pi drew a child. Use the row counts its Container already measured for mouse dispatch: the width of the
 * chat, the banner's image and any wrapped warnings all affect where the divider lands. */
function rowOf(parent: Container, child: Component): number | undefined {
  const measured = (parent as unknown as { childLines?: { children: readonly Component[]; parts: readonly (readonly string[])[] } }).childLines;
  if (measured === undefined) return undefined;
  let row = 0;
  for (const [index, component] of measured.children.entries()) {
    if (component === child) return row;
    row += measured.parts[index]!.length;
  }
  return undefined;
}

/** The inline tabs are a sibling of the banner in the transcript. A single fixed row takes over when they scroll
 * off the top (or a resumed conversation has no banner). The banner itself scrolls normally. */
export function chatTabHeader(tabs: ChatTabs) {
  let pinned = true;
  const sticky: Component = {
    render: (width) => pinned ? tabs.render(width) : [],
    handleMouse: (event) => pinned ? tabs.handleMouse?.(event) : undefined,
    invalidate() {},
  };
  return {
    mount(screen: ChatScreen, components: Component[]): Component[] {
      if (components.includes(sticky)) return components;
      screen.fullscreenLayoutRoot = new VStack([sticky, { component: screen.fullscreenLayoutRoot, basis: 0, grow: 1, minSize: 1 }]);
      return [sticky, ...components];
    },
    afterBanner(chat: Container, entry: unknown) {
      if (chat.children.includes(tabs)) return;
      const at = chat.children.findIndex((child) => (child as { entry?: unknown }).entry === entry);
      if (at !== -1) chat.children.splice(at + 1, 0, tabs);
    },
    watch(screen: ChatScreen, tui: TUI): () => void {
      if (tui.mode !== "fullscreen") {
        // Regular mode has native scrollback: the row below the banner scrolls with it.
        pinned = false;
        return () => {};
      }
      const view = screen.transcriptScrollView;
      tabs.pointer = terminalPointer(tui.terminal);
      const update = view.updateLayout;
      view.updateLayout = function (height, viewport, redraw) {
        update.call(this, height, viewport, redraw);
        const chat = rowOf(screen.documentContainer, screen.chatContainer);
        const tab = rowOf(screen.chatContainer, tabs);
        const row = chat === undefined || tab === undefined ? -1 : chat + tab;
        const next = row < this.scrollTop || row >= this.scrollTop + viewport;
        if (next !== pinned) {
          pinned = next;
          redraw();
        }
      };

      // pi normally asks multiplexers for button motion only. The tabs need motion without a button too. pi disables
      // all mouse modes itself when it leaves fullscreen, including when the terminal is suspended.
      const mouse = tui as unknown as { mouseEnabled: boolean; beforeTerminalStart(): void; handleViewportInput(data: string): unknown };
      const start = mouse.beforeTerminalStart;
      mouse.beforeTerminalStart = function () {
        start.call(this);
        if (this.mouseEnabled) tui.terminal.write("\x1b[?1003h");
      };
      const input = mouse.handleViewportInput;
      mouse.handleViewportInput = (data) => tabs.pointer.dispatch(() => input.call(mouse, data), () => tui.requestRender());
      return () => {
        view.updateLayout = update;
        mouse.beforeTerminalStart = start;
        mouse.handleViewportInput = input;
      };
    },
  };
}
