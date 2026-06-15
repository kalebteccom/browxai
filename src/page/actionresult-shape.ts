// ActionResult shape helpers — the pure tree/navigation/console shaping the
// action window composes. Split out of actionresult.ts to keep that file under
// the size budget; every function is behavior-identical to its prior inline form
// (no page contact, deterministic over already-captured inputs).

import { walk, type A11yNode } from "./a11y.js";
import { findByRef, serialise } from "./snapshot.js";
import { truncateToBudget } from "../util/tokens.js";

/** A page-level landmark region (dialog / alert / banner / …) tracked across the
 *  action window to diff appeared/removed structure. */
export type Region = { role: string; name?: string; ref: string };

export type SnapshotMode = "scoped_snapshot" | "tree_diff" | "full" | "none";

export interface NavigationInfo {
  changed: boolean;
  from: string;
  to: string;
  kind: "hash" | "full_load" | "spa" | null;
}

export interface SnapshotDeltaInfo {
  mode: SnapshotMode;
  scope: string;
  tree?: string;
  truncated: boolean;
}

export interface RegionDiff {
  appeared: Region[];
  removed: Region[];
  newTabs: Array<{ url: string; title: string }>;
}

const INTERESTING_REGION_ROLES = new Set([
  "dialog",
  "alertdialog",
  "alert",
  "status",
  "banner",
  "complementary",
  "tablist",
  "menu",
  "menubar",
  "tooltip",
  "toolbar",
]);

export function topLevelRegions(tree: A11yNode): Map<string, Region> {
  // "Top-level regions" = nodes whose role indicates a page-level appearance
  // (dialog, alert, alertdialog, status, banner, etc.) anywhere in the tree.
  const out = new Map<string, Region>();
  for (const { node } of walk(tree)) {
    if (INTERESTING_REGION_ROLES.has(node.role)) {
      out.set(node.ref, { role: node.role, name: node.name, ref: node.ref });
    }
  }
  return out;
}

export function diffRegions(pre: Map<string, Region>, post: Map<string, Region>): RegionDiff {
  const appeared: Region[] = [];
  const removed: Region[] = [];
  for (const [ref, r] of post) if (!pre.has(ref)) appeared.push(r);
  for (const [ref, r] of pre) if (!post.has(ref)) removed.push(r);
  return { appeared, removed, newTabs: [] };
}

export function describeNavigation(
  from: string,
  to: string,
  frameNavigated: boolean,
): NavigationInfo {
  if (from === to) return { changed: false, from, to, kind: null };
  try {
    const a = new URL(from);
    const b = new URL(to);
    if (
      a.origin === b.origin &&
      a.pathname === b.pathname &&
      a.search === b.search &&
      a.hash !== b.hash
    ) {
      return { changed: true, from, to, kind: "hash" };
    }
  } catch {
    /* invalid URL — fall through */
  }
  return { changed: true, from, to, kind: frameNavigated ? "full_load" : "spa" };
}

/** Serialise the scoped subtrees for the snapshotDelta, truncated to the token
 *  budget. When no scope ref resolved in the post-tree, returns a tiny
 *  scope-marker delta instead of the full tree. */
function serialiseScopedSubtrees(
  tree: A11yNode,
  scopeRefs: string[],
  maxTokens: number,
  warnings: string[],
): SnapshotDeltaInfo {
  const subtrees = scopeRefs
    .map((ref) => findByRef(tree, ref))
    .filter((n): n is A11yNode => n !== null);
  if (subtrees.length === 0) {
    // All scope refs gone — element vanished + no appeared regions. Fall through
    // to a tiny scope marker instead of the full tree.
    return { mode: "scoped_snapshot", scope: "(scope refs not present in post-tree)", truncated: false };
  }
  const text = subtrees
    .map(
      (n, i) =>
        (subtrees.length > 1 ? `--- subtree ${i + 1}/${subtrees.length} ---\n` : "") + serialise(n),
    )
    .join("\n");
  const { text: trimmed, truncated } = truncateToBudget(text, maxTokens);
  if (truncated)
    warnings.push(
      `snapshotDelta truncated to fit maxResultTokens=${maxTokens}; call snapshot() for the complete tree`,
    );
  return {
    mode: "scoped_snapshot",
    scope: `scoped to ${subtrees.length} subtree(s) [${scopeRefs.join(", ")}]`,
    tree: trimmed,
    truncated,
  };
}

export function buildSnapshotDelta(
  mode: SnapshotMode,
  tree: A11yNode | null,
  maxTokens: number,
  warnings: string[],
  /** refs to scope the delta to (action's ref + appeared regions).
   *  When empty + mode=scoped_snapshot, falls back to the full tree as before. */
  scopeRefs: string[] = [],
): SnapshotDeltaInfo | undefined {
  if (mode === "none") return undefined;
  if (!tree) return { mode, scope: "(no tree)", truncated: false };
  let renderMode: SnapshotMode = mode;
  if (mode === "tree_diff") {
    //  partial: emit appeared/removed-as-subtrees instead of a unified diff.
    // Closer in spirit to Vercel agent-browser's diff than the previous fallback,
    // without needing the line-stable cross-snapshot diff plumbing.
    warnings.push(
      'mode=tree_diff: emitting appeared-region subtrees only (full unified diff not yet implemented; pass mode:"full" for the post-action tree)',
    );
    renderMode = "scoped_snapshot";
  }

  if (renderMode === "scoped_snapshot" && scopeRefs.length > 0) {
    // real scope-down. Serialise just the action's element subtree + any
    // newly-appeared top-level regions. Drops 7-10k-token snapshots to ~500-1500
    // on the heavy-SPA / many-elements shape.
    return serialiseScopedSubtrees(tree, scopeRefs, maxTokens, warnings);
  }

  // Fall-through: full tree. Honours explicit mode:"full" and the rare case where
  // scoped_snapshot was asked-for but we have no scope refs (no action ref, no
  // appeared regions — uncommon).
  const scope = renderMode === "scoped_snapshot" ? "full (no scope refs)" : "full";
  const { text, truncated } = truncateToBudget(serialise(tree), maxTokens);
  if (truncated)
    warnings.push(
      `snapshotDelta truncated to fit maxResultTokens=${maxTokens}; call snapshot() for the complete tree`,
    );
  return { mode: renderMode, scope, tree: text, truncated };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ConsoleSlice {
  errors: string[];
  warnings: number;
  truncated_chars?: number;
}

const ERROR_MAX_CHARS_PER = 400;
const ERROR_MAX_TOTAL_ENTRIES = 20;

/** Inline summary of console errors — collapse multi-line stack-traces to their
 *  first line + a token-budget per error, and emit `truncated_chars` if any were
 *  trimmed. The full text is still in the session's `ConsoleBuffer`; an agent who
 *  needs it calls `console_read`. Pattern mirrors the existing
 *  `network.requests omitted (count N > cap)` design. */
export function summariseConsoleErrors(errors: string[], warnings: string[]): ConsoleSlice {
  if (errors.length === 0) return { errors: [], warnings: 0 };
  let trimmed = 0;
  const out: string[] = [];
  const slice = errors.slice(0, ERROR_MAX_TOTAL_ENTRIES);
  for (const e of slice) {
    if (e.length <= ERROR_MAX_CHARS_PER && !e.includes("\n")) {
      out.push(e);
      continue;
    }
    const firstLine = e.split("\n")[0]!.slice(0, ERROR_MAX_CHARS_PER);
    out.push(firstLine + " …");
    trimmed += Math.max(0, e.length - firstLine.length);
  }
  if (errors.length > ERROR_MAX_TOTAL_ENTRIES) {
    warnings.push(
      `console.errors truncated (showing ${ERROR_MAX_TOTAL_ENTRIES} of ${errors.length}); call console_read for the full ring buffer`,
    );
  }
  const result: ConsoleSlice = { errors: out, warnings: 0 };
  if (trimmed > 0) {
    result.truncated_chars = trimmed;
    warnings.push(
      `console.errors stack-traces summarised (${trimmed} chars trimmed); call console_read for the full text`,
    );
  }
  return result;
}
