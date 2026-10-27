import { describe, expect, it } from "vitest";
import { simpleCycles, stronglyConnectedComponents, type Graph } from "../../src/plain/cycles.ts";

/** Port of tests/test_graph.py. */

const graphOf = <T>(entries: Array<[T, T[]]>): Graph<T> => new Map(entries);
const cyclesOf = <T>(graph: Graph<T>, limit?: number) => [...simpleCycles(graph, limit)];

/** Each cycle rotated to start at its smallest node, so equal cycles compare equal. */
function canonical<T>(cycles: T[][]): Set<string> {
  const result = new Set<string>();
  for (const cycle of cycles) {
    const smallest = [...cycle].sort()[0]!;
    const start = cycle.indexOf(smallest);
    result.add(JSON.stringify([...cycle.slice(start), ...cycle.slice(0, start)]));
  }
  return result;
}

/** Every node subset in every order; the ones that close a loop. */
function bruteForceCycles(adjacency: Map<number, number[]>): Set<string> {
  const nodes = [...adjacency.keys()].sort((a, b) => a - b);
  const found: number[][] = [];
  const extend = (path: number[]) => {
    if (path.length > 0) {
      const closes = path.every((node, i) => adjacency.get(node)!.includes(path[(i + 1) % path.length]!));
      if (closes) found.push(path);
    }
    for (const node of nodes) if (!path.includes(node)) extend([...path, node]);
  };
  extend([]);
  return canonical(found);
}

/** A seeded generator, so each random graph is the same on every run. */
function rng(seed: number): () => number {
  let state = seed + 1;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const complete = (names: string[]) => graphOf(names.map((n) => [n, names.filter((m) => m !== n)]));

describe("cycle search", () => {
  it("finds no cycle in a graph without one", () => {
    expect(cyclesOf(graphOf([["a", ["b"]], ["b", ["c"]], ["c", []]]))).toEqual([]);
  });

  it("finds no cycle in an empty graph", () => {
    expect(cyclesOf(graphOf<string>([]))).toEqual([]);
  });

  it("finds a self-loop", () => {
    expect(cyclesOf(graphOf([["a", ["a"]]]))).toEqual([["a"]]);
  });

  it("finds a two-node cycle", () => {
    expect(canonical(cyclesOf(graphOf([["a", ["b"]], ["b", ["a"]]])))).toEqual(canonical([["a", "b"]]));
  });

  it("tolerates a node that is only ever a target", () => {
    expect(canonical(cyclesOf(graphOf([["a", ["b", "ghost"]], ["b", ["a"]]])))).toEqual(canonical([["a", "b"]]));
  });

  it("finds the five cycles of the complete graph on three nodes", () => {
    expect(cyclesOf(complete(["a", "b", "c"]))).toHaveLength(5);
  });

  it("finds the twenty cycles of the complete graph on four nodes", () => {
    expect(cyclesOf(complete(["a", "b", "c", "d"]))).toHaveLength(20);
  });

  it("finds two separate cycles", () => {
    const graph = graphOf([["a", ["b"]], ["b", ["a"]], ["x", ["y"]], ["y", ["x"]], ["lone", []]]);
    expect(canonical(cyclesOf(graph))).toEqual(canonical([["a", "b"], ["x", "y"]]));
  });

  it("reports a cycle in edge order", () => {
    const graph = graphOf([["a", ["b"]], ["b", ["c"]], ["c", ["a"]]]);
    const [cycle] = cyclesOf(graph);
    cycle!.forEach((node, i) => expect(graph.get(node)).toContain(cycle![(i + 1) % cycle!.length]));
  });

  it("splits a graph into its strongly connected components", () => {
    const graph = graphOf([["a", ["b"]], ["b", ["a", "c"]], ["c", ["d"]], ["d", ["c"]], ["e", []]]);
    const components = stronglyConnectedComponents(graph).map((component) => [...component].sort());
    expect(components.sort()).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("stops after as many cycles as the limit allows", () => {
    expect(cyclesOf(complete(["a", "b", "c", "d"]), 10)).toHaveLength(10);
    expect(cyclesOf(complete(["a", "b", "c", "d"]), 0)).toHaveLength(0);
  });

  it("never enters an acyclic appendage", () => {
    // A 2-cycle with a chain of 40 diamonds hanging off it: exponentially many paths, one cycle.
    const graph = graphOf<string>([["a", ["b", "d0"]], ["b", ["a"]]]);
    for (let i = 0; i < 40; i += 1) {
      graph.set(`d${i}`, [`l${i}`, `r${i}`]);
      graph.set(`l${i}`, [`d${i + 1}`]);
      graph.set(`r${i}`, [`d${i + 1}`]);
    }
    graph.set("d40", []);
    expect(canonical(cyclesOf(graph))).toEqual(canonical([["a", "b"]]));
  });

  it("yields a cycle through a repeated edge once", () => {
    expect(cyclesOf(graphOf([["a", ["b", "b"]], ["b", ["a", "a"]]]))).toEqual([["a", "b"]]);
  });

  it("does not enumerate the cycles past the limit", () => {
    // The complete graph on 14 nodes has billions of cycles; only a lazy search returns.
    const nodes = Array.from({ length: 14 }, (_, i) => i);
    const graph = graphOf(nodes.map((n) => [n, nodes.filter((m) => m !== n)]));
    expect(cyclesOf(graph, 11)).toHaveLength(11);
  });

  it("gives separate cycles in the graph's order", () => {
    const graph = graphOf<string>([]);
    for (const name of "pqrst") for (const i of [0, 1]) graph.set(`${name}${i}`, [`${name}${1 - i}`]);
    expect(cyclesOf(graph).map((cycle) => cycle[0]![0])).toEqual([..."pqrst"]);
  });

  it("follows a cycle longer than any call stack", () => {
    const n = 40_000;
    const graph = graphOf(Array.from({ length: n }, (_, i) => [i, [(i + 1) % n]] as [number, number[]]));
    const cycles = cyclesOf(graph);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(n);
  });

  it("splits a chain longer than any call stack into its components", () => {
    const n = 40_000;
    const graph = graphOf(Array.from({ length: n }, (_, i) => [i, [i + 1]] as [number, number[]]));
    expect(stronglyConnectedComponents(graph)).toHaveLength(n + 1);
  });

  it.each(Array.from({ length: 200 }, (_, seed) => seed))("matches a brute-force search on random graph %i", (seed) => {
    const random = rng(seed);
    const n = 1 + Math.floor(random() * 6);
    const density = [0.2, 0.4, 0.7, 1.0][Math.floor(random() * 4)]!;
    const nodes = Array.from({ length: n }, (_, i) => i);
    const adjacency = new Map(nodes.map((u) => [u, nodes.filter(() => random() < density)]));
    const cycles = cyclesOf(adjacency);
    expect(canonical(cycles).size).toBe(cycles.length);
    expect(canonical(cycles)).toEqual(bruteForceCycles(adjacency));
    const earliest = cycles.filter((cycle) => cycle.length > 1).map((cycle) => Math.min(...cycle));
    expect(earliest).toEqual([...earliest].sort((a, b) => a - b));
  });
});
