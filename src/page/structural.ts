// Structural-context detector.
//
// Annotates A11yNode entries with `context: { collection, rowKey, column,
// rowText }` when they live inside a recognised repeated layout (semantic
// table/grid, list, feed). Detection is driven by ARIA roles — generic across
// any web app, no per-target heuristics.
//
// Detection precedence (per node):
//   1. ancestor chain contains `role=row`           → row context, column from header alignment
//   2. ancestor chain contains `role=listitem`      → list context
//   3. ancestor chain contains `role=article` whose siblings are also `role=article`
//                                                    → feed/card context
// Otherwise: no annotation (the field stays undefined).

import { walk, type A11yNode, type StructuralContext } from "./a11y.js";

const COLLECTION_ROLES = new Set(["table", "grid", "treegrid", "rowgroup", "list", "feed"]);
const ROW_ROLE = "row";
const CELL_ROLES = new Set(["cell", "gridcell", "rowheader"]);

/**
 * Walk the tree once and tag each descendant of a recognised repeated
 * container with its structural context. Mutates nodes in place.
 *
 * Idempotent — re-running on the same tree produces the same annotations
 * (each node's `context` is overwritten with the freshly computed value).
 */
export function annotateStructuralContext(tree: A11yNode): void {
  const parents = new Map<A11yNode, A11yNode>();
  const ancestors = new Map<A11yNode, A11yNode[]>();
  ancestors.set(tree, []);
  for (const { node } of walk(tree)) {
    const chain = ancestors.get(node) ?? [];
    for (const c of node.children) {
      parents.set(c, node);
      ancestors.set(c, [node, ...chain]);
    }
  }

  // Pre-compute column headers per collection root. Look for the first child
  // row whose cells are all `role=columnheader` — that's the header row.
  const columnHeadersByRoot = new Map<A11yNode, string[]>();
  for (const { node: root } of walk(tree)) {
    if (!COLLECTION_ROLES.has(root.role)) continue;
    const headerRow = findHeaderRow(root);
    if (!headerRow) continue;
    columnHeadersByRoot.set(
      root,
      headerRow.children
        .filter((c) => c.role === "columnheader")
        .map((c) => (c.name ?? "").trim()),
    );
  }

  for (const { node } of walk(tree)) {
    const chain = ancestors.get(node);
    if (!chain) continue;
    const row = findRowContainer(node, chain);
    if (!row) continue;

    const collectionRoot = nearestCollectionRoot(row, parents);
    const collection = collectionRoot
      ? collectionRoot.role
      : `${row.role}-list`;

    const rowText = collectVisibleText(row, 200);
    const rowKey = firstNonEmptyName(row);

    let column: string | undefined;
    if (collectionRoot && columnHeadersByRoot.has(collectionRoot)) {
      const headers = columnHeadersByRoot.get(collectionRoot)!;
      // Find the index of the cell ancestor (or `node` itself) within `row`.
      const cellAncestor = chain.find((a) => CELL_ROLES.has(a.role)) ?? (CELL_ROLES.has(node.role) ? node : undefined);
      if (cellAncestor) {
        const idx = row.children.indexOf(cellAncestor);
        if (idx >= 0 && idx < headers.length) column = headers[idx] || undefined;
      }
    }

    const ctx: StructuralContext = { collection };
    if (rowKey) ctx.rowKey = rowKey;
    if (column) ctx.column = column;
    if (rowText) ctx.rowText = rowText;
    node.context = ctx;
  }
}

function findRowContainer(node: A11yNode, ancestorChain: A11yNode[]): A11yNode | undefined {
  // `node` itself qualifies if it's a row/listitem — agents often act on the row.
  if (node.role === ROW_ROLE || node.role === "listitem" || isArticleInFeed(node, ancestorChain)) {
    return node;
  }
  for (const a of ancestorChain) {
    if (a.role === ROW_ROLE) return a;
    if (a.role === "listitem") return a;
    if (isArticleInFeed(a, ancestorChain)) return a;
  }
  return undefined;
}

function isArticleInFeed(node: A11yNode, chain: A11yNode[]): boolean {
  if (node.role !== "article") return false;
  // Only treat `article` as a row when the chain shows a `feed` ancestor —
  // otherwise a standalone article isn't a repeated container.
  return chain.some((a) => a.role === "feed");
}

function nearestCollectionRoot(row: A11yNode, parents: Map<A11yNode, A11yNode>): A11yNode | undefined {
  let cur: A11yNode | undefined = parents.get(row);
  while (cur) {
    if (COLLECTION_ROLES.has(cur.role)) return cur;
    cur = parents.get(cur);
  }
  return undefined;
}

function findHeaderRow(root: A11yNode): A11yNode | undefined {
  // Search at most two levels deep for a row whose children are all
  // `columnheader`s (skip nested rowgroups gracefully).
  const queue: Array<{ node: A11yNode; depth: number }> = [{ node: root, depth: 0 }];
  while (queue.length) {
    const { node, depth } = queue.shift()!;
    if (node.role === ROW_ROLE && node.children.some((c) => c.role === "columnheader")) {
      return node;
    }
    if (depth < 2) {
      for (const c of node.children) queue.push({ node: c, depth: depth + 1 });
    }
  }
  return undefined;
}

function firstNonEmptyName(row: A11yNode): string | undefined {
  for (const { node } of walk(row)) {
    const n = (node.name ?? "").trim();
    if (n) return n.length > 80 ? n.slice(0, 79) + "…" : n;
  }
  return undefined;
}

function collectVisibleText(node: A11yNode, max: number): string {
  const parts: string[] = [];
  for (const { node: n } of walk(node)) {
    const name = (n.name ?? "").trim();
    if (name) parts.push(name);
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!joined) return "";
  return joined.length > max ? joined.slice(0, max - 1) + "…" : joined;
}
