import { type Component, HStack, Spacer, VStack } from "@earendil-works/pi-tui";

/**
 * Room around the whole of turri's screen: a row above and below, two columns either side - a cell is about twice as
 * tall as it is wide.
 *
 * pi draws its screen one of two ways, and each is padded as it is drawn: full screen (pi's default), a layout - its
 * root put in the middle of blank rows and columns; the regular screen, the lines its render gives - asked for in fewer
 * columns, indented, with blank lines above and below. Overlays are laid over the whole terminal, so one that should
 * keep to the padding is given it as its margin.
 */
export const SCREEN_PADDING = { top: 1, right: 2, bottom: 1, left: 2 } as const;

/** The columns inside the padding. */
export function paddedColumns(columns: number): number {
  return Math.max(1, columns - SCREEN_PADDING.left - SCREEN_PADDING.right);
}

/** The rows inside the padding. */
export function paddedRows(rows: number): number {
  return Math.max(1, rows - SCREEN_PADDING.top - SCREEN_PADDING.bottom);
}

/** What of pi's screen the padding reaches: not among what pi-tui declares. */
interface Screen {
  layoutRoot?: Component;
  setLayoutRoot?(root: Component | undefined): void;
  render(width: number): string[];
  turriPadded?: true;
}

/** Each padded layout root, to what it pads. */
const content = new WeakMap<Component, Component>();

/** What a layout root pads - the root itself when it is not padded. */
export function unpadded(root: Component): Component {
  return content.get(root) ?? root;
}

/** A blank column as wide as the padding on its side: the row gives it what it measures. */
const blankColumns = (columns: number): Component => ({ render: () => [" ".repeat(columns)], invalidate() {} });

function padded(root: Component): Component {
  const row = new HStack([
    { component: blankColumns(SCREEN_PADDING.left), basis: SCREEN_PADDING.left },
    { component: root, basis: 0, grow: 1 },
    { component: blankColumns(SCREEN_PADDING.right), basis: SCREEN_PADDING.right },
  ]);
  const whole = new VStack([
    { component: new Spacer(SCREEN_PADDING.top), basis: SCREEN_PADDING.top },
    // As pi lays out its own transcript: the rows the padding leaves, whatever it measures.
    { component: row, basis: 0, grow: 1, minSize: 1 },
    { component: new Spacer(SCREEN_PADDING.bottom), basis: SCREEN_PADDING.bottom },
  ]);
  content.set(whole, root);
  return whole;
}

/**
 * pi's screen drawn inside the padding, from its next frame - and every layout root it is given after, so the chat
 * narrowed beside the docked panel (`narrowChat`) is padded too. Once a screen: pi starts a new one when it changes how
 * it draws, which is padded when it is passed in.
 */
export function padScreen(tui: object): void {
  const screen = tui as Screen;
  if (screen.turriPadded === true) return;
  if (typeof screen.setLayoutRoot === "function") {
    // Full screen before pi has given it its layout: padded at a later frame.
    if (screen.layoutRoot === undefined) return;
    screen.turriPadded = true;
    const set = screen.setLayoutRoot;
    screen.setLayoutRoot = function (this: Screen, root: Component | undefined) {
      set.call(this, root === undefined ? undefined : padded(unpadded(root)));
    };
    screen.setLayoutRoot(screen.layoutRoot);
    return;
  }
  screen.turriPadded = true;
  // Read from the prototype: the screen's own render, not one laid over it.
  const render = (Object.getPrototypeOf(tui) as Screen).render;
  const left = " ".repeat(SCREEN_PADDING.left);
  screen.render = function (this: Screen, width: number) {
    const lines = render.call(this, paddedColumns(width)).map((line) => `${left}${line}`);
    return [...new Array<string>(SCREEN_PADDING.top).fill(""), ...lines, ...new Array<string>(SCREEN_PADDING.bottom).fill("")];
  };
}
