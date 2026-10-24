// Compact, token-efficient text serialisation of the a11y tree. Same grammar used
// everywhere browxai emits a tree (snapshot(), find() context, ActionResult.snapshotDelta) —
// that's the coherence constraint.

import { walk, isGenericNoise, type A11yNode } from "./a11y-types.js";
import {
  MAX_ROW_TEXT,
  TEXT_BUDGET,
  canCarryText,
  clipText,
  isDocumentRoot,
  ownText,
  ownsItsText,
} from "./snapshot-text.js";

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
  /** Maximum characters of carried text per row. Default 120. */
  maxTextLen?: number;
  /** Total characters of carried text for the whole output. Default 4000. Past
   *  it rows come out without text and a trailer line says how many. */
  textBudget?: number;
}

/** Render an A11yNode tree to the compact `role "name" [ref=eN] [state]` form. */
export function serialise(root: A11yNode, opts: SerialiseOptions = {}): string {
  const indent = opts.indent ?? "  ";
  const maxNameLen = opts.maxNameLen ?? 80;
  const pruneGeneric = opts.pruneGeneric ?? true;
  const maxNodes = opts.maxNodes ?? Infinity;
  const omitPatterns = (opts.omit ?? []).map((p) => p.toLowerCase());
  const text = newTextState(opts);

  const lines: string[] = [];
  let emitted = 0;
  let truncated = false;
  let elided = 0;
  let elidedBranches = 0;

  // Manual walk so we can prune subtrees on `omit` matches (the generator yields
  // depth-first; pruning needs to skip descendants explicitly). `visitForSerialise`
  // decides this node's disposition (skip-subtree / emit / silent-skip); the loop
  // only owns stack management. cap: each node is pushed once and the tree is finite.
  const stack: StackEntry[] = [{ node: root, depth: 0, parentRole: "", underOwner: false }];
  while (stack.length) {
    const { node, depth, parentRole, underOwner } = stack.pop()!;
    const v = visitForSerialise(node, depth, {
      omitPatterns,
      pruneGeneric,
      maxNameLen,
      indent,
      emitted,
      maxNodes,
      text,
      parentRole,
      underOwner,
    });
    elidedBranches += v.elidedBranches;
    elided += v.elided;
    if (v.truncated) truncated = true;
    if (v.line !== null) {
      lines.push(v.line);
      emitted++;
    }
    if (v.skipSubtree) continue;
    // A node that emitted no line adds no level: its children belong to the
    // nearest ancestor that did. Indenting them at `depth + 1` regardless put
    // 26 nodes on Bootstrap's docs and 90 on Hacker News at an indent that is
    // not their parent's plus one, so a spliced button read as nested under an
    // unrelated sibling.
    const childDepth = v.line === null ? depth : depth + 1;
    pushChildren(stack, node, childDepth, underOwner || ownsItsText(node.role));
  }
  lines.push(...trailerLines({ truncated, elided, elidedBranches, text }));
  return lines.join("\n");
}

/** The closing notes: what the node cap, `omit` and the text budget left out. */
function trailerLines(t: {
  truncated: boolean;
  elided: number;
  elidedBranches: number;
  text: TextState;
}): string[] {
  const out: string[] = [];
  if (t.truncated) {
    out.push(
      `... [+${t.elided} more nodes elided; raise maxNodes or pass scope=<ref> to drill in]`,
    );
  } else if (t.elidedBranches > 0) {
    out.push(`... [omit matched ${t.elidedBranches} subtree(s), ${t.elided} nodes total]`);
  }
  if (t.text.omittedRows > 0) {
    out.push(
      `... [text left off ${t.text.omittedRows} row(s) past the ${t.text.budgetTotal} character text budget; use text_search or extract to read it]`,
    );
  }
  return out;
}

function newTextState(opts: SerialiseOptions): TextState {
  const budget = opts.textBudget ?? TEXT_BUDGET;
  return {
    maxRowLen: opts.maxTextLen ?? MAX_ROW_TEXT,
    budget,
    budgetTotal: budget,
    omittedRows: 0,
  };
}

/** Push a node's children so they pop in document order. */
function pushChildren(
  stack: StackEntry[],
  node: A11yNode,
  depth: number,
  underOwner: boolean,
): void {
  for (let i = node.children.length - 1; i >= 0; i--) {
    stack.push({ node: node.children[i]!, depth, parentRole: node.role, underOwner });
  }
}

/** One stack frame of the serialise walk. `parentRole` and `underOwner` say
 *  whether this node's text can ride on its own row. */
interface StackEntry {
  node: A11yNode;
  depth: number;
  parentRole: string;
  /** An ancestor already owns its text (a link, a heading, a text field). */
  underOwner: boolean;
}

/** Running count of the carried-text budget for one `serialise` call. */
interface TextState {
  maxRowLen: number;
  budget: number;
  /** The budget the call started with, for the trailer line. */
  budgetTotal: number;
  omittedRows: number;
}

interface VisitOpts {
  omitPatterns: string[];
  pruneGeneric: boolean;
  maxNameLen: number;
  indent: string;
  emitted: number;
  maxNodes: number;
  text: TextState;
  parentRole: string;
  underOwner: boolean;
}

interface VisitResult {
  /** The formatted line to emit, or null to emit nothing for this node. */
  line: string | null;
  /** Skip the node's children (omit-match or truncation). */
  skipSubtree: boolean;
  elided: number;
  elidedBranches: number;
  truncated: boolean;
}

/** Decide one node's disposition during `serialise`: an `omit` match prunes the
 *  whole subtree, the maxNodes cap truncates, generic noise is silently dropped,
 *  otherwise the node is formatted. Pure — the loop applies the result. */
function visitForSerialise(node: A11yNode, depth: number, o: VisitOpts): VisitResult {
  if (matchesOmit(node, o.omitPatterns)) {
    return {
      line: null,
      skipSubtree: true,
      elided: countSubtree(node),
      elidedBranches: 1,
      truncated: false,
    };
  }
  const candidate = o.pruneGeneric && !o.underOwner ? candidateText(node, o.parentRole) : "";
  const noise = o.pruneGeneric && isGenericNoise(node);
  if (noise && !candidate) return SILENT;
  if (o.emitted >= o.maxNodes) {
    // this node + its descendants we'd have emitted.
    return {
      line: null,
      skipSubtree: true,
      elided: countSubtree(node),
      elidedBranches: 0,
      truncated: true,
    };
  }
  const text = candidate ? spendText(candidate, o.text) : undefined;
  if (noise && text === undefined) return SILENT;
  return {
    line: formatNode(node, depth, o.indent, o.maxNameLen, text),
    skipSubtree: false,
    elided: 0,
    elidedBranches: 0,
    truncated: false,
  };
}

const SILENT: VisitResult = {
  line: null,
  skipSubtree: false,
  elided: 0,
  elidedBranches: 0,
  truncated: false,
};

/** The text this node would put on its row, before the budget. A nameless
 *  container reads its own `StaticText` children. A `StaticText` directly under
 *  the document root has no container to ride on, so it is a row itself. */
function candidateText(node: A11yNode, parentRole: string): string {
  if (node.role === "StaticText") {
    if (node.testId || !isDocumentRoot(parentRole)) return "";
    return (node.name ?? "").replace(/\s+/g, " ").trim();
  }
  return canCarryText(node) ? ownText(node) : "";
}

/** Clip `candidate` to the row cap and what is left of the budget. Returns
 *  undefined, and counts the row, when the budget is spent. */
function spendText(candidate: string, state: TextState): string | undefined {
  if (state.budget <= 0) {
    state.omittedRows++;
    return undefined;
  }
  const clipped = clipText(candidate, Math.min(state.maxRowLen, state.budget));
  state.budget -= clipped.length;
  return clipped;
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

function formatNode(
  node: A11yNode,
  depth: number,
  indent: string,
  maxNameLen: number,
  text?: string,
): string {
  const pad = indent.repeat(depth);
  // Carried text rides where a name would. A node that has a name never gets
  // text (see `canCarryText`), so the two cannot collide.
  const nm =
    text !== undefined ? ` "${text}"` : node.name ? ` "${truncate(node.name, maxNameLen)}"` : "";
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
