#!/usr/bin/env node
// The banner's jellyfish as pictures, for terminals that show images: each frame of src/jellyfish.ts's pixel jellyfish
// written to assets/jellyfish/ as <appearance>-NN.png, a pixel SCALE pixels square, in the design system's colours for
// a dark background and for a light one. Terminals without images draw the same frames in half blocks themselves.
//
//   node scripts/jellyfish-frames.mjs          write the frames
//   node scripts/jellyfish-frames.mjs --play   play the small one here as the banner draws it in text, in half blocks
//                                                (--light: in the light theme's colours)
import { readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { halfBlocks, JELLYFISH_COLOURS, JELLYFISH_FRAME_MS, JELLYFISH_FRAMES, JELLYFISH_HEIGHT, JELLYFISH_TEXT_FRAMES, JELLYFISH_WIDTH } from "../src/jellyfish.ts";

const SCALE = 6;

/** A frame as a PNG: RGBA, transparent where there is no pixel. */
function png(pixels, colours) {
  const width = JELLYFISH_WIDTH * SCALE;
  const height = JELLYFISH_HEIGHT * SCALE;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (width * 4 + 1);
    raw[at] = 0;
    for (let x = 0; x < width; x++) {
      const pixel = pixels[Math.floor(y / SCALE)][Math.floor(x / SCALE)];
      if (pixel === ".") continue;
      const hex = colours[pixel];
      const o = at + 1 + x * 4;
      [1, 3, 5].forEach((from, k) => (raw[o + k] = Number.parseInt(hex.slice(from, from + 2), 16)));
      raw[o + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

if (process.argv.includes("--play")) {
  const light = process.argv.includes("--light");
  const rows = Math.ceil(JELLYFISH_TEXT_FRAMES[0].length / 2);
  process.stdout.write("\x1b[?25l");
  process.on("SIGINT", () => (process.stdout.write("\x1b[?25h\n"), process.exit(0)));
  let t = 0;
  process.stdout.write("\n".repeat(rows));
  setInterval(() => {
    const drawn = halfBlocks(JELLYFISH_TEXT_FRAMES[t % JELLYFISH_TEXT_FRAMES.length], light ? "light" : "dark", true);
    process.stdout.write(`\x1b[${rows}A${drawn.map((line) => `\x1b[2K${line}`).join("\n")}\n`);
    t += 1;
  }, JELLYFISH_FRAME_MS);
} else {
  const dir = join(dirname(dirname(fileURLToPath(import.meta.url))), "assets", "jellyfish");
  for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
  for (const appearance of ["dark", "light"]) {
    JELLYFISH_FRAMES.forEach((pixels, t) => writeFileSync(join(dir, `${appearance}-${String(t).padStart(2, "0")}.png`), png(pixels, JELLYFISH_COLOURS[appearance])));
  }
  console.log(`wrote ${JELLYFISH_FRAMES.length} frames for each appearance to ${dir}`);
}
