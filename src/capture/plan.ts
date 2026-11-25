import { INTERFACE_KINDS, type CodeMap } from "./map.ts";

export interface CapturePlan {
  kind: "compact" | "staged";
  reason: string;
}

// One writer can follow this much code and test evidence in a turn. Bound bytes too: minified code may be one line.
const COMPACT = { files: 12, lines: 800, bytes: 64 * 1024 };
export const COMPACT_SURFACES = 12;

/** Choose the pipeline from the map, without a planning agent. The survey, reference or writer may later uncover more work. */
export function capturePlan(map: CodeMap, leafLines: number): CapturePlan {
  const files = map.files.filter((file) => file.kind === "source" || file.kind === "test" || file.kind === "contract");
  const lines = files.reduce((n, file) => n + file.lines, 0);
  const bytes = files.reduce((n, file) => n + (file.bytes ?? Infinity), 0);
  const surfaces = files.reduce((n, file) => n + (file.kind === "test" ? 0 : file.surfaces.filter((surface) => INTERFACE_KINDS.has(surface.kind)).length), 0);
  const fits = files.length <= COMPACT.files && lines <= Math.min(leafLines, COMPACT.lines) && bytes <= COMPACT.bytes && surfaces <= COMPACT_SURFACES;
  return { kind: fits ? "compact" : "staged", reason: `${files.length} source, test and contract files, ${lines} lines, ${Number.isFinite(bytes) ? `${Math.ceil(bytes / 1024)} KiB` : "size unknown"}, ${surfaces} mapped interface entries` };
}
