// ActionResult builder. Wraps a single action with the action-window machinery
// (network tap, console slice, navigation detection, structure diff, post-snapshot)
// and emits the structured result documented in docs/phase-1-design.md §3.
//
// Phase-1 simplification: `snapshotDelta.mode = "scoped_snapshot"` (default) currently
// returns the *full* a11y tree with a warning noting that scope-down is pending.
// The always-on cheap signals (navigation / structure / console / pageErrors / element)
// are real. `tree_diff` is a Phase-1.5 follow-on.

import type { CDPSession, Page } from "playwright-core";
import { getA11yTree, walk, type A11yNode } from "./a11y.js";
import type { RefRegistry } from "./refs.js";
import { serialise } from "./snapshot.js";
import { NetworkTap, type NetworkEntry, type NetworkSummary } from "./network.js";
import { ConsoleBuffer } from "./console.js";
import { truncateToBudget, estimateTokens } from "../util/tokens.js";

export type SnapshotMode = "scoped_snapshot" | "tree_diff" | "full" | "none";

export interface ActionDescriptor {
  type: string;
  ref?: string;
  selector?: string;
  value?: string;
  url?: string;
}

export interface ElementProbe {
  ref?: string;
  stillAttached: boolean;
  focused?: boolean;
  checked?: boolean | "mixed";
  value?: string | null;
}

export interface ActionResult {
  ok: boolean;
  action: ActionDescriptor;
  navigation: {
    changed: boolean;
    from: string;
    to: string;
    kind: "full_load" | "spa" | "hash" | null;
  };
  structure: {
    appeared: Array<{ role: string; name?: string; ref: string }>;
    removed: Array<{ role: string; name?: string; ref: string }>;
    newTabs: Array<{ url: string; title: string }>;
  };
  console: { errors: string[]; warnings: number };
  pageErrors: string[];
  element?: ElementProbe;
  snapshotDelta?: {
    mode: SnapshotMode;
    scope: string;
    tree?: string;
    truncated: boolean;
  };
  network: { summary: NetworkSummary; requests?: NetworkEntry[] };
  tokensEstimate: number;
  warnings: string[];
  error?: string;
}

export interface ActionContext {
  page: Page;
  cdp: CDPSession;
  refs: RefRegistry;
  console: ConsoleBuffer;
  pages: () => Page[]; // for newTabs detection (Playwright BrowserContext.pages())
  /** Configured test-attribute list (sourced from BROWX_TEST_ATTRIBUTES). Threaded
   *  through so pre/post a11y trees pick up the same testIds the canonical surface uses. */
  testAttributes: string[];
}

export interface ActionWindowOptions {
  mode?: SnapshotMode;
  /** Approx output budget for the elastic part of the result (snapshotDelta.tree). */
  maxResultTokens?: number;
  /** Cap on per-request rows in `network.requests`; default 10. */
  networkRequestCap?: number;
  /** Post-dispatch settle delay in ms — let CDP events / framework reconciliations drain. */
  settleMs?: number;
}

/**
 * Run an action inside the action-window machinery.
 *
 *   await runInActionWindow(ctx, descriptor, opts, async () => locator.click());
 *
 * The caller's body dispatches the action; this function records pre-state,
 * waits for settle, records post-state, and builds the ActionResult.
 */
export async function runInActionWindow(
  ctx: ActionContext,
  descriptor: ActionDescriptor,
  opts: ActionWindowOptions,
  body: () => Promise<ElementProbe | void>,
): Promise<ActionResult> {
  const mode: SnapshotMode = opts.mode ?? "scoped_snapshot";
  const maxTokens = opts.maxResultTokens ?? 600;
  const requestCap = opts.networkRequestCap ?? 10;
  const settleMs = opts.settleMs ?? 400;
  const warnings: string[] = [];

  // --- pre-state ---
  const urlBefore = ctx.page.url();
  const tabsBefore = new Set(ctx.pages().map((p) => p.url()));
  const tBefore = Date.now();
  const preTree = await getA11yTree(ctx.cdp, ctx.refs, ctx.testAttributes).catch(() => null);
  const preRegions = preTree ? topLevelRegions(preTree) : new Map();

  // Track full-load via Page.frameNavigated on the main frame.
  let frameNavigatedMain = false;
  const onFrameNav = (e: { frame: { parentId?: string } }) => {
    if (!e.frame.parentId) frameNavigatedMain = true;
  };
  ctx.cdp.on("Page.frameNavigated" as never, onFrameNav as never);
  await ctx.cdp.send("Page.enable").catch(() => undefined);

  const net = new NetworkTap(ctx.cdp);
  await net.open();

  // --- dispatch ---
  let ok = true;
  let error: string | undefined;
  let elementProbe: ElementProbe | undefined;
  try {
    const probe = await body();
    if (probe) elementProbe = probe;
  } catch (e) {
    ok = false;
    error = e instanceof Error ? e.message : String(e);
  }

  // --- settle ---
  await sleep(settleMs);
  try { await ctx.page.waitForLoadState("networkidle", { timeout: 1500 }); } catch { /* noisy SPAs never idle */ }

  // --- post-state ---
  ctx.cdp.off("Page.frameNavigated" as never, onFrameNav as never);
  const urlAfter = ctx.page.url();
  const postTree = await getA11yTree(ctx.cdp, ctx.refs, ctx.testAttributes).catch(() => null);
  const postRegions = postTree ? topLevelRegions(postTree) : new Map();
  const network = net.close();

  // --- shape ---
  const navigation = describeNavigation(urlBefore, urlAfter, frameNavigatedMain);
  const structure = diffRegions(preRegions, postRegions);
  for (const p of ctx.pages()) {
    if (!tabsBefore.has(p.url())) {
      structure.newTabs.push({ url: p.url(), title: await p.title().catch(() => "") });
    }
  }
  const consoleSlice = {
    errors: ctx.console.errorsSince(tBefore),
    warnings: ctx.console.warningCountSince(tBefore),
  };
  const pageErrors = ctx.console.pageErrorsSince(tBefore);

  const snapshotDelta = buildSnapshotDelta(mode, postTree, maxTokens, warnings);
  const networkBlock = network.summary.total > 0
    ? (network.requests.length <= requestCap
        ? { summary: network.summary, requests: network.requests }
        : (warnings.push(`network.requests omitted (count ${network.requests.length} > cap ${requestCap}); call network_read for details`), { summary: network.summary }))
    : { summary: network.summary };

  const tokensEstimate = estimateTokens(JSON.stringify({
    navigation, structure, console: consoleSlice, pageErrors, snapshotDelta, network: networkBlock,
  }));

  return {
    ok,
    action: descriptor,
    navigation,
    structure,
    console: consoleSlice,
    pageErrors,
    element: elementProbe,
    snapshotDelta,
    network: networkBlock,
    tokensEstimate,
    warnings,
    error,
  };
}

function topLevelRegions(tree: A11yNode): Map<string, { role: string; name?: string; ref: string }> {
  // "Top-level regions" = nodes whose role indicates a page-level appearance
  // (dialog, alert, alertdialog, status, banner, etc.) anywhere in the tree.
  const out = new Map<string, { role: string; name?: string; ref: string }>();
  const interesting = new Set([
    "dialog", "alertdialog", "alert", "status", "banner", "complementary",
    "tablist", "menu", "menubar", "tooltip", "toolbar",
  ]);
  for (const { node } of walk(tree)) {
    if (interesting.has(node.role)) {
      out.set(node.ref, { role: node.role, name: node.name, ref: node.ref });
    }
  }
  return out;
}

function diffRegions(
  pre: Map<string, { role: string; name?: string; ref: string }>,
  post: Map<string, { role: string; name?: string; ref: string }>,
): { appeared: Array<{ role: string; name?: string; ref: string }>; removed: Array<{ role: string; name?: string; ref: string }>; newTabs: Array<{ url: string; title: string }> } {
  const appeared: Array<{ role: string; name?: string; ref: string }> = [];
  const removed: Array<{ role: string; name?: string; ref: string }> = [];
  for (const [ref, r] of post) if (!pre.has(ref)) appeared.push(r);
  for (const [ref, r] of pre) if (!post.has(ref)) removed.push(r);
  return { appeared, removed, newTabs: [] };
}

function describeNavigation(
  from: string,
  to: string,
  frameNavigated: boolean,
): ActionResult["navigation"] {
  if (from === to) return { changed: false, from, to, kind: null };
  try {
    const a = new URL(from);
    const b = new URL(to);
    if (a.origin === b.origin && a.pathname === b.pathname && a.search === b.search && a.hash !== b.hash) {
      return { changed: true, from, to, kind: "hash" };
    }
  } catch {/* invalid URL — fall through */}
  return { changed: true, from, to, kind: frameNavigated ? "full_load" : "spa" };
}

function buildSnapshotDelta(
  mode: SnapshotMode,
  tree: A11yNode | null,
  maxTokens: number,
  warnings: string[],
): ActionResult["snapshotDelta"] {
  if (mode === "none") return undefined;
  if (!tree) {
    return { mode, scope: "(no tree)", truncated: false };
  }
  let scope: string;
  let renderMode: SnapshotMode = mode;
  if (mode === "tree_diff") {
    warnings.push("mode=tree_diff not implemented in Phase 1; emitting scoped_snapshot instead");
    renderMode = "scoped_snapshot";
  }
  if (renderMode === "scoped_snapshot") {
    warnings.push("scoped_snapshot currently returns the full tree; scoping is a Phase-1.5 refinement");
    scope = "full (Phase-1)";
  } else {
    scope = "full";
  }
  const full = serialise(tree);
  const { text, truncated } = truncateToBudget(full, maxTokens);
  if (truncated) warnings.push(`snapshotDelta truncated to fit maxResultTokens=${maxTokens}; call snapshot() for the complete tree`);
  return { mode: renderMode, scope, tree: text, truncated };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
