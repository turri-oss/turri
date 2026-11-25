import type { Theme } from "@earendil-works/pi-coding-agent";
import { colorToRgb, parseColor, type Color } from "@earendil-works/pi-tui";
import { BRAND_PINK } from "./regenerate/plain-palette.ts";

export type ButtonRole = "tab" | "new" | "close" | "panel" | "regenerating";
export type ButtonPaint = (text: string, active: boolean, hovered: boolean, role: ButtonRole) => string;

const abyss = parseColor("#0a0f1a");
const pink = parseColor(BRAND_PINK.dark);
const white = parseColor("#f4f7f9");
const linear = (byte: number) => byte <= 10 ? byte / 3294.6 : ((byte / 255 + 0.055) / 1.055) ** 2.4;

function luminance(color: Color): number {
  const { r, g, b } = colorToRgb(color);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

// The point at which white and abyss have equal contrast on a fill. Paint both sides explicitly: the
// terminal's own background can still be dark when the person picks the light theme (and vice versa).
const inkSwitch = Math.sqrt((luminance(abyss) + 0.05) * (luminance(white) + 0.05)) - 0.05;

/** The layout owns the padding, so the entire coloured surface is also the click target. */
export function buttonLabel(theme: Theme, text: string, active: boolean, hovered: boolean, role: ButtonRole): string {
  if (role === "regenerating") return theme.style(text, { bg: pink, fg: abyss, bold: true, underline: hovered });
  if (role === "new" || active || hovered) {
    const fill = theme.colors[role === "new" ? "success" : role === "close" && hovered ? "error" : "accent"];
    return theme.style(text, { bg: fill, fg: luminance(fill) > inkSwitch ? abyss : white, bold: true, underline: hovered });
  }
  return theme.style(text, { bg: "selectedBg", fg: role === "panel" ? "accent" : "text", bold: role === "panel" });
}

/** pi sends moves to the component under the pointer but has no leave event. Share one hover target across the
 * screen: if the next input is dispatched elsewhere the old highlight goes away. Redraw only on a change. */
export class PointerHover {
  target: string | undefined;

  dispatch<T>(dispatch: () => T, redraw: () => void): T {
    const before = this.target;
    this.target = undefined;
    try {
      return dispatch();
    } finally {
      if (before !== this.target) redraw();
    }
  }
}

const pointers = new WeakMap<object, PointerHover>();

export function terminalPointer(terminal: object): PointerHover {
  let pointer = pointers.get(terminal);
  if (pointer === undefined) {
    pointer = new PointerHover();
    pointers.set(terminal, pointer);
  }
  return pointer;
}
