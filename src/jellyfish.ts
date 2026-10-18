import { sgr } from "./regenerate/plain-palette.ts";

/**
 * The jellyfish turri is named after, in pixels: a pink bell, an orange gut, neon tentacles coming apart into code at
 * their tips - the design system's colours, swimming a stroke a loop. Drawn at two sizes from one design: the banner's
 * pictures are rendered from the large one (scripts/jellyfish-frames.mjs writes assets/jellyfish/), and where a terminal
 * shows no images the small one is drawn here in half blocks, two pixels a cell - drawn at its size, not shrunk, so no
 * pixel of it is lost.
 */

/** What a pixel is: the bell, its glint and shine, the gut, the underside, a tentacle, an oral arm, a tip fading. */
type Pixel = "p" | "h" | "w" | "o" | "e" | "N" | "n" | "l" | "g";

/** The pixels' colours on a dark background and a light one - the tentacles darker on light, where neon does not show. */
export const JELLYFISH_COLOURS: Record<"dark" | "light", Record<Pixel, string>> = {
  dark: { p: "#ff5c8d", h: "#ff7fa6", w: "#f4f7f9", o: "#ff7a3d", e: "#732553", N: "#8eebee", n: "#5ce1e6", l: "#85a3b2", g: "#3e5a6b" },
  light: { p: "#ff5c8d", h: "#ff7fa6", w: "#f4f7f9", o: "#ff7a3d", e: "#732553", N: "#3e5a6b", n: "#1e3442", l: "#85a3b2", g: "#85a3b2" },
};

/**
 * How shut the bell is, frame by frame - a quarter second each: shut quickly, held a moment, opened slowly, at rest
 * until the next stroke.
 */
const SHUT = [0.1, 0.55, 0.9, 1, 0.85, 0.7, 0.56, 0.44, 0.33, 0.23, 0.14, 0.06];

/** One size of the jellyfish. */
interface Design {
  width: number;
  height: number;
  /** The bell a row at a time, open and shut: how wide each row is, even so it stays centred. */
  open: number[];
  shut: number[];
  /** The glint, in pixels from the bell's middle and top, and its pixel of shine. */
  glint: Array<[number, number]>;
  shine: [number, number];
  /** The gut, the moon jelly's four lobes, and the row it starts on. */
  gut: string[];
  gutRow: number;
  /** The strands: where under the bell each hangs (in pixels from the middle, open), how long, how far it sways. */
  strands: Array<{ at: number; length: number; sway: number; ink: Pixel }>;
}

const LARGE: Design = {
  width: 24,
  height: 26,
  open: [6, 12, 16, 18, 20, 22, 22, 24, 24],
  shut: [6, 10, 14, 16, 18, 18, 18, 20, 20],
  glint: [[-3, 2], [-4, 2], [-5, 3], [-6, 4], [-6, 5]],
  shine: [-2, 2],
  gut: [".oo..oo.", "oooooooo", "oooooooo", ".oo..oo."],
  gutRow: 4,
  strands: [
    { at: -8, length: 10, sway: 1.1, ink: "N" },
    { at: -4.5, length: 13, sway: 1.3, ink: "N" },
    { at: -1, length: 14, sway: 0.8, ink: "n" },
    { at: 2, length: 13, sway: 0.8, ink: "n" },
    { at: 5.5, length: 13, sway: 1.3, ink: "N" },
    { at: 9, length: 10, sway: 1.1, ink: "N" },
  ],
};

const SMALL: Design = {
  width: 18,
  height: 20,
  open: [4, 10, 12, 14, 16, 18, 18],
  shut: [4, 8, 10, 12, 14, 14, 14],
  glint: [[-2, 1], [-3, 2], [-4, 3]],
  shine: [-1, 1],
  gut: ["oo..oo", "oooooo", "oo..oo"],
  gutRow: 3,
  strands: [
    { at: -6, length: 8, sway: 0.9, ink: "N" },
    { at: -3, length: 10, sway: 1, ink: "N" },
    { at: -0.5, length: 11, sway: 0.7, ink: "n" },
    { at: 1.5, length: 10, sway: 0.7, ink: "n" },
    { at: 4, length: 10, sway: 1, ink: "N" },
    { at: 7, length: 8, sway: 0.9, ink: "N" },
  ],
};

/** One frame of a design: its height in rows of its width in pixels, "." where there is none. */
function frame(design: Design, t: number): string[] {
  const grid: string[][] = Array.from({ length: design.height }, () => Array<string>(design.width).fill("."));
  const centre = design.width / 2;
  const set = (y: number, x: number, pixel: Pixel, over = true) => {
    if (y < 0 || y >= design.height || x < 0 || x >= design.width) return;
    if (over || grid[y]![x] === ".") grid[y]![x] = pixel;
  };
  const shut = SHUT[t % SHUT.length]!;
  // Shut, it has risen a pixel.
  const top = shut > 0.6 ? 0 : 1;
  const widths = design.open.map((open, row) => 2 * Math.round((open - (open - design.shut[row]!) * shut) / 2));
  widths.forEach((width, row) => {
    for (let x = centre - width / 2; x < centre + width / 2; x++) set(top + row, x, "p");
  });
  const rimWidth = widths.at(-1)!;
  const rim = top + widths.length;
  // The underside along the bottom row, the rim scalloped under it.
  for (let x = centre - rimWidth / 2 + 2; x < centre + rimWidth / 2 - 2; x++) set(rim - 1, x, "e");
  for (let x = centre - rimWidth / 2; x < centre + rimWidth / 2; x += 2) set(rim, x + 1, "p");
  // A glint up on the left, curving with the dome, and a pixel of shine.
  for (const [dx, dy] of design.glint) set(top + dy, centre + dx, "h");
  set(top + design.shine[1], centre + design.shine[0], "w");
  const gutLeft = centre - Math.floor(design.gut[0]!.length / 2);
  design.gut.forEach((line, dy) => [...line].forEach((pixel, dx) => pixel === "o" && set(top + design.gutRow + dy, gutLeft + dx, "o")));
  // The tentacles: rooted under the bell, drawn in as it shuts, swaying - the further down, the later.
  const phase = (2 * Math.PI * t) / SHUT.length;
  design.strands.forEach((strand, i) => {
    const root = centre - 0.5 + strand.at * (rimWidth / design.open.at(-1)!);
    for (let y = 0; y < strand.length; y++) {
      const x = Math.round(root + strand.sway * Math.sin(phase - y * 0.55 + i * 0.8) * Math.min(1, y / 3));
      const left = strand.length - y;
      // The tips come apart, every other pixel, fading - into code.
      if (left <= 3 && y % 2 === 1) continue;
      set(rim + 1 + y, x, left > 5 ? strand.ink : left > 2 ? "l" : "g", false);
      // The oral arms are frilled.
      if (strand.ink === "n" && left > 5 && (y + t) % 3 === 0) set(rim + 1 + y, x + (strand.at < 0 ? -1 : 1), "n", false);
    }
  });
  return grid.map((row) => row.join(""));
}

export const JELLYFISH_WIDTH = LARGE.width;
export const JELLYFISH_HEIGHT = LARGE.height;

/** The large jellyfish's frames, a stroke: what the pictures are rendered from. */
export const JELLYFISH_FRAMES: string[][] = SHUT.map((_, t) => frame(LARGE, t));

/** The small jellyfish's frames, a stroke: what a terminal without images draws, in half blocks. */
export const JELLYFISH_TEXT_FRAMES: string[][] = SHUT.map((_, t) => frame(SMALL, t));

/** How long each frame shows. */
export const JELLYFISH_FRAME_MS = 250;

/**
 * A frame drawn in half blocks for a terminal that shows no images: two pixels a cell, the upper one the text's colour
 * and the lower one the background's, in as many colours as the terminal has: a column a pixel, a row every two.
 */
export function halfBlocks(pixels: string[], appearance: "dark" | "light", truecolor: boolean): string[] {
  const colours = JELLYFISH_COLOURS[appearance];
  const colour = (pixel: string | undefined) => (pixel === undefined || pixel === "." ? undefined : colours[pixel as Pixel]);
  const rows: string[] = [];
  for (let y = 0; y < pixels.length; y += 2) {
    let row = "";
    for (let x = 0; x < (pixels[0]?.length ?? 0); x++) {
      const upper = colour(pixels[y]?.[x]);
      const lower = colour(pixels[y + 1]?.[x]);
      if (upper === undefined && lower === undefined) row += " ";
      else if (upper === undefined) row += `\x1b[${sgr(lower!, false, truecolor)}m▄\x1b[39m`;
      else if (lower === undefined) row += `\x1b[${sgr(upper, false, truecolor)}m▀\x1b[39m`;
      else row += `\x1b[${sgr(upper, false, truecolor)};${sgr(lower, true, truecolor)}m▀\x1b[39;49m`;
    }
    rows.push(row);
  }
  return rows;
}
