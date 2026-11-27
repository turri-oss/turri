import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type Component, type OverlayHandle, isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import type { Frontend, Job, MarkedPage } from "@turri-dev/core";
import { plainPaint, brandNeon } from "./regenerate/plain-palette.ts";
import { clickToFocus, dockedWidth, narrowChat, shade, shadeChat } from "./regenerate/panel-dock.ts";
import { paddedColumns, paddedRows, SCREEN_PADDING } from "./screen-padding.ts";
import { createSidePanel } from "./regenerate/side-panel.ts";
import { createSpecMapState, type SpecMapState } from "./regenerate/spec-map-view.ts";
import { notificationView, type NotificationsSource } from "./terminal-notifications.ts";
import { createJobsTreeState, selectJob } from "./regenerate/jobs-tree.ts";
import { QuestionDialog } from "./question-dialog.ts";
import { buttonLabel, terminalPointer } from "./pointer-hover.ts";
import { PANEL_KEY } from "./terminal-marks.ts";

/**
 * While a question is open, what catches ctrl+h on the terminal's input: pi gives an extension's shortcut only the keys
 * its editor sees, and a question has the focus. It opens the side panel - the question waits under it - unless the
 * panel shows already: its own listener has ctrl+h then, to close it. A key's release and its repeats are left alone.
 */
export function peekKeyListener(panel: { open(): void; shown(): boolean }): (data: string) => { consume: true } | undefined {
  return (data) => {
    if (isKeyRelease(data) || isKeyRepeat(data) || !matchesKey(data, PANEL_KEY) || panel.shown()) return undefined;
    panel.open();
    return { consume: true };
  };
}

/**
 * The terminal's questions (`Frontend.ask`): turri's own dialog, a long brief scrolling above the question and the
 * options always showing (question-dialog.ts), in the chat that asks - waiting, while it is hidden, until it is shown
 * (chat-ui.ts). ctrl+c at it declines the chat's questions (`Chat.decline`); what asked goes on. The turn, and a skill
 * asking in it, is stopped by ctrl+c with no question open. Over without an answer - declined, its turn stopped - the
 * dialog closes.
 */
export function terminalAsk(chatUi: (chat: string | undefined) => ExtensionUIContext | undefined, decline: (chat: string | undefined) => void): NonNullable<Frontend["ask"]> {
  return async (question, { chat, signal }) => {
    const ui = chatUi(chat);
    if (ui === undefined || signal.aborted) return undefined;
    ui.setWorkingMessage("waiting for your answer");
    const unhook = hookPeekKey(ui);
    try {
      return await ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
        const shown: QuestionDialog = new QuestionDialog({
          question: question.title,
          ...(question.context !== undefined ? { context: question.context } : {}),
          ...(question.kind === "select" ? { options: question.options } : {}),
          ...(question.kind === "select" && question.at !== undefined ? { selected: question.at } : {}),
          rows: () => paddedRows(tui.terminal.rows),
          style: { accent: (text) => theme.fg("accent", text), muted: (text) => theme.fg("muted", text), bold: (text) => theme.bold(text) },
          done: (answer) => {
            if (questionShown === shown) questionShown = undefined;
            done(answer);
          },
          requestRender: () => tui.requestRender(),
          interrupt: () => decline(chat),
        });
        // Over while it waited to be shown, or as it opens: closed at once.
        if (signal.aborted) queueMicrotask(() => shown.dismiss());
        else signal.addEventListener("abort", () => shown.dismiss(), { once: true });
        questionShown = shown;
        return shown;
      });
    } finally {
      unhook();
      ui.setWorkingMessage();
    }
  };
}

/** The side panel, as a question open in the chat reaches it: set once the extension has its panel. */
let questionPeek:
  | {
      open(ui: ExtensionUIContext): void;
      /** It shows now: its own listener has the keys, ctrl+h among them. */
      shown(): boolean;
    }
  | undefined;

/**
 * The question open in the chat now, if any. The side panel gives the keys back to it: pi would give them to what had the
 * focus when the panel first opened, and a panel kept beside the chat outlives that question - the keys would go to a
 * dialog already answered, and nothing would take them.
 */
let questionShown: Component | undefined;

/** A widget with nothing to draw: below the editor, it takes no line. */
const PEEK_KEY_WIDGET = "turri-peek-key";

/**
 * While a question is open, ctrl+h opens the side panel over it - the question waits under it. pi gives an extension's
 * shortcut only the keys its editor sees, and a question has the focus: the key is caught on the terminal's input
 * instead. While the panel shows, its own listener has ctrl+h - to close it - and this lets it be.
 */
export function hookPeekKey(ui: ExtensionUIContext): () => void {
  if (questionPeek === undefined) return () => {};
  const peek = questionPeek;
  ui.setWidget(
    PEEK_KEY_WIDGET,
    (tui) => {
      const unlisten = tui.addInputListener(peekKeyListener({ open: () => peek.open(ui), shown: () => peek.shown() }));
      return { render: () => [], invalidate() {}, dispose: unlisten };
    },
    { placement: "belowEditor" },
  );
  return () => ui.setWidget(PEEK_KEY_WIDGET, undefined);
}

export function registerPanelKey(pi: ExtensionAPI, sidePanel: SidePanelHost): void {
  const openPanel = sidePanel.open;
  pi.on("session_start", () => {
    sidePanel.say = (text) => pi.sendUserMessage(text, { deliverAs: "followUp" });
  });
  // A question open in the chat on the screen peeks at this chat's panel.
  const peek = {
    open: (ui: ExtensionUIContext) => openPanel(ui),
    shown: () => sidePanel.shown(),
  };
  questionPeek = peek;
  pi.on("session_start", () => {
    questionPeek = peek;
  });

  pi.registerShortcut(PANEL_KEY, {
    description: "Peek at regen and the pulses - a question waiting in the chat waits for you - or go back to it",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      openPanel(ctx.ui);
    },
  });
}

/** /notifications: the side panel on finished pulses and the sentinel's notices, beside the chat. */
export function registerNotifications(pi: ExtensionAPI, sidePanel: SidePanelHost): void {
  pi.registerCommand("notifications", {
    description: "Open the side panel on finished pulses and sentinel notices",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) sidePanel.open(ctx.ui, "notifications", "beside");
    },
  });
}

const WATCH_REDRAW_MS = 500;
/** The session's side panel: opened from any chat, and the same panel whichever chat is shown. */
export interface SidePanelHost {
  open(ui: ExtensionUIContext, view?: SpecMapState["view"], placement?: "beside"): void;
  /** Opened on a pulse, in the pulse list. */
  openOn(ui: ExtensionUIContext, pulse: string): void;
  /** Open, or closed when it is open: the tabs' toggle. */
  toggle(ui: ExtensionUIContext): void;
  /** Drawing a regeneration under way: the tabs' spinner. */
  busy(): boolean;
  visible(): boolean;
  close(): void;
  /** It shows now, with the keys. */
  shown(): boolean;
  /** What it says to the chat - a module that needs the person: the chat shown says it. */
  say?: (text: string) => void;
}

/** What the side panel reads of the session: its pulses, the spec map, earlier sessions' pulses and the inbox. */
export interface PanelSource extends NotificationsSource {
  /** The pulses planned, then every pulse this session ran. */
  jobs(): Job[];
  /** The spec map, its items marked, as the session last sent it. */
  map(): MarkedPage[];
  /** The spec map's files read again: they may have changed while the panel was closed. */
  refreshMap(): void;
  /** Earlier sessions' pulses here, newest runs first, and how many more there are. */
  history(): { jobs: Job[]; more: number };
  /** Planning or regenerating now. */
  busy(): boolean;
}

export function makePanel(session: PanelSource, needsLooking: () => string | undefined): SidePanelHost {
  const self: SidePanelHost = {
    open: (ui, view, placement) => openPanel(ui, view, placement),
    openOn: (ui, pulse) => {
      if (selectJob(session.jobs(), jobsTree, pulse)) mapState.view = "pulses";
      openPanel(ui);
    },
    toggle: (ui) => (self.visible() ? self.close() : openPanel(ui)),
    busy: () => session.busy(),
    visible: () => panel !== undefined && panel.handle?.isHidden() !== true,
    close: () => panel?.close(),
    shown: () => panel !== undefined && panel.keys,
  };
  let panel: { handle?: OverlayHandle; view: ReturnType<typeof createSidePanel>; close(): void; keepChatFocus(): void; layOut(): void; keys: boolean } | undefined;
  // Beside the chat or over it: as the person last left it, for the conversation.
  let panelDocked = false;
  // The terminal the panel is drawn on, for its width: set as it opens.
  let panelTerminal: { columns: number } | undefined;
  /** The columns the panel takes beside the chat - 0 over the whole screen, or when the terminal is too narrow to share. */
  const panelBeside = (): number => (panelDocked && panelTerminal !== undefined ? dockedWidth(paddedColumns(panelTerminal.columns)) : 0);
  // What is open in the pulse list and the map, and where their cursors are: the conversation's, as left each time it opens.
  const jobsTree = createJobsTreeState();
  // Earlier sessions' pulses, from the ledger: read as the panel first shows them - they do not change while this one runs.
  let earlier: Job[] | undefined;
  const earlierJobs = (): Job[] => {
    if (earlier !== undefined) return earlier;
    try {
      const found = session.history();
      earlier = found.jobs;
      jobsTree.earlierMore = found.more;
    } catch {
      earlier = [];
    }
    return earlier;
  };
  const mapState = createSpecMapState();

  /** Open the side panel - on the view named, or as it was left. */
  const openPanel = (ui: ExtensionUIContext, view?: SpecMapState["view"], placement?: "beside") => {
    const id = needsLooking();
    if (view !== undefined) mapState.view = view;
    // A pulse that failed or stopped since the panel was last opened: opened as it is, it is on that pulse - what went
    // wrong is what the person opens it to see.
    else if (id !== undefined && selectJob(session.jobs(), jobsTree, id)) mapState.view = "pulses";

    if (placement === "beside") panelDocked = true;
    if (panel !== undefined) {
      panel.layOut();
      panel.keepChatFocus();
      panel.handle?.setHidden(false);
      panel.keys = true;
      panel.handle?.focus();
      return;
    }
    // Not awaited: the panel lives on while the jobs it shows run.
    void ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        // What the chat shows when the panel takes the keys - its editor, or a pi dialog - for when it gives them back.
        const focusedNow = () => (tui as unknown as { getFocusedComponent?(): Component | null }).getFocusedComponent?.() ?? null;
        let chatFocus = focusedNow();
        const keepChatFocus = () => {
          const focused = focusedNow();
          if (focused !== null && focused !== component && !(focused instanceof QuestionDialog)) chatFocus = focused;
        };
        // The keys back to the chat: to the question open there now, else to what it showed - never to a question answered
        // while the panel was open.
        const giveBack = () => entry.handle?.unfocus({ target: questionShown ?? chatFocus });
        const close = () => {
          giveBack();
          done(undefined);
        };
        panelTerminal = tui.terminal;
        let component: { render(width: number): readonly string[]; dispose?(): void } | undefined;
        // Beside the chat: the chat drawn narrower, on the left, and a click on either side giving it the keys - undone
        // when the panel goes over the screen, or closes.
        let undock: (() => void) | undefined;
        const layOut = () => {
          if (panelDocked && undock === undefined) {
            const widen = narrowChat(tui, panelBeside);
            const unwatch = clickToFocus(
              tui,
              () => tui.terminal.columns - SCREEN_PADDING.right - panelBeside(),
              (side) => {
                if (panelBeside() === 0) return;
                if (side === "chat") toChat();
                else toPanel();
              },
            );
            // The side without the keys in the shade: the chat while the panel has them.
            const unshade = shadeChat(tui, () => panelBeside() > 0 && entry.keys);
            undock = () => {
              unshade();
              unwatch();
              widen();
            };
          } else if (!panelDocked && undock !== undefined) {
            undock();
            undock = undefined;
          }
        };
        // Beside the chat, back to it: the chat has the keys, the panel stays.
        const toChat = () => {
          entry.keys = false;
          giveBack();
          tui.requestRender();
        };
        const toPanel = () => {
          keepChatFocus();
          entry.keys = true;
          entry.handle?.focus();
          tui.requestRender();
        };
        const back = () => (panelBeside() > 0 ? toChat() : close());
        // Opened, it reads the files again at once: they may have changed while it was closed.
        session.refreshMap();
        const view = createSidePanel({
          notifications: notificationView(session, {
            accent: (text) => theme.fg("accent", text), muted: (text) => theme.fg("muted", text), bold: (text) => theme.bold(text),
            warning: (text) => theme.fg("warning", text), button: (text, selected) => buttonLabel(theme, text, selected, false, "panel"),
          }, back),
          pointer: terminalPointer(tui.terminal),
          tabLabel: (text, active, hovered, role) => buttonLabel(theme, text, active, hovered, role),
          jobs: () => session.jobs(),
          earlier: earlierJobs,
          tree: jobsTree,
          map: () => session.map(),
          mapState,
          rows: () => paddedRows(tui.terminal.rows),
          key: PANEL_KEY,
          dock: {
            docked: () => panelBeside() > 0,
            toggle: () => {
              panelDocked = panelBeside() === 0;
              layOut();
              tui.requestRender();
            },
          },
          style: {
            heading: (text) => theme.bold(theme.fg("accent", text)),
            muted: (text) => theme.fg("muted", text),
            accent: (text) => theme.fg("accent", text),
            error: (text) => theme.fg("error", text),
            success: (text) => theme.fg("success", text),
            warning: (text) => theme.fg("warning", text),
            added: (text) => theme.fg("toolDiffAdded", text),
            removed: (text) => theme.fg("toolDiffRemoved", text),
            // A spec diff's ***plain highlighted by turri's grammar, and its added and removed lines filled.
            diff: plainPaint(theme),
            // What conformance tests show does what its spec says: neon.
            conforms: brandNeon(theme),
          },
          back,
          close,
          // A module that needs the person: the chat takes it up with them, in their words - what went wrong, and what now.
          discuss: (page) => {
            back();
            const why = page.codebase?.stuck?.why;
            self.say?.(
              `regen says ${page.module} needs me: ${page.status}. What went wrong, and what do we do about it?${why !== undefined ? `\n\n(turri's reason: ${why})` : ""}`,
            );
          },
          // Something took the keys' focus while the panel showed - a question in the chat - and waits there.
          waiting: () => {
            if (!entry.keys) return false;
            const focused = (tui as unknown as { getFocusedComponent?(): unknown }).getFocusedComponent?.() ?? null;
            return focused !== null && focused !== component;
          },
        });
        const entry: NonNullable<typeof panel> = { view, close, keepChatFocus, layOut, keys: true };
        panel = entry;
        layOut();
        // Every key goes to the panel while it shows, whatever has the focus: a question the chat model asks in the
        // background takes the focus, but no key reaches it - an enter never answers it unseen. It waits in the chat
        // until the panel closes, and has the keys then. Mouse events are the screen's, before this sees them.
        // Only while it is on the screen: up in the TUI's overlays and not hidden. An overlay taken off without the panel
        // being disposed - another one closed over it - leaves no panel to take keys for: it lets them go, and goes.
        const shown = (): boolean | "gone" => {
          const overlays = (tui as unknown as { overlayStack?: Array<{ component: unknown }> }).overlayStack;
          if (entry.handle === undefined || component === undefined) return false;
          if (overlays !== undefined && !overlays.some((overlay) => overlay.component === component)) return "gone";
          return entry.handle.isHidden() !== true;
        };
        const unlisten = tui.addInputListener((data) => {
          const state = shown();
          if (state === "gone") {
            component?.dispose?.();
            return undefined;
          }
          if (!state) return undefined;
          // Beside the chat, with the chat's keys: they are the chat's - PANEL_KEY among them, for the shortcut that gives
          // them to the panel. A click on the panel gives it the focus, and the keys with it.
          if (!entry.keys && entry.handle?.isFocused() !== true) return undefined;
          entry.keys = true;
          // A terminal on the Kitty keyboard protocol reports a key's release, and listeners are given it: the release of
          // the ctrl+h that opened the panel would close it again at once, and every arrow would move twice. Only
          // presses count - and ctrl+h held down, repeating, does not open and close it over and over.
          if (isKeyRelease(data) || (isKeyRepeat(data) && matchesKey(data, PANEL_KEY))) return { consume: true };
          // PANEL_KEY goes back: beside the chat, to the chat, the panel staying - the switch between the sides, as it is
          // from the chat to the panel - and over the screen, closing it. ctrl+c closes it either way: whatever else goes
          // wrong, a key always leads back to the chat.
          if (matchesKey(data, "ctrl+c")) close();
          else if (matchesKey(data, PANEL_KEY)) back();
          else {
            try {
              view.handleInput(data);
            } catch {
              /* a key the panel fails on is dropped, never the panel's hold on the keys */
            }
          }
          tui.requestRender();
          return { consume: true };
        });
        // Jobs keep writing; redraw so the panel follows them while it shows.
        const timer = setInterval(() => {
          if (entry.handle?.isHidden() !== true) tui.requestRender();
        }, WATCH_REDRAW_MS);
        timer.unref?.();
        component = {
          // Beside the chat, a rule down its left edge between them - and the panel in the shade while the chat has the keys.
          render: (width: number) => {
            if (panelBeside() === 0) return view.render(width);
            const lines = view.render(width - 2).map((line) => `${theme.fg("borderMuted", "│")} ${line}`);
            return entry.keys ? lines : lines.map(shade);
          },
          // Reached only if the listener above is gone: the same, so the panel never passes a key on.
          handleInput: (data: string) => {
            if (isKeyRepeat(data) && matchesKey(data, PANEL_KEY)) return;
            if (matchesKey(data, "ctrl+c")) close();
            else if (matchesKey(data, PANEL_KEY)) back();
            else view.handleInput(data);
            tui.requestRender();
          },
          handleMouse: (event: Parameters<NonNullable<ReturnType<typeof createSidePanel>["handleMouse"]>>[0]) =>
            view.handleMouse(panelBeside() > 0 ? { ...event, x: event.x - 2, width: event.width - 2 } : event),
          invalidate: () => view.invalidate(),
          dispose: () => {
            unlisten();
            clearInterval(timer);
            undock?.();
            if (panel === entry) panel = undefined;
          },
        } as { render(width: number): readonly string[]; dispose?(): void };
        return component as never;
      },
      {
        overlay: true,
        // The whole screen, or the columns on the right beside the chat - read at each frame, so it follows the terminal -
        // inside the screen's padding.
        overlayOptions: {
          get width() {
            return panelBeside() > 0 ? panelBeside() : "100%";
          },
          maxHeight: "100%",
          anchor: "top-right",
          margin: { ...SCREEN_PADDING },
        },
        onHandle: (handle) => {
          if (panel !== undefined) panel.handle = handle;
        },
      },
    );
  };

  return self;
}
