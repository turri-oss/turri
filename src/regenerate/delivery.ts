import { relative } from "node:path";

/**
 * How a command-line run that landed code ends: the command that releases it to try.
 */

function shortPath(buildDir: string): string {
  const fromHere = relative(process.cwd(), buildDir);
  return fromHere === "" || fromHere.startsWith("..") ? buildDir : fromHere;
}

/** A command-line run has no one to ask: the command that releases what it built. */
export function tryItCommand(plainFile: string): string {
  return `To try it: turri release ${shortPath(plainFile)}`;
}
