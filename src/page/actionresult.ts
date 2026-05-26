// ActionResult builder. Wraps a single action with the action-window machinery
// (network tap, console slice, navigation detection, structure diff, post-snapshot)
// and emits the structured result.
//
// Phase-1 simplification: `snapshotDelta.mode = "scoped_snapshot"` (default) currently
// returns the *full* a11y tree with a warning noting that scope-down is pending.
// The always-on cheap signals (navigation / structure / console / pageErrors / element)
// are real. `tree_diff` is a Phase-1.5 follow-on.

import type { CDPSession, Page } from "playwright-core";
import { getA11yTree, walk, type A11yNode } from "./a11y.js";
import type { RefRegistry } from "./refs.js";
import { findByRef, serialise } from "./snapshot.js";
import { NetworkTap, type NetworkEntry, type NetworkSummary, type MutationEntry, type WsFrame } from "./network.js";
import { ConsoleBuffer } from "./console.js";
import { truncateToBudget, estimateTokens } from "../util/tokens.js";
import { withDeadline, DEFAULT_ACTION_TIMEOUT_MS } from "../util/deadline.js";
import { classifyFailure } from "../util/failure.js";

export type SnapshotMode = "scoped_snapshot" | "tree_diff" | "full" | "none";

/**
 * Internal record of the action being dispatched, attached to every
 * `ActionResult` as `action: {type,...}` so the result is self-describing.
 * NOT the same shape as the public `ActionDescriptor` returned by `plan()` —
 * that one (see `./plan.ts`) carries bound evidence + expiry + a verb-args
 * envelope; this one is the leaner internal label the action-window writes
 * into the result envelope.
 */
export interface DispatchedAction {
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
  /** Post-action DOM value of the element (input.value / textarea.value /
   *  contenteditable text). Null for elements that don't carry a value.
   *  Compare against `valueRequested` to confirm a fill landed without an
   *  extra screenshot/snapshot round-trip. */
  value?: string | null;
  /** For `fill`, the string the caller asked us to type. `value ===
   *  valueRequested` means the write succeeded as-asked; a mismatch means
   *  the field rejected or transformed it (masked input, length cap,
   *  controlled-component handler, etc.). */
  valueRequested?: string;
  /** Visible text of the closest labelled wrapper (role attr or
   *  `data-testid|test|cy|qa`) up to 4 ancestors above the targeted element,
   *  trimmed and capped at 200 chars. Surfaces the *displayed* state for
   *  controls that render the result outside `input.value` — chip-style
   *  selects, combobox displays, badge pickers, custom dropdowns where the
   *  underlying input is cleared on commit. Use when `value` is "" / null
   *  but the caller needs to confirm the visible state landed. Null when
   *  no labelled ancestor was found. Convenience alias for
   *  `ownerControl?.displayTextAfter` when an owner was detected. */
  displayText?: string | null;
  /** state of the logical *owning control* (combobox / listbox /
   *  radiogroup / labelled field wrapper) the action targeted. The caller
   *  often acts on an inner element (an option, a hidden input), but what
   *  *changed* is the owner's displayed state. `displayTextBefore` /
   *  `displayTextAfter` are the wrapper's `innerText` captured pre- and
   *  post-action; `changed: true` when they differ. Absent when no
   *  recognised owning control was found above the target. */
  ownerControl?: {
    label?: string;
    displayTextBefore?: string;
    displayTextAfter?: string;
    changed: boolean;
  };
  /** state of the repeated *container* (row / listitem / article /
   *  `<tr>` / `<li>`) the target lives inside. `rowText` is the container's
   *  visible text post-action; `changed: true` when it differed pre-vs-post.
   *  Lets the caller confirm a row-level save changed the row without
   *  re-snapshotting the whole table. Absent when the target isn't in a
   *  recognised repeated structure. */
  container?: {
    kind: string;
    rowKey?: string;
    rowText?: string;
    changed?: boolean;
  };
  /** coordinate-action evidence. Only populated for `coords` targets.
   *  `before` is `document.elementFromPoint(x, y)` immediately before the
   *  action; `after` is the same point after settling (the page may have
   *  re-rendered or scrolled). `focusChanged` flags whether the active
   *  element shifted. The coord-action analogue of `value`/`displayText`. */
  hit?: {
    before?: HitPoint | null;
    after?: HitPoint | null;
    focusChanged?: boolean;
  };
  /** post-scroll geometry of the relevant scroller (the scrolled
   *  container for `scroll` container-mode, else the window/document). Lets a
   *  caller assert "the older page prepended" (`scrollHeight` grew),
   *  "pinned to bottom" (`atBottom`), etc. without `eval_js`. Only populated
   *  by the `scroll` / `set_viewport` actions. */
  scroll?: {
    x: number;
    y: number;
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
    atTop: boolean;
    atBottom: boolean;
  };
}

export interface HitPoint {
  tag: string;
  role?: string;
  text?: string;
  ancestorText?: string;
}

export interface ActionResult {
  ok: boolean;
  action: DispatchedAction;
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
  console: {
    errors: string[];
    warnings: number;
    /** number of chars trimmed from the summarised view of `errors`
     *  (long React stack-traces etc). The full message is retained via `console_read`. */
    truncated_chars?: number;
  };
  pageErrors: string[];
  element?: ElementProbe;
  snapshotDelta?: {
    mode: SnapshotMode;
    scope: string;
    tree?: string;
    truncated: boolean;
  };
  network: {
    summary: NetworkSummary;
    requests?: NetworkEntry[];
    /** Phase-2: count of requests in this action window that left
     *  `BROWX_ALLOWED_ORIGINS` (0 when no allowlist is set). */
    egressOffAllowlist?: number;
    /** bounded summary of write-shaped requests (POST/PUT/PATCH/DELETE,
     *  2xx) whose response body parsed as JSON. `responseShape` carries the
     *  *top-level keys only* — no values, no nested keys. Use to confirm a
     *  mutation succeeded and what shape it wrote back, without exposing the
     *  full response body. Absent when no mutations landed in the window. */
    mutations?: MutationEntry[];
    /** WebSocket/SSE frames that arrived during this action window
     *  (payloads truncated). Absent when none. Use to verify realtime
     *  correctness — e.g. that a click produced the expected broadcast. */
    wsFrames?: WsFrame[];
  };
  tokensEstimate: number;
  warnings: string[];
  error?: string;
  /** present only when `ok` is false: did the failure originate in the app
   *  (navigation/renderer crash — a real defect signal) or in browxai
   *  (context torn down / detached / anti-wedge — NOT an app crash)? Stops
   *  agents filing false "page crashed" defects for tool teardown. */
  failure?: import("../util/failure.js").FailureClass;
  /** W-T1: set by the server when this session has hit the anti-wedge
   *  deadline on several consecutive calls — the session is wedged and
   *  retrying it (or raising `timeoutMs`) will not recover it. When present,
   *  discard the session (`close_session`) and `open_session` a fresh one.
   *  Injected onto the result by the server, not produced by the action
   *  body; `sessionWedgedHint` carries the agent-facing recovery text. */
  sessionWedged?: boolean;
  sessionWedgedHint?: string;
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
  /** Phase-2: origin allowlist used to populate `ActionResult.network.egressOffAllowlist`.
   *  Empty allow-set means "no allowlist" → egress count is always 0. */
  originPolicy?: import("../policy/origin.js").OriginPolicy;
  /** if a recording is active, the recorder is wired in here so
   *  successful actions append to the recording. Best-effort: errors during
   *  recording never affect the action's outcome. */
  recorder?: import("./recording.js").Recorder;
  /** session WS/SSE frame ring. When present, frames that arrived during
   *  the action window are sliced into `ActionResult.network.wsFrames`. */
  ws?: import("./network.js").WsBuffer;
}

export interface ActionWindowOptions {
  mode?: SnapshotMode;
  /** Approx output budget for the elastic part of the result (snapshotDelta.tree). */
  maxResultTokens?: number;
  /** Cap on per-request rows in `network.requests`; default 10. */
  networkRequestCap?: number;
  /** Post-dispatch settle delay in ms — let CDP events / framework reconciliations drain. */
  settleMs?: number;
  /** hard anti-wedge deadline (ms) for the action body. Already clamped
   *  to [1, 3_600_000] by the caller. The body is raced against this; on
   *  expiry the action returns `ok:false` with the timeout error rather than
   *  stalling on a wedged page op. */
  deadlineMs?: number;
  /** if the caller requested an over-ceiling (insane) timeout, this
   *  carries the "clamped + that's almost always a mistake" warning so it
   *  surfaces in the ActionResult, not just server stderr. */
  deadlineWarning?: string;
  /** extra warnings computed before the action window opened (e.g. a ref
   *  re-resolution notice) — seeded into the result's `warnings`. */
  extraWarnings?: string[];
  /** caller-supplied selectorHint info for the recorder. Without
   *  this the recorded step has the action + url but no locator for the YAML
   *  scaffold; callers should populate it whenever they resolved a target. */
  recordingHint?: { selectorHint: string; stability?: "high" | "medium" | "low" };
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
  descriptor: DispatchedAction,
  opts: ActionWindowOptions,
  body: () => Promise<ElementProbe | void>,
): Promise<ActionResult> {
  const mode: SnapshotMode = opts.mode ?? "scoped_snapshot";
  const maxTokens = opts.maxResultTokens ?? 600;
  const deadlineMs = opts.deadlineMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const requestCap = opts.networkRequestCap ?? 10;
  const settleMs = opts.settleMs ?? 400;
  const warnings: string[] = [];
  if (opts.deadlineWarning) warnings.push(opts.deadlineWarning);
  if (opts.extraWarnings) warnings.push(...opts.extraWarnings);

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
  let failure: import("../util/failure.js").FailureClass | undefined;
  let elementProbe: ElementProbe | undefined;
  try {
    // race the action body against the hard anti-wedge deadline. A
    // wedged page op (evaluate/CDP that ignores timeouts) becomes a clean
    // ok:false ActionResult within the deadline instead of an infinite stall.
    const probe = await withDeadline(
      Promise.resolve().then(body),
      deadlineMs,
      descriptor.type,
    );
    if (probe) elementProbe = probe;
  } catch (e) {
    ok = false;
    error = e instanceof Error ? e.message : String(e);
    failure = classifyFailure(error);
  }

  // --- settle ---
  await sleep(settleMs);
  try { await ctx.page.waitForLoadState("networkidle", { timeout: 1500 }); } catch { /* noisy SPAs never idle */ }

  // --- post-state ---
  ctx.cdp.off("Page.frameNavigated" as never, onFrameNav as never);
  const urlAfter = ctx.page.url();
  const postTree = await getA11yTree(ctx.cdp, ctx.refs, ctx.testAttributes).catch(() => null);
  const postRegions = postTree ? topLevelRegions(postTree) : new Map();
  const network = await net.close();

  // --- shape ---
  const navigation = describeNavigation(urlBefore, urlAfter, frameNavigatedMain);
  const structure = diffRegions(preRegions, postRegions);
  for (const p of ctx.pages()) {
    if (!tabsBefore.has(p.url())) {
      structure.newTabs.push({ url: p.url(), title: await p.title().catch(() => "") });
    }
  }
  // summarise long console errors inline. A single React stack-trace
  // is routinely ~50 lines / ~1500 tokens; the agent rarely needs the full thing in
  // an ActionResult. We truncate per-error to the first line + a token-budget cap,
  // record the trimmed-chars total, and a warnings entry points the agent at
  // `console_read` for the full message.
  const rawErrors = ctx.console.errorsSince(tBefore);
  const consoleSlice = summariseConsoleErrors(rawErrors, warnings);
  consoleSlice.warnings = ctx.console.warningCountSince(tBefore);
  const pageErrors = ctx.console.pageErrorsSince(tBefore);

  // smarter `mode` defaults. When the default `scoped_snapshot` was
  // requested AND the action produced no structural change (no nav, no appeared/
  // removed regions), it's almost never useful to emit any tree — the adopter
  // reported routinely setting `mode: "none"` for this reason. Promote to `none`
  // automatically; explicit non-default modes are still honoured.
  const navigationChanged = urlBefore !== urlAfter;
  const structureChanged = (postTree && preTree) &&
    (diffRegions(preRegions, postRegions).appeared.length > 0 ||
     diffRegions(preRegions, postRegions).removed.length > 0);
  let effectiveMode = mode;
  if (mode === "scoped_snapshot" && !navigationChanged && !structureChanged) {
    effectiveMode = "none";
    warnings.push("snapshotDelta auto-omitted (mode: scoped_snapshot) — no nav/structure change; pass mode:\"full\" if you need the post-action tree anyway");
  }
  // when scoped_snapshot mode is honoured and there are scope-able
  // refs (action's ref + appeared regions), serialise *just those subtrees* instead
  // of the full tree.
  const scopeRefs: string[] = [];
  if (descriptor.ref) scopeRefs.push(descriptor.ref);
  for (const r of structure.appeared) scopeRefs.push(r.ref);
  const snapshotDelta = buildSnapshotDelta(effectiveMode, postTree, maxTokens, warnings, scopeRefs);
  // Phase-2: egress-off-allowlist count, for the security model's
  // network-egress-visibility surface (docs/threat-model.md §"What browxai defends against" #2).
  const egressOffAllowlist = ctx.originPolicy && ctx.originPolicy.allowed.length > 0
    ? (await import("../policy/confirm.js")).countEgressOffAllowlist(network.requests, ctx.originPolicy)
    : 0;
  const mutationsBlock = network.mutations.length > 0 ? { mutations: network.mutations } : {};
  // WS/SSE frames that arrived during this action window.
  const wsSlice = ctx.ws ? ctx.ws.since(tBefore) : [];
  const wsBlock = wsSlice.length > 0 ? { wsFrames: wsSlice } : {};
  const networkBlock = network.summary.total > 0
    ? (network.requests.length <= requestCap
        ? { summary: network.summary, requests: network.requests, ...(egressOffAllowlist > 0 ? { egressOffAllowlist } : {}), ...mutationsBlock, ...wsBlock }
        : (warnings.push(`network.requests omitted (count ${network.requests.length} > cap ${requestCap}); call network_read for details`), { summary: network.summary, ...(egressOffAllowlist > 0 ? { egressOffAllowlist } : {}), ...mutationsBlock, ...wsBlock }))
    : { summary: network.summary, ...mutationsBlock, ...wsBlock };

  const tokensEstimate = estimateTokens(JSON.stringify({
    navigation, structure, console: consoleSlice, pageErrors, snapshotDelta, network: networkBlock,
  }));

  // append to recording when (a) action succeeded, (b) recording
  // is active, and (c) the action is *replayable as a flow-file step*. Coord-mode
  // click/hover have neither a descriptor ref/selector nor a recordingHint —
  // they're an escape hatch for visually-located targets that flow files can't
  // mechanically replay, so they don't belong in a flow-file draft. Navigation /
  // history actions don't need a target at all and are always recorded.
  if (ok && ctx.recorder?.active()) {
    const NON_TARGETED_ACTIONS = new Set(["navigate", "goBack", "goForward"]);
    const isElementAction = !NON_TARGETED_ACTIONS.has(descriptor.type);
    const hasReplayableTarget = !!(descriptor.ref || descriptor.selector || opts.recordingHint);
    if (!isElementAction || hasReplayableTarget) {
      try { ctx.recorder.record(descriptor, urlAfter, opts.recordingHint); } catch { /* swallow */ }
    } else {
      warnings.push("recorder: skipped untargeted action (coords-mode click/hover) — flow files replay deterministically by ref/selector; record the equivalent ref-based action if you want this step in the draft");
    }
  }

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
    ...(failure ? { failure } : {}),
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
  /** refs to scope the delta to (action's ref + appeared regions).
   *  When empty + mode=scoped_snapshot, falls back to the full tree as before. */
  scopeRefs: string[] = [],
): ActionResult["snapshotDelta"] {
  if (mode === "none") return undefined;
  if (!tree) {
    return { mode, scope: "(no tree)", truncated: false };
  }
  let scope: string;
  let renderMode: SnapshotMode = mode;
  if (mode === "tree_diff") {
    // Phase-1.5 partial: emit appeared/removed-as-subtrees instead of a unified diff.
    // Closer in spirit to Vercel agent-browser's diff than the previous fallback,
    // without needing the line-stable cross-snapshot diff plumbing.
    warnings.push("mode=tree_diff: emitting appeared-region subtrees only (full unified diff not yet implemented; pass mode:\"full\" for the post-action tree)");
    renderMode = "scoped_snapshot";
  }

  if (renderMode === "scoped_snapshot" && scopeRefs.length > 0) {
    // real scope-down. Serialise just the action's element subtree + any
    // newly-appeared top-level regions. Drops 7-10k-token snapshots to ~500-1500
    // on the heavy-SPA / many-elements shape.
    const subtrees = scopeRefs
      .map((ref) => findByRef(tree, ref))
      .filter((n): n is A11yNode => n !== null);
    if (subtrees.length === 0) {
      // All scope refs gone — element vanished + no appeared regions. Fall through
      // to a tiny scope marker instead of the full tree.
      return { mode: renderMode, scope: "(scope refs not present in post-tree)", truncated: false };
    }
    const text = subtrees
      .map((n, i) => (subtrees.length > 1 ? `--- subtree ${i + 1}/${subtrees.length} ---\n` : "") + serialise(n))
      .join("\n");
    const { text: trimmed, truncated } = truncateToBudget(text, maxTokens);
    if (truncated) warnings.push(`snapshotDelta truncated to fit maxResultTokens=${maxTokens}; call snapshot() for the complete tree`);
    return {
      mode: renderMode,
      scope: `scoped to ${subtrees.length} subtree(s) [${scopeRefs.join(", ")}]`,
      tree: trimmed,
      truncated,
    };
  }

  // Fall-through: full tree. Honours explicit mode:"full" and the rare case where
  // scoped_snapshot was asked-for but we have no scope refs (no action ref, no
  // appeared regions — uncommon).
  scope = renderMode === "scoped_snapshot" ? "full (no scope refs)" : "full";
  const full = serialise(tree);
  const { text, truncated } = truncateToBudget(full, maxTokens);
  if (truncated) warnings.push(`snapshotDelta truncated to fit maxResultTokens=${maxTokens}; call snapshot() for the complete tree`);
  return { mode: renderMode, scope, tree: text, truncated };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * . Inline summary of console errors — collapse multi-line stack-traces
 * to their first line + a token-budget per error, and emit `truncated_chars` if any
 * were trimmed. The full text is still in the session's `ConsoleBuffer`; an agent
 * who needs it calls `console_read`. Pattern mirrors the existing
 * `network.requests omitted (count N > cap)` design.
 */
const ERROR_MAX_CHARS_PER = 400;
const ERROR_MAX_TOTAL_ENTRIES = 20;
function summariseConsoleErrors(
  errors: string[],
  warnings: string[],
): { errors: string[]; warnings: number; truncated_chars?: number } {
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
  const result: { errors: string[]; warnings: number; truncated_chars?: number } = { errors: out, warnings: 0 };
  if (trimmed > 0) {
    result.truncated_chars = trimmed;
    warnings.push(`console.errors stack-traces summarised (${trimmed} chars trimmed); call console_read for the full text`);
  }
  return result;
}
