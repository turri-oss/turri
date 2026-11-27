import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { allocateImageId, Box, type Component, getCapabilities, getPngDimensions, type ImageDimensions, renderImage, Text, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { BANNER_ENTRY, VERSION_ENTRY, type BannerData } from "@turri-dev/core";
import { CLI_ROOT } from "./cli-root.ts";
import { brandPink } from "./regenerate/plain-palette.ts";
import { halfBlocks, JELLYFISH_FRAME_MS, JELLYFISH_REST, JELLYFISH_SEQUENCE, JELLYFISH_TEXT_FRAMES } from "./jellyfish.ts";
import { overPictureRow, PICTURE_AT } from "./picture-row.ts";
import { padScreen, SCREEN_PADDING } from "./screen-padding.ts";
import { highlightPlainCodeBlocks } from "./plain-code-blocks.ts";

export function registerBanner(pi: ExtensionAPI, welcomeVisible: () => boolean): void {
  pi.registerEntryRenderer(BANNER_ENTRY, (entry, _options, theme) => {
    const data = entry.data as BannerData | undefined;
    if (data === undefined) return undefined;

    const lines = [
      `${brandPink(theme)("turri")}  ${theme.fg("muted", `v${data.version}`)}` +
        (data.commit !== undefined ? theme.fg("dim", `  from a clone, ${data.commit}${data.changed ? " with changes" : ""}`) : ""),
      // A newer turri out, or one installed and hidden behind this one: said first, under the version it is about.
      ...(data.versions ?? []).map((line) => theme.fg("warning", line)),
      // A key renamed is information; one that does not parse stops everything that reads it; the rest are the person's to take out.
      ...(data.config ?? []).map((line) => theme.fg(line.kind === "renamed" ? "muted" : line.kind === "broken" ? "error" : "warning", line.text)),
      `${theme.fg("text", "the first coding agent with the power of ")}${brandPink(theme)("regenerative software")}`,
      // Where the settings are changed, without leaving the chat.
      theme.fg("muted", "configure with /settings"),
      // Only what is wrong: skills that did not load, and agents' commands less fenced than they should be.
      ...(data.pending > 0 ? [theme.fg("warning", `${data.pending} skill${data.pending === 1 ? "" : "s"} failed to load`)] : []),
      ...(data.sandbox !== undefined && data.sandbox.level !== "ok" ? [theme.fg(data.sandbox.level === "limited" ? "warning" : "error", data.sandbox.text)] : []),
    ];
    // The jellyfish turri is named after, regenerating, in ink for the theme's background: a picture
    // where the terminal shows images, drawn in text where it does not.
    return new Banner(lines, (rule) => theme.fg("borderMuted", rule), jellyfishArt(theme.appearance, (theme.getColorMode?.() ?? "truecolor") === "truecolor"));
  });

  // A newer turri, found once turri had started: a line, as the banner would have said it.
  pi.registerEntryRenderer(VERSION_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { text: string } | undefined;
    if (data === undefined) return undefined;
    const box = new Box(1, 0);
    box.addChild(new Text(theme.fg("warning", data.text), 0, 0));
    return box;
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      padTheScreen(ctx);
      if (welcomeVisible()) animateJellyfish(ctx, welcomeVisible);
      // ***plain an agent shows in the chat, highlighted in the theme of the moment.
      highlightPlainCodeBlocks(() => ctx.ui.theme);
    }
  });
}

/**
 * How many rows the banner's picture takes at most: its frame reaches down to the sea floor the polyp stands on, so it
 * is given more than the jellyfish drawn in text, ten.
 */
const JELLYFISH_ROWS = 14;


/** How far along its sequence the jellyfish every banner shows is, moved on by `animateJellyfish`. */
let jellyfishFrame = 0;

/** The frame the jellyfish is on: the one its sequence has at this point. */
export const shownFrame = () => JELLYFISH_SEQUENCE[jellyfishFrame % JELLYFISH_SEQUENCE.length]!;
let jellyfishTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Moves the jellyfish on a frame every JELLYFISH_FRAME_MS while the banner is on the screen. An entry's
 * renderer is given no TUI to redraw, so an empty widget below the editor - which pi gives no
 * spacer - hands it over. Once the conversation is taller than the screen the banner has scrolled off,
 * and a line changing up there would have pi-tui clear and redraw everything, frame after frame: the
 * jellyfish stops for the rest of the session - swimming, whole, drawn once more if it was not, rather than on whatever
 * frame it was at, a polyp half grown.
 */
export function animateJellyfish(ctx: ExtensionContext, visible = () => true): void {
  if (jellyfishTimer !== undefined) clearInterval(jellyfishTimer);
  jellyfishTimer = undefined;
  ctx.ui.setWidget(
    JELLYFISH_CLOCK_KEY,
    (tui) => {
      drawOverlaysBesidePicture(tui);
      const timer = setInterval(() => {
        if (!visible()) {
          clearInterval(timer);
          return;
        }
        if (tui.render(tui.terminal.columns).length > tui.terminal.rows) {
          clearInterval(timer);
          if (shownFrame() !== JELLYFISH_SEQUENCE[JELLYFISH_REST]) {
            jellyfishFrame = JELLYFISH_REST;
            tui.requestRender();
          }
          return;
        }
        jellyfishFrame++;
        tui.requestRender();
      }, JELLYFISH_FRAME_MS);
      timer.unref?.();
      jellyfishTimer = timer;
      return {
        render: () => [],
        invalidate: () => {},
        dispose: () => clearInterval(timer),
      };
    },
    { placement: "belowEditor" },
  );
}

const JELLYFISH_CLOCK_KEY = "turri-jellyfish";

/**
 * The whole screen inside its padding (`screen-padding.ts`). An extension is given pi's screen only through what it
 * draws, so an empty widget below the editor hands it over - at each frame, as pi starts a new screen when it changes
 * how it draws.
 */
function padTheScreen(ctx: ExtensionContext): void {
  ctx.ui.setWidget(
    SCREEN_PADDING_KEY,
    (tui) => {
      padScreen(tui);
      return {
        render: () => {
          padScreen(tui);
          return [];
        },
        invalidate: () => {},
      };
    },
    { placement: "belowEditor" },
  );
}

const SCREEN_PADDING_KEY = "turri-padding";

/** The columns the banner's picture takes from the left edge, while it shows one; 0 when it does not. */
let pictureRight = 0;

/**
 * pi-tui draws no overlay over a line holding an image: it leaves the line as it is, and the side panel
 * would have a gap on the banner's row that carries the picture. So that row's text gets the overlay as
 * any other does, and the picture goes back on after it - unless the overlay reaches over the picture,
 * which is then left out of that row until it no longer does.
 */
function drawOverlaysBesidePicture(tui: TUI): void {
  const target = tui as unknown as { compositeLineAt?: (base: string, overlay: string, col: number, width: number, total: number) => string; turriPicture?: true };
  if (target.turriPicture === true || typeof target.compositeLineAt !== "function") return;
  target.turriPicture = true;
  const original = target.compositeLineAt.bind(tui);
  target.compositeLineAt = (base, overlay, col, width, total) => overPictureRow(base, overlay, col, width, total, pictureRight) ?? original(base, overlay, col, width, total);
}

/** Columns between the jellyfish and the lines beside it. */
const JELLYFISH_GAP = 3;

/** The fewest columns the lines keep beside the jellyfish; a terminal narrower than that gets the lines alone. */
const BANNER_TEXT_MIN = 30;

/**
 * The banner: the jellyfish on the left at the frame `animateJellyfish` has it on, its lines beside it in
 * the middle of its height, and a rule the width of the terminal under them both.
 *
 * pi-tui writes a line holding an image as it is. So the picture goes on one of the rows after that
 * row's text: back to the jellyfish's column (`CSI G`), then the image's escape sequence. Kitty places
 * the image there without moving the cursor, from the first row; iTerm2 moves the cursor past what it
 * draws, so it goes on the last row and climbs back up to start, as pi-tui's Image does.
 */
class Banner implements Component {
  private readonly lines: string[];
  private readonly rule: (text: string) => string;
  private readonly art: JellyfishArt | undefined;
  private kittyImageId: number | undefined;

  /** Without `art` the banner is its lines alone. */
  constructor(lines: string[], rule: (text: string) => string, art: JellyfishArt | undefined) {
    this.lines = lines;
    this.rule = rule;
    this.art = art;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const art = this.art;
    const placed =
      art?.kind === "image" ? this.placeImage(art, Math.max(JELLYFISH_ROWS, this.lines.length), width - 2 - JELLYFISH_GAP - BANNER_TEXT_MIN) : art?.kind === "text" && art.columns <= width - 2 - JELLYFISH_GAP - BANNER_TEXT_MIN ? art : undefined;
    const left = placed !== undefined ? 1 + placed.columns + JELLYFISH_GAP : 1;
    // Wrapped in the columns beside the picture, never cut short - the chat beside the docked panel is narrow.
    const text = this.lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 1 - left)));
    const height = Math.max(text.length, placed?.rows ?? 0);
    const above = Math.floor((height - text.length) / 2);
    const drawn = placed?.kind === "text" ? placed.frames[shownFrame()]! : undefined;
    const rows = Array.from({ length: height }, (_, row) => {
      const line = text[row - above];
      const jellyfish = drawn !== undefined ? (drawn[row] ?? " ".repeat(placed!.columns)) : " ".repeat(placed?.columns ?? 0);
      const before = placed !== undefined ? ` ${jellyfish}${" ".repeat(JELLYFISH_GAP)}` : " ";
      return line !== undefined ? `${before}${line}` : placed?.kind === "text" ? ` ${jellyfish}` : "";
    });
    // The side panel is drawn beside the picture (drawOverlaysBesidePicture), which goes on showing.
    pictureRight = placed?.kind === "image" ? SCREEN_PADDING.left + 1 + placed.columns : 0;
    if (placed?.kind === "image") {
      const at = placed.onLastRow ? placed.rows - 1 : 0;
      rows[at] = `${rows[at]}${PICTURE_AT}${placed.sequence}`;
    }
    return [...rows, ` ${this.rule("─".repeat(inner))}`];
  }

  private placeImage(
    art: Extract<JellyfishArt, { kind: "image" }>,
    rows: number,
    room: number,
  ): { kind: "image"; sequence: string; columns: number; rows: number; onLastRow: boolean } | undefined {
    if (room < 4) return undefined;
    const kitty = getCapabilities().images === "kitty";
    if (kitty && this.kittyImageId === undefined) this.kittyImageId = allocateImageId();
    const result = renderImage(art.frames[shownFrame()]!, art.dimensions, {
      maxWidthCells: room,
      maxHeightCells: rows,
      imageId: this.kittyImageId,
      moveCursor: false,
    });
    if (result === null || result.columns > room) return undefined;
    const sequence = kitty ? result.sequence : `${result.rows > 1 ? `\x1b[${result.rows - 1}A` : ""}${result.sequence}`;
    return { kind: "image", sequence, columns: result.columns, rows: result.rows, onLastRow: !kitty };
  }
}

/**
 * The jellyfish as the banner draws it: frames of a picture, for a terminal that shows images, or the same
 * pixels drawn in half blocks (`src/jellyfish.ts`), for one that does not.
 */
type JellyfishArt =
  | { kind: "image"; frames: string[]; dimensions: ImageDimensions }
  | { kind: "text"; frames: string[][]; columns: number; rows: number };

const jellyfishFrameCache = new Map<string, string[]>();

/**
 * The banner's jellyfish for this terminal: where it shows images, the picture's frames
 * (scripts/jellyfish-frames.mjs writes them), in the colours for the theme's background; where it does not, the
 * small one in half blocks. None when the pictures cannot be read.
 */
function jellyfishArt(appearance: "dark" | "light", truecolor: boolean): JellyfishArt | undefined {
  const dir = join(CLI_ROOT, "assets", "jellyfish");
  try {
    if (getCapabilities().images === null) {
      const frames = JELLYFISH_TEXT_FRAMES.map((pixels) => halfBlocks(pixels, appearance, truecolor));
      return { kind: "text", frames, columns: JELLYFISH_TEXT_FRAMES[0]![0]!.length, rows: frames[0]!.length };
    }
    let frames = jellyfishFrameCache.get(appearance);
    if (frames === undefined) {
      frames = readdirSync(dir)
        .filter((name) => name.startsWith(`${appearance}-`) && name.endsWith(".png"))
        .sort()
        .map((name) => readFileSync(join(dir, name)).toString("base64"));
      jellyfishFrameCache.set(appearance, frames);
    }
    const dimensions = frames.length > 0 ? getPngDimensions(frames[0]!) : null;
    return dimensions !== null ? { kind: "image", frames, dimensions } : undefined;
  } catch {
    return undefined;
  }
}
