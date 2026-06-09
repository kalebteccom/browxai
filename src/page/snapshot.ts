// Compact, token-efficient text serialisation of the a11y tree. Same grammar used
// everywhere browxai emits a tree (snapshot(), find() context, ActionResult.snapshotDelta) —
// that's the coherence constraint.

import { walk, type A11yNode } from "./a11y.js";

export interface SerialiseOptions {
  /** Indent string per depth level. Default `"  "`. */
  indent?: string;
  /** Maximum characters of `name` to keep per node. Default 80. */
  maxNameLen?: number;
  /** If true, drop generic / presentational nodes that contribute nothing. */
  pruneGeneric?: boolean;
  /** cap on emitted lines. When exceeded, the serialisation cuts
   *  off and appends `... [+N more nodes elided]`. */
  maxNodes?: number;
  /** case-insensitive substring patterns matched against each node's
   *  `role`, `name`, or `testId`. A matching node *and its entire subtree* is skipped.
   *  Useful for omitting known-noisy regions (long lists, virtualised tables). */
  omit?: string[];
}

/** Render an A11yNode tree to the compact `role "name" [ref=eN] [state]` form. */
export function serialise(root: A11yNode, opts: SerialiseOptions = {}): string {
  const indent = opts.indent ?? "  ";
  const maxNameLen = opts.maxNameLen ?? 80;
  const pruneGeneric = opts.pruneGeneric ?? true;
  const maxNodes = opts.maxNodes ?? Infinity;
  const omitPatterns = (opts.omit ?? []).map((p) => p.toLowerCase());

  const lines: string[] = [];
  let emitted = 0;
  let truncated = false;
  let elided = 0;
  let elidedBranches = 0;

  // Manual walk so we can prune subtrees on `omit` matches (the generator yields
  // depth-first; pruning needs to skip descendants explicitly).
  const stack: Array<{ node: A11yNode; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (matchesOmit(node, omitPatterns)) {
      elidedBranches++;
      elided += countSubtree(node);
      continue;
    }
    if (!(pruneGeneric && isGenericNoise(node))) {
      if (emitted >= maxNodes) {
        truncated = true;
        elided += 1 + countSubtree(node) - 1; // this node + its descendants we'd have emitted
        continue;
      }
      lines.push(formatNode(node, depth, indent, maxNameLen));
      emitted++;
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i]!, depth: depth + 1 });
    }
  }
  if (truncated)
    lines.push(
      `... [+${elided} more nodes elided; raise maxNodes or pass scope=<ref> to drill in]`,
    );
  if (elidedBranches > 0 && !truncated) {
    lines.push(`... [omit matched ${elidedBranches} subtree(s), ${elided} nodes total]`);
  }
  return lines.join("\n");
}

function matchesOmit(node: A11yNode, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const hay = `${node.role}|${node.name ?? ""}|${node.testId ?? ""}`.toLowerCase();
  return patterns.some((p) => hay.includes(p));
}

function countSubtree(node: A11yNode): number {
  let n = 1;
  for (const c of node.children) n += countSubtree(c);
  return n;
}

/**
 * Find a subtree by ref. Returns the matching node (or null) so callers can
 * `serialise(findByRef(tree, "e42"), { … })` for scoped snapshots.
 */
export function findByRef(root: A11yNode, ref: string): A11yNode | null {
  for (const { node } of walk(root)) {
    if (node.ref === ref) return node;
  }
  return null;
}

function formatNode(node: A11yNode, depth: number, indent: string, maxNameLen: number): string {
  const pad = indent.repeat(depth);
  const nm = node.name ? ` "${truncate(node.name, maxNameLen)}"` : "";
  // Emit the actual attribute name (e.g. `[data-testid="…"]` or `[data-type="…"]`) so
  // the agent can transcribe it directly. Falls back to `data-testid` when the source
  // didn't tell us which attr matched.
  const tid = node.testId
    ? ` [${node.testIdAttr ?? "data-testid"}=${JSON.stringify(node.testId)}]`
    : "";
  const src = node.source === "dom" ? " [from-dom]" : node.source === "both" ? " [from-both]" : "";
  return `${pad}${node.role}${nm} [ref=${node.ref}]${tid}${src}${fmtState(node)}`;
}

export function fmtState(n: A11yNode): string {
  const bits: string[] = [];
  if (n.disabled) bits.push("disabled");
  if (n.checked !== undefined) bits.push(`checked=${n.checked}`);
  if (n.pressed !== undefined) bits.push(`pressed=${n.pressed}`);
  if (n.selected) bits.push("selected");
  if (n.expanded !== undefined) bits.push(`expanded=${n.expanded}`);
  if (n.focused) bits.push("focused");
  if (n.value !== undefined && n.value !== "") {
    bits.push(`value=${JSON.stringify(String(n.value).slice(0, 60))}`);
  }
  return bits.length ? ` [${bits.join(", ")}]` : "";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * Drop generic / presentational nodes that carry no agent signal:
 * - role "generic" / "presentation" with no name and no testId
 * - role "none"
 * - "text" leaves with no name (i.e. empty)
 * These nodes still let their *children* through (caller walks the tree); we
 * just skip emitting a line for them.
 */
function isGenericNoise(n: A11yNode): boolean {
  if (n.testId) return false;
  if (n.role === "none") return true;
  if ((n.role === "generic" || n.role === "presentation") && !n.name) return true;
  if (n.role === "StaticText" && !n.name) return true;
  return false;
}
