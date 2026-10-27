import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";

/**
 * The markdown layer.
 *
 * The Python parser leans on mistletoe for two things: an AST with line numbers,
 * and a MarkdownRenderer that round-trips a token back to markdown. mdast gives
 * us the first. The second is `renderToMarkdown` below - a serializer for the
 * subset of markdown the plain language uses, matching mistletoe's output
 * (source indentation preserved, links rewritten as `[resource]` spans).
 *
 * The reference parses inside the renderer's context, so blank lines are tokens of
 * their own (BlankLine), one per blank line, and survive in what is rendered; they
 * are recovered here from the source.
 */

export const RESOURCE_MARKER = "[resource]";

/** Extra fields the parser hangs off AST nodes, as the Python code hangs them off tokens. */
export interface PlainAnnotations {
  linked_resources?: LinkedResource[];
  /** Set when `value` holds the original source slice rather than mdast's decoded text. */
  raw?: boolean;
  openDelimiter?: string;
  closeDelimiter?: string;
  /** List item geometry, in mistletoe's parent-stripped coordinates. */
  leader?: string;
  indentation?: number;
  prepend?: number;
  /**
   * The blank lines in the source before a block, after the block before it: one run, and one more for each comment
   * dropped in between - mistletoe's BlankLine tokens, one per blank line.
   */
  blankRuns?: number[];
  /** A thematic break's line, or a setext heading's underline, as its container holds it. */
  sourceLine?: string;
  /** A fenced code block's opening: its indentation, its delimiter and its info string, as written. */
  fence?: { indentation: number; delimiter: string; infoString: string };
}

export interface LinkedResource {
  text: string;
  target: string;
}

/**
 * A structural view of an mdast node. The mdast union types do not narrow well when
 * the parser hangs its own fields off nodes, so the AST is handled structurally -
 * every real mdast node satisfies this shape.
 */
export interface AnyNode extends PlainAnnotations {
  type: string;
  value?: string;
  children?: AnyNode[];
  position?: {
    start: { line: number; column: number; offset?: number };
    end: { line: number; column: number; offset?: number };
  };
  [key: string]: unknown;
}

export type Root = AnyNode;

/** A parsed specification section: mistletoe's `Document` holding a flat list of list items. */
export interface Section {
  children: AnyNode[];
}

/**
 * Parse markdown, then pin every inline node back to its original source text.
 *
 * mdast decodes inline syntax: `\"` becomes `"`, and an emphasis written with `_`
 * loses the fact that it was not `*`. mistletoe's MarkdownRenderer round-trips the
 * source instead, so re-serialising a decoded tree drifts from the Python output.
 * Recording the raw slice for leaf nodes and the real delimiters for emphasis and
 * strong keeps the two renderers in agreement. Tables are GFM's, as mistletoe parses them.
 */
export function parseMarkdown(text: string): Root {
  const root = fromMarkdown(text, { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] }) as unknown as Root;
  pinToSource(root, text, 1, text.split("\n"));
  return root;
}

const RAW_LEAF_TYPES = new Set(["text", "inlineCode", "html"]);

/** The containers whose children are blocks, with blank lines between them as mistletoe keeps them. */
const BLOCK_CONTAINERS = new Set(["root", "list", "listItem", "blockquote"]);

/** The whitespace-only lines strictly between two source lines. */
function blankLinesWithin(lines: string[], afterLine: number, beforeLine: number): number {
  let count = 0;
  for (let line = afterLine + 1; line < beforeLine; line += 1) if ((lines[line - 1] ?? "").trim() === "") count += 1;
  return count;
}

function pinToSource(node: AnyNode, source: string, origin: number, lines: string[]): void {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;

  if (BLOCK_CONTAINERS.has(node.type)) {
    const children = childrenOf(node);
    children.forEach((child, index) => {
      const previousEnd = children[index - 1]?.position?.end.line;
      const childStart = child.position?.start.line;
      child.blankRuns = [previousEnd === undefined || childStart === undefined ? 0 : blankLinesWithin(lines, previousEnd, childStart)];
    });
  }

  if (start !== undefined && end !== undefined) {
    if (RAW_LEAF_TYPES.has(node.type)) {
      const raw = source.slice(start, end);
      // A paragraph's continuation lines carry leading whitespace that is not part of
      // the text. mistletoe drops it when rendering; keeping it here would indent the
      // line twice, once from the source and once from the enclosing list item.
      node.value = node.type === "text" ? raw.replace(/\n[ \t]*/g, "\n") : raw;
      node.raw = true;
    } else if (node.type === "emphasis" || node.type === "strong") {
      const width = node.type === "strong" ? 2 : 1;
      node.openDelimiter = source.slice(start, start + width);
      node.closeDelimiter = source.slice(end - width, end);
    } else if (node.type === "thematicBreak") {
      // mistletoe keeps the line as written, with its indentation in the container.
      node.sourceLine = (lines[node.position!.start.line - 1] ?? "").slice(origin - 1);
    } else if (node.type === "heading" && source[start] !== "#") {
      // A setext heading: mistletoe keeps its underline as written.
      node.sourceLine = (lines[node.position!.end.line - 1] ?? "").slice(origin - 1).trimEnd();
    } else if (node.type === "code") {
      const opening = /^(`{3,}|~{3,})([^\n]*)/.exec(source.slice(start, end));
      if (opening !== null) node.fence = { indentation: column(node) - origin, delimiter: opening[1]!, infoString: opening[2]! };
    } else if (node.type === "definition") {
      node.value = source.slice(start, end);
      node.raw = true;
    }
  }

  let childOrigin = origin;
  if (node.type === "listItem") {
    // mistletoe strips the enclosing item's indentation before parsing nested blocks,
    // so `indentation` and `prepend` are measured against that stripped origin - not
    // against the item's own column. Continuation lines are later indented by
    // `prepend`, which is why a nested list keeps more indentation than the gap
    // between the two columns in the source.
    const itemColumn = column(node);
    const first = childrenOf(node)[0];
    const contentColumn = first ? column(first) : itemColumn + 2;

    node.indentation = itemColumn - origin;
    node.prepend = contentColumn - origin;
    node.leader =
      start !== undefined && first
        ? source.slice(start, start + (contentColumn - itemColumn)).trimEnd()
        : "-";
    childOrigin = contentColumn;
  }

  for (const child of childrenOf(node)) pinToSource(child, source, childOrigin, lines);
}

export function lineNumber(node: AnyNode): number {
  return node.position?.start.line ?? 0;
}

function column(node: AnyNode): number {
  return node.position?.start.column ?? 1;
}

function isParent(node: AnyNode): boolean {
  return Array.isArray(node.children);
}

function childrenOf(node: AnyNode): AnyNode[] {
  return node.children ?? [];
}

/**
 * Port of plain_file.remove_quotes: block quotes are comments and are dropped. The blank
 * lines around a dropped one stay, as mistletoe's BlankLine tokens do.
 */
export function removeQuotes(node: AnyNode): void {
  if (!isParent(node)) return;
  const kept: AnyNode[] = [];
  let dropped: number[] = [];
  for (const child of node.children as AnyNode[]) {
    if (child.type === "blockquote") {
      dropped = [...dropped, ...(child.blankRuns ?? [0])];
      continue;
    }
    if (dropped.length > 0) {
      child.blankRuns = [...dropped, ...(child.blankRuns ?? [0])];
      dropped = [];
    }
    removeQuotes(child);
    kept.push(child);
  }
  node.children = kept;
}

/** Port of plain_file.get_raw_text. */
export function getRawText(node: AnyNode): string {
  if (node.type === "text") return node.value as string;
  if (isParent(node)) {
    return childrenOf(node).map(getRawText).join("");
  }
  const value = node.value;
  if (value !== undefined) return value;
  if (node.type === "thematicBreak") return "";
  throw new Error(`Unknown token type: ${node.type}`);
}

/** Port of mistletoe.utils.traverse restricted to a node type. */
export function traverse(node: AnyNode, type: string): AnyNode[] {
  const found: AnyNode[] = [];
  const walk = (n: AnyNode) => {
    if (n.type === type) found.push(n);
    if (isParent(n)) for (const child of n.children as AnyNode[]) walk(child);
  };
  walk(node);
  return found;
}

function renderInline(node: AnyNode): string {
  switch (node.type) {
    case "text":
      return node.value as string;
    case "inlineCode":
      // The raw slice already carries its own backticks.
      return node.raw ? (node.value as string) : `\`${node.value as string}\``;
    case "emphasis":
      return `${(node.openDelimiter as string) ?? "*"}${renderInlineChildren(node)}${(node.closeDelimiter as string) ?? "*"}`;
    case "strong":
      return `${(node.openDelimiter as string) ?? "**"}${renderInlineChildren(node)}${(node.closeDelimiter as string) ?? "**"}`;
    // PlainRenderer.render_link: a link becomes a literal `[resource]<text>` span.
    case "link":
      return `\`${RESOURCE_MARKER}${renderInlineChildren(node)}\``;
    case "image":
      return `![${renderInlineChildren(node)}](${node.url as string})`;
    case "break":
      return "\n";
    case "html":
      return node.value as string;
    default:
      return isParent(node) ? renderInlineChildren(node) : (node.value ?? "");
  }
}

function renderInlineChildren(node: AnyNode): string {
  return childrenOf(node).map(renderInline).join("");
}

/** Whether a block ends with a list: a list, or a list item whose last block does. */
function endsWithList(node: AnyNode): boolean {
  if (node.type === "list") return true;
  const last = childrenOf(node).at(-1);
  return node.type === "listItem" && last !== undefined && endsWithList(last);
}

/**
 * The blank lines mistletoe keeps between two sibling blocks: one per blank line in the
 * source, comment lines dropped in between counted out. A list item that ends without a
 * next item gives back only the last of the blank lines after it (`ListItem.read` steps
 * back one line), so the run right after a list counts once.
 */
function blankLinesBefore(previous: AnyNode, node: AnyNode): number {
  const runs = [...(node.blankRuns ?? [0])];
  if (endsWithList(previous)) runs[0] = Math.min(runs[0]!, 1);
  return runs.reduce((sum, run) => sum + run, 0);
}

/** Port of MarkdownRenderer.prefix_lines. */
function prefixLines(lines: string[], firstPrefix: string, followingPrefix: string): string[] {
  return lines.map((line, index) => {
    const prefixed = (index === 0 ? firstPrefix : followingPrefix) + line;
    return prefixed.trim() === "" ? "" : prefixed;
  });
}

/**
 * Port of MarkdownRenderer.blocks_to_lines. Blocks are concatenated with no separator;
 * blank lines are their own tokens in mistletoe, and are recovered here from the source.
 */
export function blocksToLines(nodes: AnyNode[]): string[] {
  const lines: string[] = [];
  nodes.forEach((node, index) => {
    if (index > 0) for (let blank = blankLinesBefore(nodes[index - 1]!, node); blank > 0; blank -= 1) lines.push("");
    lines.push(...renderBlockLines(node));
  });
  return lines;
}

/** Port of MarkdownRenderer.render_list_item. */
function renderListItemLines(item: AnyNode): string[] {
  const prepend = (item.prepend as number) ?? 2;
  const indentation = (item.indentation as number) ?? 0;
  const leader = (item.leader as string) ?? "-";

  const lines = blocksToLines(childrenOf(item));
  const firstPrefix =
    " ".repeat(Math.max(0, indentation)) +
    leader +
    " ".repeat(Math.max(0, prepend - leader.length - indentation));

  return prefixLines(lines.length > 0 ? lines : [""], firstPrefix, " ".repeat(Math.max(0, prepend)));
}

/** mistletoe's alignment of a table column: null for left or none, 0 for centre, 1 for right. */
function alignOf(align: unknown): number | null {
  return align === "center" ? 0 : align === "right" ? 1 : null;
}

/**
 * Port of MarkdownRenderer.render_table: each cell re-rendered with its pipes escaped,
 * every column as wide as its widest cell and at least three, padded by its alignment,
 * and the separator row rebuilt from the alignments.
 */
function renderTableLines(node: AnyNode): string[] {
  const aligns = ((node.align as unknown[] | undefined) ?? []).map(alignOf);
  const rows = childrenOf(node).map((row) =>
    childrenOf(row).map((cell) => (renderInlineChildren(cell).split("\n")[0] ?? "").replace(/\\\|/g, "|").replace(/\|/g, "\\|")),
  );
  const [header = [], ...body] = rows;
  const columns = Math.max(aligns.length, ...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, index) => Math.max(3, ...rows.map((row) => (row[index] ?? "").length)));
  const lineOf = (cells: string[]) =>
    "| " +
    widths
      .map((width, index) => {
        const text = cells[index] ?? "";
        const align = aligns[index] ?? null;
        if (align === null) return text.padEnd(width);
        if (align === 1) return text.padStart(width);
        const left = Math.floor((width - text.length) / 2);
        return " ".repeat(Math.max(0, left)) + text + " ".repeat(Math.max(0, width - text.length - left));
      })
      .join(" | ") +
    " |";
  const separator = widths.map((width, index) => {
    const align = aligns[index] ?? null;
    return (align === 0 ? ":" : "-") + "-".repeat(width - 2) + (align === 0 || align === 1 ? ":" : "-");
  });
  return [lineOf(header), `| ${separator.join(" | ")} |`, ...body.map(lineOf)];
}

function renderBlockLines(node: AnyNode): string[] {
  switch (node.type) {
    case "paragraph":
      return renderInlineChildren(node).split("\n");

    case "heading": {
      // A setext heading keeps its underline; an ATX one is its hashes and its text.
      if (node.sourceLine !== undefined) return [...renderInlineChildren(node).split("\n"), node.sourceLine];
      const text = renderInlineChildren(node);
      return [`${"#".repeat(node.depth as number)}${text ? ` ${text}` : ""}`];
    }

    case "code": {
      const content = (node.value ?? "").split("\n");
      if (node.fence === undefined) return prefixLines(content, "    ", "    ");
      const indentation = " ".repeat(Math.max(0, node.fence.indentation));
      return [
        indentation + node.fence.delimiter + node.fence.infoString,
        ...prefixLines(content, indentation, indentation),
        indentation + node.fence.delimiter,
      ];
    }

    case "thematicBreak":
      return [node.sourceLine ?? "---"];

    case "table":
      return renderTableLines(node);

    case "blockquote":
      return blocksToLines(childrenOf(node)).map((line) => (line ? `> ${line}` : ">"));

    case "list":
      return blocksToLines(childrenOf(node));

    case "listItem":
      return renderListItemLines(node);

    default:
      return node.children !== undefined
        ? blocksToLines(childrenOf(node))
        : (node.value ?? "").split("\n");
  }
}

/** Port of PlainRenderer.render. */
export function renderToMarkdown(node: AnyNode): string {
  return renderBlockLines(node).join("\n");
}

/**
 * Port of plain_file.render_tokens: blocks rendered as one markdown text, without leading
 * and trailing blank lines.
 */
export function renderTokens(nodes: AnyNode[]): string {
  return blocksToLines(nodes).join("\n").replace(/^\n+|\n+$/g, "");
}
