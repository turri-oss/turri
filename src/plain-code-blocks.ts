import { Markdown } from "@earendil-works/pi-tui";
import { highlightLines, roleOf, type PlainRole } from "@turri-dev/core/plain";
import { plainPaint } from "./regenerate/plain-palette.ts";

/**
 * A fenced block of ***plain in the chat - ```plain, as an agent shows a module, or a fence with no language around
 * a section's header - highlighted as turri highlights ***plain everywhere else: by its own grammar
 * (plain/highlight.ts), in the colours of a ***plain diff (plain-palette.ts). pi highlights a code block through highlight.js, which knows no ***plain, and has no hook for
 * a language of an extension's: so pi-tui's Markdown is patched, as chat-terminal.ts patches pi's screen - a ***plain
 * block drawn with a highlighter of turri's in place of the theme's, every other block as pi draws it.
 */

/** The fence's languages that are ***plain. */
const PLAIN_LANGUAGES = new Set(["plain", "***plain"]);

export function isPlainLanguage(lang: string | undefined): boolean {
  return lang !== undefined && PLAIN_LANGUAGES.has(lang.trim().toLowerCase());
}

/** A section's header on a line of its own - `***functional specs***` - which nothing but ***plain writes. */
const SECTION_HEADER = /^\*\*\*[a-z][a-z ]*\*\*\*[ \t]*$/m;

/** Whether a fenced block is ***plain: fenced as plain, or fenced with no language around a section's header. */
export function isPlainBlock(lang: string | undefined, text: string): boolean {
  return isPlainLanguage(lang) || ((lang ?? "").trim() === "" && SECTION_HEADER.test(text));
}

/** Lines of ***plain, each piece painted by its role; the text around them in `rest`. */
export function highlightPlain(code: string, paint: (role: PlainRole, text: string) => string, rest: (text: string) => string = (text) => text): string[] {
  return highlightLines(code.split("\n")).map((tokens) =>
    tokens
      .map((token) => {
        const role = roleOf(token.scopes);
        return role !== undefined ? paint(role, token.text) : rest(token.text);
      })
      .join(""),
  );
}

/** What a theme says of itself that the palette needs: dark or light, and how many colours the terminal has. */
type ThemeLike = { appearance?: "dark" | "light"; getColorMode?(): string };

interface MarkdownTheme {
  highlightCode?: (code: string, lang?: string) => string[];
  codeBlock: (text: string) => string;
}

interface PatchedMarkdown {
  theme: MarkdownTheme;
}

type RenderToken = (this: PatchedMarkdown, token: { type: string; lang?: string; text?: string }, ...rest: unknown[]) => string[];

let themeNow: () => ThemeLike | undefined = () => undefined;
let patched = false;

/** From now on, a ***plain block in the chat is highlighted - in the colours of the theme `theme` gives at the time. */
export function highlightPlainCodeBlocks(theme: () => ThemeLike | undefined): void {
  themeNow = theme;
  if (patched) return;
  patched = true;
  const prototype = Markdown.prototype as unknown as { renderToken: RenderToken };
  const renderToken = prototype.renderToken;
  prototype.renderToken = function (this: PatchedMarkdown, token, ...rest) {
    const theme = this.theme;
    const current = themeNow();
    if (token.type !== "code" || !isPlainBlock(token.lang, token.text ?? "") || current === undefined) return renderToken.call(this, token, ...rest);
    const paint = plainPaint(current);
    // Drawn by pi, with turri's highlighter in the theme's place for this block alone.
    this.theme = { ...theme, highlightCode: (code) => highlightPlain(code, paint.syntax, theme.codeBlock) };
    try {
      return renderToken.call(this, token, ...rest);
    } finally {
      this.theme = theme;
    }
  };
}
