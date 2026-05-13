// Compact, token-efficient text serialisation of the a11y tree. Same grammar used
// everywhere browxai emits a tree (snapshot(), find() context, ActionResult.snapshotDelta) —
// that's the coherence constraint, see docs/phase-1-design.md §2.

import { walk, type A11yNode } from "./a11y.js";

export interface SerialiseOptions {
  /** Indent string per depth level. Default `"  "`. */
  indent?: string;
  /** Maximum characters of `name` to keep per node. Default 80. */
  maxNameLen?: number;
  /** If true, drop generic / presentational nodes that contribute nothing. */
  pruneGeneric?: boolean;
}

/** Render an A11yNode tree to the compact `role "name" [ref=eN] [state]` form. */
export function serialise(root: A11yNode, opts: SerialiseOptions = {}): string {
  const indent = opts.indent ?? "  ";
  const maxNameLen = opts.maxNameLen ?? 80;
  const pruneGeneric = opts.pruneGeneric ?? true;

  const lines: string[] = [];
  for (const { node, depth } of walk(root)) {
    if (pruneGeneric && isGenericNoise(node)) continue;
    lines.push(formatNode(node, depth, indent, maxNameLen));
  }
  return lines.join("\n");
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
  const src = node.source === "dom"
    ? " [from-dom]"
    : node.source === "both"
      ? " [from-both]"
      : "";
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
