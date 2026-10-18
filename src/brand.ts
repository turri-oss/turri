import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * turri's colours for what its command line prints - the design system's, as its themes use them (.pi/themes): on a
 * dark terminal neon and pink, on a light one blue whale and eggplant. Nothing is coloured when the output is not a terminal, or NO_COLOR is set;
 * a terminal without 24-bit colour gets the nearest of its sixteen.
 */

/** Whether the terminal is light: COLORFGBG says so (a light background, 7 or 15), or pi's theme is a light one. */
function lightTerminal(): boolean {
  const background = process.env.COLORFGBG?.split(";").at(-1);
  if (background === "7" || background === "15") return true;
  try {
    const settings = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
    if (existsSync(settings)) return /light/i.test(String((JSON.parse(readFileSync(settings, "utf8")) as { theme?: unknown }).theme ?? ""));
  } catch {
    /* no settings to go by */
  }
  return false;
}

function paint(stream: NodeJS.WriteStream = process.stdout) {
  const on = stream.isTTY === true && process.env.NO_COLOR === undefined;
  const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
  const light = on && lightTerminal();
  const ink = (hex: string, basic: number) => (text: string) => {
    if (!on) return text;
    if (!truecolor) return `\x1b[${basic}m${text}\x1b[39m`;
    const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
  };
  return {
    /** turri's accent: what to look at - a heading, a choice's number, the command to run. */
    accent: light ? ink("#1e3442", 34) : ink("#5ce1e6", 96),
    /** Done, and what was written. */
    success: light ? ink("#732553", 35) : ink("#ff5c8d", 95),
    /** What is wrong: what stops turri. */
    error: ink("#ff7a3d", 33),
    /** What works, with limits. */
    warning: ink("#ff7a3d", 33),
    /** What goes with it, and can be skimmed. */
    muted: light ? ink("#3e5a6b", 90) : ink("#85a3b2", 37),
    bold: (text: string) => (on ? `\x1b[1m${text}\x1b[22m` : text),
  };
}

export const brand = paint();
