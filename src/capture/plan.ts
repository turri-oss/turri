import { INTERFACE_KINDS, type CodeMap } from "./map.ts";

export interface CapturePlan {
  kind: "compact" | "staged";
  reason: string;
}

const LIMIT = { files: 64, lines: 4000, interfaces: 24 };

/** Stage when any size limit is exceeded. Once the reference is known, use its coverage instead of the map's estimate. */
export function capturePlan(map: CodeMap, discoveredInterfaces?: number): CapturePlan {
  const files = map.files.filter((file) => file.kind === "source" || file.kind === "test" || file.kind === "contract");
  const lines = files.reduce((n, file) => n + file.lines, 0);
  const interfaces = discoveredInterfaces ?? files.reduce((n, file) => n + (file.kind === "test" ? 0 : file.surfaces.filter((surface) => INTERFACE_KINDS.has(surface.kind)).length), 0);
  const staged = files.length > LIMIT.files || lines > LIMIT.lines || interfaces > LIMIT.interfaces;
  return {
    kind: staged ? "staged" : "compact",
    reason: `${files.length}/${LIMIT.files} source, test and contract files, ${lines}/${LIMIT.lines} lines, ${interfaces}/${LIMIT.interfaces} ${discoveredInterfaces === undefined ? "mapped" : "discovered"} interface entries - ${staged ? "at least one limit exceeded" : "within all three limits"}`,
  };
}
