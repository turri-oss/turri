/**
 * Port of graph.py: the cycle search over a directed graph given as a mapping from a node to its successors.
 *
 * Nodes that appear only as successors are treated as having no outgoing edges. The search is Johnson's algorithm,
 * with the strongly connected components found by Tarjan's. Both keep their own stack of frames instead of
 * recursing, so the depth of a tangle is not limited by the call stack.
 *
 * - D. B. Johnson, "Finding all the elementary circuits of a directed graph", SIAM J. Comput. 4(1):77-84, 1975
 * - R. Tarjan, "Depth-first search and linear graph algorithms", SIAM J. Comput. 1(2):146-160, 1972
 */

export type Graph<T> = Map<T, Iterable<T>>;

function successorsOf<T>(graph: Graph<T>): Map<T, T[]> {
  // A repeated edge would otherwise yield every cycle through it once per repeat.
  const successors = new Map<T, T[]>();
  for (const [node, targets] of graph) successors.set(node, [...new Set(targets)]);
  for (const targets of [...successors.values()]) {
    for (const target of targets) if (!successors.has(target)) successors.set(target, []);
  }
  return successors;
}

/**
 * Tarjan: one depth-first walk, each node stamped with its visit index and the lowest index it can reach; a node
 * whose lowest reachable index is its own closes a component.
 */
export function stronglyConnectedComponents<T>(graph: Graph<T>): Array<Set<T>> {
  const successors = successorsOf(graph);
  const index = new Map<T, number>();
  const lowlink = new Map<T, number>();
  const stack: T[] = [];
  const onStack = new Set<T>();
  const components: Array<Set<T>> = [];

  const visit = (node: T): { node: T; targets: T[]; next: number } => {
    index.set(node, index.size);
    lowlink.set(node, index.get(node)!);
    stack.push(node);
    onStack.add(node);
    return { node, targets: successors.get(node)!, next: 0 };
  };

  for (const root of successors.keys()) {
    if (index.has(root)) continue;
    const frames = [visit(root)];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      let descended = false;
      while (frame.next < frame.targets.length) {
        const target = frame.targets[frame.next++]!;
        if (!index.has(target)) {
          frames.push(visit(target));
          descended = true;
          break;
        }
        if (onStack.has(target)) lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, index.get(target)!));
      }
      if (descended) continue;
      frames.pop();
      const node = frame.node;
      if (frames.length > 0) {
        const parent = frames[frames.length - 1]!.node;
        lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(node)!));
      }
      if (lowlink.get(node) === index.get(node)) {
        const component = new Set<T>();
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.add(member);
          if (member === node) break;
        }
        components.push(component);
      }
    }
  }
  return components;
}

/**
 * Johnson's CIRCUIT: every elementary cycle through `s` in one strongly connected component. A node is blocked while
 * it is on the path, and stays blocked after backtracking until a cycle is found through some node it was waiting on.
 */
function* cyclesThrough<T>(adjacency: Map<T, T[]>, s: T): Generator<T[]> {
  const blocked = new Set<T>();
  const blockedMap = new Map<T, Set<T>>();

  const unblock = (node: T): void => {
    const pending = [node];
    while (pending.length > 0) {
      const current = pending.pop()!;
      blocked.delete(current);
      const waiting = blockedMap.get(current);
      blockedMap.delete(current);
      for (const other of waiting ?? []) if (blocked.has(other)) pending.push(other);
    }
  };

  const path: T[] = [s];
  blocked.add(s);
  const frames: Array<{ targets: T[]; next: number }> = [{ targets: adjacency.get(s)!, next: 0 }];
  const foundBelow: boolean[] = [false];
  while (frames.length > 0) {
    const node = path[path.length - 1]!;
    const frame = frames[frames.length - 1]!;
    let descended = false;
    while (frame.next < frame.targets.length) {
      const target = frame.targets[frame.next++]!;
      if (target === s) {
        yield [...path];
        foundBelow[foundBelow.length - 1] = true;
      } else if (!blocked.has(target)) {
        path.push(target);
        blocked.add(target);
        frames.push({ targets: adjacency.get(target)!, next: 0 });
        foundBelow.push(false);
        descended = true;
        break;
      }
    }
    if (descended) continue;
    frames.pop();
    path.pop();
    if (foundBelow.pop()) {
      unblock(node);
      if (foundBelow.length > 0) foundBelow[foundBelow.length - 1] = true;
    } else {
      for (const target of adjacency.get(node)!) {
        if (!blockedMap.has(target)) blockedMap.set(target, new Set());
        blockedMap.get(target)!.add(node);
      }
    }
  }
}

/**
 * Johnson's main loop: every cycle lies inside one strongly connected component, and every cycle inside a component
 * either passes through its least node or survives that node's removal. So search each component from its least
 * node, drop the node, and split what is left into components again. Components are taken least node first, so a
 * caller that stops early has seen the cycles through the earliest nodes.
 */
function* allCycles<T>(graph: Graph<T>): Generator<T[]> {
  let successors = successorsOf(graph);
  for (const [node, targets] of successors) if (targets.includes(node)) yield [node];
  successors = new Map([...successors].map(([node, targets]) => [node, targets.filter((target) => target !== node)]));
  const position = new Map([...successors.keys()].map((node, i) => [node, i]));
  const least = (component: Set<T>) => Math.min(...[...component].map((node) => position.get(node)!));

  // A priority queue by least position; components are disjoint, so no two share one.
  const components: Array<{ least: number; component: Set<T> }> = [];
  const pushComponents = (adjacency: Graph<T>): void => {
    for (const component of stronglyConnectedComponents(adjacency)) {
      if (component.size >= 2) components.push({ least: least(component), component });
    }
    components.sort((a, b) => a.least - b.least);
  };

  pushComponents(successors);
  while (components.length > 0) {
    const { component } = components.shift()!;
    const s = [...component].reduce((a, b) => (position.get(a)! <= position.get(b)! ? a : b));
    const adjacency = new Map<T, T[]>();
    for (const node of component) adjacency.set(node, successors.get(node)!.filter((target) => component.has(target)));
    yield* cyclesThrough(adjacency, s);
    adjacency.delete(s);
    for (const [node, targets] of adjacency) adjacency.set(node, targets.filter((target) => target !== s));
    pushComponents(adjacency);
  }
}

/**
 * The elementary cycles of `graph`, each as its nodes in edge order, stopping after `limit` cycles when one is given.
 * Self-loops come first; longer cycles follow in order of their earliest node in the graph's iteration order.
 */
export function* simpleCycles<T>(graph: Graph<T>, limit?: number): Generator<T[]> {
  let found = 0;
  for (const cycle of allCycles(graph)) {
    found += 1;
    if (limit !== undefined && found > limit) return;
    yield cycle;
  }
}
