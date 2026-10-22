import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/**
 * What a chat draws on, in a terminal of several chats: pi's screen while the chat is shown, and a stand-in while it is
 * not. pi has one screen; a hidden chat goes on working - its turns, its tools, a pulse it hears of - and what it
 * would draw must neither land on the chat shown nor be lost:
 *
 * - its questions - a dialog, a pick, a confirm - wait, and are asked once it is shown, one after another;
 * - what it says in passing - a notice - is said when it is shown;
 * - what it keeps on the screen - its widgets, statuses, the working line - is kept, and put back each time it is
 *   shown: pi clears an extension's widgets as it shows another session;
 * - what is typed in its editor and not sent stays its own.
 *
 * Everything else - the theme, how tools are drawn - is the screen's, read where it is.
 */
export interface ChatUi {
  /** What the chat's extension is given as its ui, shown or not. */
  readonly ui: ExtensionUIContext;
  readonly shown: boolean;
  /** Shown on `screen`: what it keeps put back, its draft in the editor, what it said told, its questions asked. */
  show(screen: ExtensionUIContext): void;
  /** Another chat is shown: its draft kept, what it draws from now on held back. */
  hide(): void;
  /** The questions waiting for it to be shown. */
  waiting(): number;
  /** The chat is closed: every question waiting is answered with nothing. */
  close(): void;
}

type Dialog = "select" | "confirm" | "input" | "editor" | "custom";

/** Notices kept for a hidden chat: the most recent. */
const NOTICES_KEPT = 10;

interface Waiting {
  ask: (screen: ExtensionUIContext) => Promise<unknown>;
  resolve: (answer: unknown) => void;
  reject: (error: unknown) => void;
  /** What it answers when the chat closes unasked. */
  none: unknown;
}

export function createChatUi(options: {
  /** The screen to read the theme and the like from before the chat was ever shown. */
  screen: () => ExtensionUIContext | undefined;
  /** Its questions waiting changed, or it was shown or hidden. */
  onChange?: () => void;
}): ChatUi {
  let screen: ExtensionUIContext | undefined;
  let lastScreen: ExtensionUIContext | undefined;
  const waiting: Waiting[] = [];
  let asking = false;
  let notices: Array<[string, "info" | "warning" | "error" | undefined]> = [];
  let draft = "";

  // What the chat keeps on the screen, to put back each time it is shown.
  const widgets = new Map<string, unknown[]>();
  const statuses = new Map<string, string>();
  const kept = new Map<string, unknown[]>();
  const inputHandlers = new Map<Parameters<ExtensionUIContext["onTerminalInput"]>[0], (() => void) | undefined>();
  const providers: unknown[] = [];

  const any = () => screen ?? lastScreen ?? options.screen();
  const call = (name: string, args: unknown[]) => (screen as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!(...args);

  /** Its questions, asked one after another while it is shown. */
  const askWaiting = async () => {
    if (asking) return;
    asking = true;
    try {
      while (screen !== undefined && waiting.length > 0) {
        const next = waiting.shift()!;
        options.onChange?.();
        try {
          next.resolve(await next.ask(screen));
        } catch (error) {
          next.reject(error);
        }
      }
    } finally {
      asking = false;
    }
  };

  const dialog = (name: Dialog, none: unknown) =>
    (...args: unknown[]) => {
      if (screen !== undefined && waiting.length === 0) return call(name, args);
      return new Promise((resolve, reject) => {
        waiting.push({ ask: (shown) => (shown as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name]!(...args), resolve, reject, none });
        options.onChange?.();
        void askWaiting();
      });
    };

  // What it keeps on the screen: written down, and drawn when it is shown.
  const keep = (name: string) =>
    (...args: unknown[]) => {
      kept.set(name, args);
      if (screen !== undefined) call(name, args);
    };

  const overrides: Partial<Record<keyof ExtensionUIContext, unknown>> = {
    select: dialog("select", undefined),
    confirm: dialog("confirm", false),
    input: dialog("input", undefined),
    editor: dialog("editor", undefined),
    custom: dialog("custom", undefined),
    notify: (message: string, type?: "info" | "warning" | "error") => {
      if (screen !== undefined) screen.notify(message, type);
      else notices = [...notices, [message, type] as [string, typeof type]].slice(-NOTICES_KEPT);
    },
    setWidget: (key: string, ...rest: unknown[]) => {
      if (rest[0] === undefined) widgets.delete(key);
      else widgets.set(key, [key, ...rest]);
      if (screen !== undefined) call("setWidget", [key, ...rest]);
    },
    setStatus: (key: string, text: string | undefined) => {
      if (text === undefined) statuses.delete(key);
      else statuses.set(key, text);
      if (screen !== undefined) screen.setStatus(key, text);
    },
    setWorkingMessage: keep("setWorkingMessage"),
    setWorkingVisible: keep("setWorkingVisible"),
    setWorkingIndicator: keep("setWorkingIndicator"),
    setHiddenThinkingLabel: keep("setHiddenThinkingLabel"),
    setFooter: keep("setFooter"),
    setHeader: keep("setHeader"),
    setTitle: keep("setTitle"),
    setEditorComponent: keep("setEditorComponent"),
    onTerminalInput: (handler: Parameters<ExtensionUIContext["onTerminalInput"]>[0]) => {
      inputHandlers.set(handler, screen?.onTerminalInput(handler));
      return () => {
        inputHandlers.get(handler)?.();
        inputHandlers.delete(handler);
      };
    },
    addAutocompleteProvider: (factory: unknown) => {
      providers.push(factory);
      if (screen !== undefined) call("addAutocompleteProvider", [factory]);
    },
    getEditorText: () => (screen !== undefined ? screen.getEditorText() : draft),
    setEditorText: (text: string) => {
      if (screen !== undefined) screen.setEditorText(text);
      else draft = text;
    },
    pasteToEditor: (text: string) => {
      if (screen !== undefined) screen.pasteToEditor(text);
      else draft += text;
    },
  };

  // What the screen has besides, forwarded to the screen as it is when called: one function a name, kept.
  const forwarders = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  const read = (key: PropertyKey): unknown => {
    if (typeof key === "string" && key in overrides) return overrides[key as keyof ExtensionUIContext];
    const target = any();
    if (target === undefined) return undefined;
    const value = Reflect.get(target, key);
    if (typeof value !== "function") return value;
    let forward = forwarders.get(key);
    if (forward === undefined) {
      forward = (...args: unknown[]) => (Reflect.get(any()!, key) as (...args: unknown[]) => unknown).apply(any(), args);
      forwarders.set(key, forward);
    }
    return forward;
  };
  const keys = (): PropertyKey[] => [...new Set<PropertyKey>([...Object.keys(overrides), ...(any() !== undefined ? Reflect.ownKeys(any()!) : [])])];
  // pi copies the ui it is given - `{ ...ui }` - so every name is the stand-in's own, not only read through it.
  const ui = new Proxy({} as ExtensionUIContext, {
    get: (_target, key) => read(key),
    has: (_target, key) => keys().includes(key),
    ownKeys: () => keys().filter((key): key is string | symbol => typeof key !== "number"),
    getOwnPropertyDescriptor: (_target, key) => (keys().includes(key) ? { value: read(key), enumerable: true, configurable: true, writable: false } : undefined),
  });

  return {
    ui,
    get shown() {
      return screen !== undefined;
    },
    show(next) {
      screen = next;
      lastScreen = next;
      for (const args of widgets.values()) call("setWidget", args);
      for (const [key, text] of statuses) next.setStatus(key, text);
      for (const [name, args] of kept) call(name, args);
      for (const handler of inputHandlers.keys()) inputHandlers.set(handler, next.onTerminalInput(handler));
      for (const factory of providers) call("addAutocompleteProvider", [factory]);
      if (draft !== "") next.setEditorText(draft);
      draft = "";
      for (const [message, type] of notices) next.notify(message, type);
      notices = [];
      options.onChange?.();
      void askWaiting();
    },
    hide() {
      if (screen === undefined) return;
      try {
        draft = screen.getEditorText();
        screen.setEditorText("");
      } catch {
        draft = "";
      }
      // pi takes them off the screen as it shows another chat; they are put on again when this one is shown.
      for (const handler of inputHandlers.keys()) inputHandlers.set(handler, undefined);
      screen = undefined;
      options.onChange?.();
    },
    waiting: () => waiting.length,
    close() {
      for (const next of waiting.splice(0)) next.resolve(next.none);
      screen = undefined;
    },
  };
}

