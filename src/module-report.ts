import { brand } from "./brand.ts";
/** Colours for what the command line prints. */
export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  success: brand.success,
  error: brand.error,
  warning: brand.warning,
  accent: brand.accent,
};
