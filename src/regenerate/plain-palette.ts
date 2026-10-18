import type { PlainRole } from "../plain/highlight.ts";
import type { DiffPaint } from "./diff-view.ts";

/**
 * The colours a spec diff is painted in: ***plain's own, and the diff's fills - turri's, not a theme's
 * slots. A theme's colours for code are made for code, and the turri themes paint every background their
 * surface colour, so a diff drawn with them has no fills and hardly any highlighting. So each piece of
 * ***plain gets a hue of its own, legible on the theme's surface, and an added or removed line a fill
 * that shows - a highlighter's, with the text on top.
 */

interface Ink {
  colour: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

interface Palette {
  roles: Record<PlainRole, Ink>;
  /** The +/- of an added and a removed line. */
  added: string;
  removed: string;
  /** The fill behind an added and a removed line. */
  addedFill: string;
  removedFill: string;
  muted: string;
}

/**
 * On a dark surface - turri-dark's abyss, #0a0f1a, pi's dark ones - in the design system's colours alone: a section's
 * header in pink, a concept in neon, text in quotes or backticks in siesta tan. Every colour at least 7:1 on abyss and 4.8:1 on the blue whale fill
 * of an added line; on the eggplant of a removed one, the design system's only fill of that warmth, its pinks and
 * grauzone drop to 3.7:1.
 */
const DARK: Palette = {
  roles: {
    section: { colour: "#ff7fa6", bold: true },
    concept: { colour: "#5ce1e6" },
    link: { colour: "#f4f7f9", underline: true },
    literal: { colour: "#e9d8c8" },
    keyword: { colour: "#f4f7f9", bold: true },
    module: { colour: "#f4f7f9" },
    comment: { colour: "#85a3b2", italic: true },
    bullet: { colour: "#85a3b2" },
  },
  added: "#5ce1e6",
  removed: "#ff7fa6",
  addedFill: "#1e3442",
  removedFill: "#732553",
  muted: "#85a3b2",
};

/**
 * On a light surface - turri-light's white, pi's light ones - in the design system's deep colours, the only ones it has
 * that read on white. Every colour at least 7:1 on white, and 5:1 on the neon hover and siesta tan fills.
 */
const LIGHT: Palette = {
  roles: {
    section: { colour: "#3e5a6b", bold: true },
    concept: { colour: "#732553" },
    link: { colour: "#1e3442", underline: true },
    literal: { colour: "#1e3442" },
    keyword: { colour: "#0a0f1a", bold: true },
    module: { colour: "#1e3442" },
    comment: { colour: "#3e5a6b", italic: true },
    bullet: { colour: "#3e5a6b" },
  },
  added: "#1e3442",
  removed: "#732553",
  addedFill: "#8eebee",
  removedFill: "#e9d8c8",
  muted: "#3e5a6b",
};

const rgb = (hex: string): [number, number, number] => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** A colour's SGR parameters: 24-bit, or the nearest of the 256 where the terminal has no more. */
function sgr(hex: string, background: boolean, truecolor: boolean): string {
  const [r, g, b] = rgb(hex);
  if (truecolor) return `${background ? 48 : 38};2;${r};${g};${b}`;
  const step = (value: number) => (value < 48 ? 0 : value < 115 ? 1 : Math.min(5, Math.floor((value - 35) / 40)));
  return `${background ? 48 : 38};5;${16 + 36 * step(r) + 6 * step(g) + step(b)}`;
}

const paintWith = (ink: Ink, text: string, truecolor: boolean): string => {
  const on = [sgr(ink.colour, false, truecolor), ...(ink.bold ? ["1"] : []), ...(ink.italic ? ["3"] : []), ...(ink.underline ? ["4"] : [])].join(";");
  const off = ["39", ...(ink.bold ? ["22"] : []), ...(ink.italic ? ["23"] : []), ...(ink.underline ? ["24"] : [])].join(";");
  return `\x1b[${on}m${text}\x1b[${off}m`;
};

/** A fill behind a whole row: set again after every reset inside it, so nothing in the row ends it early. */
const fillWith = (hex: string, text: string, truecolor: boolean): string => {
  const on = `\x1b[${sgr(hex, true, truecolor)}m`;
  return `${on}${text.replace(/\x1b\[(?:0|49)?m/g, (reset) => `${reset}${on}`)}\x1b[49m`;
};

/**
 * Neon, for what is shown to do what its spec says - regen's ◆: the design system's colour for what can be followed,
 * 12.2:1 on abyss. On a light surface, where neon is illegible (1.6:1 on white), blue whale, 12.9:1 on white.
 */
export const BRAND_NEON = { light: "#1e3442", dark: "#5ce1e6" };

/**
 * Pink, the one pink thing in a view - the banner's wordmark: 6.54:1 on abyss. On a light surface, where pink is
 * too pale (2.9:1 on white), eggplant, 9.9:1 on white.
 */
export const BRAND_PINK = { light: "#732553", dark: "#ff5c8d" };

const brandInk =
  (colours: { light: string; dark: string }) =>
  (theme: { appearance?: "dark" | "light"; getColorMode?(): string }): ((text: string) => string) => {
    const colour = theme.appearance === "light" ? colours.light : colours.dark;
    const truecolor = (theme.getColorMode?.() ?? "truecolor") === "truecolor";
    return (text) => paintWith({ colour, bold: true }, text, truecolor);
  };

/** Text in neon on a theme - blue whale on a light one - in as many colours as the terminal has. */
export const brandNeon = brandInk(BRAND_NEON);

/** Text in pink on a theme - eggplant on a light one - in as many colours as the terminal has. */
export const brandPink = brandInk(BRAND_PINK);

/** How a spec diff is painted on a theme: its palette by whether the theme is dark or light, in as many colours as the terminal has. */
export function plainPaint(theme: { appearance?: "dark" | "light"; getColorMode?(): string }): DiffPaint {
  const palette = theme.appearance === "light" ? LIGHT : DARK;
  const truecolor = (theme.getColorMode?.() ?? "truecolor") === "truecolor";
  return {
    syntax: (role, text) => paintWith(palette.roles[role], text, truecolor),
    added: (text) => paintWith({ colour: palette.added, bold: true }, text, truecolor),
    removed: (text) => paintWith({ colour: palette.removed, bold: true }, text, truecolor),
    addedBand: (text) => fillWith(palette.addedFill, text, truecolor),
    removedBand: (text) => fillWith(palette.removedFill, text, truecolor),
    muted: (text) => paintWith({ colour: palette.muted }, text, truecolor),
  };
}
