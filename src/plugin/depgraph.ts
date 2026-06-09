// Dependency-graph machinery for the plugin runtime.
//
// At server start, the resolver materialises each plugin's manifest and
// hands the runtime a `{plugin -> dependsOn[].plugin}` adjacency. This
// module:
//   - Composes those edges into a directed graph.
//   - Detects cycles via Tarjan's SCC pass (loudly: every plugin in any
//     non-trivial SCC is named in the error so an adopter can fix it
//     without re-running with verbose logs).
//   - Topo-sorts the rest so the runtime loads deps before dependents.
//   - Exposes per-plugin transitive `dependsOn` closures used by the
//     runtime's call-graph enforcement (a plugin may call any tool
//     belonging to a plugin in its TRANSITIVELY-resolved dep set,
//     plus any core browxai tool).
//
// Kept dep-free — node:built-ins only.

export interface DepGraphInput {
  /** Plugin name → list of plugin names it depends on (declared, direct). */
  readonly directDeps: ReadonlyMap<string, ReadonlyArray<string>>;
}

export interface DepGraphResult {
  /**
   * Plugin names in load order (deps before dependents). Acyclic graphs
   * always produce a result; cyclic ones throw.
   */
  readonly loadOrder: ReadonlyArray<string>;
  /**
   * For each plugin, the FULL transitive set of plugins it may call into
   * (its declared dependsOn, plus everything those deps reach). Does NOT
   * include the plugin itself — a plugin calling its own tools is
   * trivially allowed at the call-graph layer.
   */
  readonly transitiveDeps: ReadonlyMap<string, ReadonlySet<string>>;
}

export class DepGraphCycleError extends Error {
  constructor(public readonly cycles: ReadonlyArray<ReadonlyArray<string>>) {
    const summary = cycles.map((c) => c.join(" → ")).join("; ");
    super(
      `plugin runtime: dep-graph contains ${cycles.length} cycle(s) — refusing to load any plugin. ` +
        `Cycles: ${summary}. Resolve by removing one direction of each cycle from the offending plugin manifest(s).`,
    );
    this.name = "DepGraphCycleError";
  }
}

/**
 * Build the dep graph result. Throws {@link DepGraphCycleError} if any
 * non-trivial strongly-connected component is found. The error names
 * every plugin in every cycle.
 *
 * Self-edges (`pluginA -> pluginA`) are tolerated and ignored — a
 * self-edge encodes "this plugin can call its own tools" which is
 * always-true and harmless.
 *
 * Edges pointing at plugins that aren't in `directDeps.keys()` are
 * tolerated at this layer; the runtime separately validates that
 * dependsOn targets exist + satisfy their semver range. We only model
 * what's in the graph here.
 */
export function buildDepGraph(input: DepGraphInput): DepGraphResult {
  const nodes = [...input.directDeps.keys()];
  // Filter edges to self-edges-out + missing-target-out, since either
  // poses no cycle risk + is reported elsewhere.
  const edges = new Map<string, ReadonlyArray<string>>();
  for (const node of nodes) {
    const deps = input.directDeps.get(node) ?? [];
    const filtered = deps.filter((d) => d !== node && input.directDeps.has(d));
    edges.set(node, filtered);
  }

  const cycles = findCycles(nodes, edges);
  if (cycles.length > 0) throw new DepGraphCycleError(cycles);

  const loadOrder = topoSort(nodes, edges);
  const transitiveDeps = computeTransitiveDeps(loadOrder, edges);
  return { loadOrder, transitiveDeps };
}

/**
 * Tarjan's strongly-connected-components algorithm. A non-trivial SCC
 * (size > 1) is a cycle; a self-edge in a single-node SCC would also
 * count but we strip those above so a single-node SCC is always trivial.
 *
 * Output is the list of cycles, each cycle being its members in the
 * order they appear in the SCC.
 */
function findCycles(
  nodes: ReadonlyArray<string>,
  edges: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> {
  let index = 0;
  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const strongconnect = (v: string): void => {
    indexOf.set(v, index);
    lowlink.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of edges.get(v) ?? []) {
      if (!indexOf.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indexOf.get(w)!));
      }
    }

    if (lowlink.get(v) === indexOf.get(v)) {
      const component: string[] = [];
      // pop until we pop v

      while (true) {
        const w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      if (component.length > 1) cycles.push(component.reverse());
    }
  };

  for (const v of nodes) {
    if (!indexOf.has(v)) strongconnect(v);
  }
  return cycles;
}

/**
 * Stable topological sort (Kahn-style). The input is assumed acyclic
 * (the caller ran `findCycles` first). Within each "indegree==0" cohort
 * we sort lexicographically so the load order is deterministic across
 * runs / hosts.
 */
function topoSort(
  nodes: ReadonlyArray<string>,
  edges: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<string> {
  const indegree = new Map<string, number>();
  for (const n of nodes) indegree.set(n, 0);
  for (const [, deps] of edges) {
    for (const d of deps) {
      // Edge n -> d means "n depends on d" — d must load first, so d
      // gets an outgoing edge to n in the LOAD graph. Equivalently:
      // each n we visit increments its OWN indegree by the count of
      // not-yet-loaded deps it has. Cleaner: walk in reverse — process
      // a node once all its deps have been processed.
      void d;
    }
  }
  // Compute indegree from the dependency direction. A node's "indegree"
  // for load purposes is the number of deps that haven't loaded yet.
  for (const [n, deps] of edges) indegree.set(n, deps.length);

  const ready: string[] = [];
  for (const [n, deg] of indegree) {
    if (deg === 0) ready.push(n);
  }
  ready.sort();

  const result: string[] = [];
  // Reverse-edge map so we can decrement dependents when a node loads.
  const dependents = new Map<string, string[]>();
  for (const n of nodes) dependents.set(n, []);
  for (const [n, deps] of edges) {
    for (const d of deps) {
      dependents.get(d)?.push(n);
    }
  }

  while (ready.length > 0) {
    const next = ready.shift()!;
    result.push(next);
    for (const dep of dependents.get(next) ?? []) {
      const left = (indegree.get(dep) ?? 0) - 1;
      indegree.set(dep, left);
      if (left === 0) {
        // Insert sorted.
        let i = 0;
        while (i < ready.length && ready[i]! < dep) i += 1;
        ready.splice(i, 0, dep);
      }
    }
  }

  if (result.length !== nodes.length) {
    // Shouldn't happen — cycles would have been caught above. Defensive.
    throw new Error(
      `plugin runtime: topo-sort failed (loaded ${result.length} of ${nodes.length}). Re-run with diagnostics on.`,
    );
  }
  return result;
}

/**
 * For each plugin, compute the FULL transitive set of plugins it
 * depends on. Walks the load order (deps-first) so each plugin can
 * look up its already-computed dep closures.
 */
function computeTransitiveDeps(
  loadOrder: ReadonlyArray<string>,
  edges: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, ReadonlySet<string>>();
  for (const n of loadOrder) {
    const closure = new Set<string>();
    for (const d of edges.get(n) ?? []) {
      closure.add(d);
      for (const t of result.get(d) ?? new Set<string>()) closure.add(t);
    }
    result.set(n, closure);
  }
  return result;
}
