import { sgr } from "./regenerate/plain-palette.ts";

/**
 * The jellyfish turri is named after, in pixels, regenerating: a polyp on the sea floor grows into the jellyfish, it
 * swims a while, then sinks back to the floor and the polyp grows again - the design system's hero and its lifecycle
 * (its pixel kit's `sprite("hero")` and `cycleFrames()`, ported here pixel for pixel). The banner's pictures are
 * rendered from these frames (scripts/jellyfish-frames.mjs writes assets/jellyfish/); where a terminal shows no
 * images the same frames are drawn here in half blocks, at a third of the size.
 */

/**
 * What a pixel is: the bell's pink, its midtone and shadow, its rim, its highlight, the gut, and a tentacle - whole,
 * half seen, or a polyp's crown, a little more than half.
 */
type Pixel = "p" | "m" | "i" | "e" | "h" | "o" | "N" | "n" | "c";

/** How much of a pixel shows. */
const ALPHA: Record<Pixel, number> = { p: 1, m: 1, i: 1, e: 1, h: 1, o: 1, N: 1, n: 0.5, c: 0.6 };

/** The pixels' colours on a dark background and a light one - the tentacles blue whale on light, where neon does not show. */
export const JELLYFISH_COLOURS: Record<"dark" | "light", Record<Pixel, string>> = {
  dark: { p: "#ff5c8d", m: "#a9479a", i: "#5b57d9", e: "#732553", h: "#ff7fa6", o: "#ff7a3d", N: "#5ce1e6", n: "#5ce1e6", c: "#5ce1e6" },
  light: { p: "#ff5c8d", m: "#a9479a", i: "#5b57d9", e: "#732553", h: "#ff7fa6", o: "#ff7a3d", N: "#1e3442", n: "#1e3442", c: "#1e3442" },
};

/** What a pixel short of whole is laid over, to draw it in half blocks: abyss, or white. */
const BACKGROUND = { dark: "#0a0f1a", light: "#f4f7f9" };

/** How much of a pixel shows, for a picture's alpha. */
export function jellyfishAlpha(pixel: string): number {
  return ALPHA[pixel as Pixel] ?? 0;
}

/** The lifecycle's grid, and the sea floor the polyp stands on. */
const WIDTH = 40;
const HEIGHT = 60;
const FLOOR = 59;

type Grid = Map<string, Pixel>;

const put = (grid: Grid, x: number, y: number, pixel: Pixel, bounded = true) => {
  x = Math.round(x);
  y = Math.round(y);
  if (bounded && (x < 0 || x > WIDTH - 1 || y < 0 || y > FLOOR)) return;
  grid.set(`${x},${y}`, pixel);
};

/** The bell's colour down its height: pink, through its midtone, to its shadow - dithered where one meets the next. */
const band = (t: number, x: number, y: number): Pixel =>
  t < 0.3 ? "p" : t < 0.42 ? ((x + y) % 2 ? "p" : "m") : t < 0.62 ? "m" : t < 0.74 ? ((x + y) % 2 ? "m" : "i") : "i";

/** An ellipse filled with the bell's colours, or its top half - a dome. */
function shape(grid: Grid, cx: number, cy: number, rx: number, ry: number, dome: boolean, bounded = true): void {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    if (dome && y > cy) continue;
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy > 1) continue;
      const t = dome ? (y - (cy - ry)) / ry : (y - (cy - ry)) / (2 * ry);
      put(grid, x, y, band(Math.max(0, Math.min(1, t)), x, y), bounded);
    }
  }
}

/** The bell's rim: every fourth pixel from the middle left out, the rest eggplant. */
function rim(grid: Grid, y: number): void {
  for (let x = 0; x < WIDTH + 1; x++) {
    const key = `${x},${y}`;
    if (!grid.has(key)) continue;
    if (Math.abs(x - 20) % 4 === 2) grid.delete(key);
    else grid.set(key, "e");
  }
}

/** The glint on the bell, up on the left. */
const GLINT: Array<[number, number]> = [[11, 6], [12, 5], [13, 5], [10, 7], [11, 7], [14, 4]];

/** Where each of the thirteen tentacles hangs, how long it is, and its place in the sway. */
const TENTACLES = [8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32].map((x, i) => ({ x, length: 16 + ((i * 7) % 12), i }));

/** The jellyfish at a scale `k`, its rim on row `cy`, its tentacles grown `grown` of the way. */
function medusa(grid: Grid, k: number, cy: number, grown: number): void {
  shape(grid, 20.5, cy, 14.5 * k, 16 * k, true);
  if (k > 0.45) rim(grid, Math.floor(cy));
  if (k > 0.8) {
    for (const [gx, gy] of GLINT) {
      const x = Math.round(20 + (gx - 20) * k);
      const y = Math.round(cy + (gy - 18) * k);
      if (grid.has(`${x},${y}`)) put(grid, x, y, "h");
    }
  }
  const gutY = cy - 7 * k;
  const halfWidth = Math.max(1.5, 2.5 * k);
  const halfHeight = Math.max(0.6, 1.5 * k);
  for (let y = Math.round(gutY - halfHeight); y < gutY + halfHeight; y++) for (let x = Math.round(20 - halfWidth); x < 20 + halfWidth; x++) put(grid, x, y, "o");
  if (k > 0.7) {
    for (let x = 19; x <= 21; x++) {
      put(grid, x, gutY - 2, "o");
      put(grid, x, gutY + 2, "o");
    }
  }
  for (const { x, length, i } of TENTACLES) {
    const shown = Math.round(length * Math.pow(grown, 1.2));
    const root = 20 + (x - 20) * k;
    for (let j = 0; j < shown; j++) put(grid, root + Math.round(Math.sin(j * 0.5 + i) * 1.6 * (j / shown)), cy + 1 + j, j % 2 ? "n" : "N");
  }
}

/** The polyp on the floor, grown `u` of the way: a stalk, a head with its gut, a crown of tentacles. */
function polyp(grid: Grid, u: number): void {
  shape(grid, 20, FLOOR, 3, 1.4, true);
  const height = Math.round(2 + 12 * u);
  const radius = 1.4 + 2.2 * u;
  for (let y = FLOOR - height; y <= FLOOR; y++) {
    for (let x = 19; x <= 20; x++) put(grid, x, y, band(0.45 + (0.55 * (y - (FLOOR - height))) / Math.max(1, height), x, y));
  }
  const head = FLOOR - height - radius + 1;
  shape(grid, 20, head, radius, radius, false);
  put(grid, 19, head, "o");
  put(grid, 20, head, "o");
  if (radius > 2.5) {
    put(grid, 19, head - 1, "o");
    put(grid, 20, head - 1, "o");
  }
  const crown: Array<[number, number]> = [[-4, -3], [3, -3], [-1, -5], [1, -5], [-5, -4], [4, -4], [-1, -6], [1, -6], [-6, -5], [5, -5]];
  const scale = radius / 3.6;
  for (let i = 0; i < Math.floor(u * crown.length); i++) {
    const [dx, dy] = crown[i]!;
    put(grid, 20 + dx * scale + (dx < 0 ? 0 : 0.5), head + dy * scale, i % 2 ? "c" : "N");
  }
}

const ease = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));

/** The lifecycle: twenty frames of the polyp growing into the jellyfish, nineteen of it sinking and the polyp growing back. */
function lifecycle(): Grid[] {
  const frames: Grid[] = [];
  for (let f = 0; f < 20; f++) {
    const grid: Grid = new Map();
    const g = f / 19;
    const p = ease((g - 0.2) / 0.65);
    if (1 - p > 0.06) polyp(grid, 1 - p);
    else if (p < 1) shape(grid, 20, FLOOR, 2.2, 1, true);
    const e = ease((g - 0.08) / 0.92);
    if (e > 0) medusa(grid, 0.18 + 0.82 * e, 40 - 22 * e, Math.pow(e, 1.5));
    frames.push(grid);
  }
  // It sinks to the floor first, and the polyp grows up from there.
  for (let f = 0; f <= 18; f++) {
    const grid: Grid = new Map();
    if (f <= 8) {
      const s = f / 8;
      medusa(grid, 1 - 0.72 * s, 18 + 40 * s, 1 - s);
    } else if (f <= 11) {
      const w = (f - 9) / 2;
      shape(grid, 20, FLOOR, 4.2 - 1.2 * w, 3.2 - 0.8 * w, true);
      put(grid, 19, FLOOR - 1, "o");
      put(grid, 20, FLOOR - 1, "o");
    } else polyp(grid, (f - 11) / 7);
    frames.push(grid);
  }
  return frames;
}

/**
 * The jellyfish swimming, grown: its bell still, its tentacles in one of two strokes - the second drawn a pixel higher,
 * as it bobs.
 */
function hero(stroke: 0 | 1): Grid {
  const grid: Grid = new Map();
  shape(grid, 20.5, 18, 14.5, 16, true, false);
  rim(grid, 18);
  for (const [x, y] of GLINT) if (grid.has(`${x},${y}`)) put(grid, x, y, "h", false);
  for (let y = 10; y <= 12; y++) for (let x = 18; x <= 22; x++) put(grid, x, y, "o", false);
  for (let x = 19; x <= 21; x++) {
    put(grid, x, 9, "o", false);
    put(grid, x, 13, "o", false);
  }
  for (const { x, length, i } of TENTACLES) {
    for (let k = 0; k < length; k++) {
      const sway = Math.round(Math.sin(k * 0.5 + i + (stroke === 1 ? 2.2 : 0)) * 1.6 * (k / length));
      put(grid, x + sway, 19 + k, k % 2 ? "n" : "N", false);
    }
  }
  if (stroke === 0) return grid;
  const raised: Grid = new Map();
  for (const [key, pixel] of grid) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    raised.set(`${x},${y - 1}`, pixel);
  }
  return raised;
}

/** Every frame on one grid, cut to what any of them draws on: rows of pixels, "." where there is none. */
function crop(grids: Grid[]): string[][] {
  const cells = grids.flatMap((grid) => [...grid.keys()].map((key) => key.split(",").map(Number) as [number, number]));
  const left = Math.min(...cells.map(([x]) => x));
  const right = Math.max(...cells.map(([x]) => x));
  const top = Math.min(...cells.map(([, y]) => y));
  const bottom = Math.max(...cells.map(([, y]) => y));
  return grids.map((grid) =>
    Array.from({ length: bottom - top + 1 }, (_, y) => Array.from({ length: right - left + 1 }, (_, x) => grid.get(`${x + left},${y + top}`) ?? ".").join("")),
  );
}

/** The lifecycle's frames, then the jellyfish's two strokes, swimming. */
const LIFECYCLE = lifecycle();
const SWIM = LIFECYCLE.length;

/** The jellyfish's frames, each as rows of pixels: what the pictures are rendered from. */
export const JELLYFISH_FRAMES: string[][] = crop([...LIFECYCLE, hero(0), hero(1)]);

export const JELLYFISH_WIDTH = JELLYFISH_FRAMES[0]![0]!.length;
export const JELLYFISH_HEIGHT = JELLYFISH_FRAMES[0]!.length;

/**
 * The order the frames play in, round and round: the polyp a moment, growing into the jellyfish, swimming four
 * seconds - a stroke every five frames - then sinking, and the polyp growing back.
 */
export const JELLYFISH_SEQUENCE: number[] = [
  ...[0, 0, 0],
  ...Array.from({ length: 20 }, (_, f) => f),
  ...Array.from({ length: 27 }, (_, f) => SWIM + (Math.floor(f / 5) % 2)),
  ...Array.from({ length: 19 }, (_, f) => 20 + f),
];

/** How long each frame shows. */
export const JELLYFISH_FRAME_MS = 150;

/** How much smaller the frames are drawn in half blocks: a cell is a block of SHRINK pixels square. */
const SHRINK = 3;

/**
 * A frame a third of the size: each block drawn as the pixel at its middle. What most of a block is would run the
 * tentacles, two pixels apart, together into one fringe; its middle keeps strands apart.
 */
function shrink(pixels: string[]): string[] {
  const middle = Math.floor(SHRINK / 2);
  const rows: string[] = [];
  for (let y = middle; y < pixels.length; y += SHRINK) {
    let row = "";
    for (let x = middle; x < pixels[0]!.length; x += SHRINK) row += pixels[y]![x]!;
    rows.push(row);
  }
  return rows;
}

/** The frames as a terminal without images draws them, in half blocks: the same order, a third of the size. */
export const JELLYFISH_TEXT_FRAMES: string[][] = JELLYFISH_FRAMES.map(shrink);

/** A colour laid over another, `alpha` of it showing. */
function over(hex: string, under: string, alpha: number): string {
  if (alpha >= 1) return hex;
  const channel = (colour: string, at: number) => Number.parseInt(colour.slice(at, at + 2), 16);
  return `#${[1, 3, 5].map((at) => Math.round(channel(hex, at) * alpha + channel(under, at) * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A frame drawn in half blocks for a terminal that shows no images: two pixels a cell, the upper one the text's colour
 * and the lower one the background's, in as many colours as the terminal has: a column a pixel, a row every two.
 */
export function halfBlocks(pixels: string[], appearance: "dark" | "light", truecolor: boolean): string[] {
  const colours = JELLYFISH_COLOURS[appearance];
  const colour = (pixel: string | undefined) =>
    pixel === undefined || pixel === "." ? undefined : over(colours[pixel as Pixel], BACKGROUND[appearance], ALPHA[pixel as Pixel]);
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
