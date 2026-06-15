// ActionResult builder. Wraps a single action with the action-window machinery
// (network tap, console slice, navigation detection, structure diff, post-snapshot)
// and emits the structured result.
//
//  simplification: `snapshotDelta.mode = "scoped_snapshot"` (default) currently
// returns the *full* a11y tree with a warning noting that scope-down is pending.
// The always-on cheap signals (navigation / structure / console / pageErrors / element)
// are real. `tree_diff` is a follow-on.

import type { A11yNode } from "./a11y.js";
import type { NetworkEntry, NetworkSummary, MutationEntry } from "./network.js";
import { estimateTokens } from "../util/tokens.js";
import { withDeadline, DEFAULT_ACTION_TIMEOUT_MS } from "../util/deadline.js";
import { classifyFailure } from "../util/failure.js";
import { type DialogRecord, UNHANDLED_DIALOG_HINT } from "../session/dialog.js";
import { type PermissionRecord, UNHANDLED_PERMISSION_HINT } from "../session/permission.js";
import { type NotificationRecord, UNHANDLED_NOTIFICATION_HINT } from "../session/notification.js";
import { type FsPickerRecord, UNHANDLED_FS_PICKER_HINT } from "../session/fs-picker.js";
import {
  type ActionOutcome,
  applyPolicyRaise,
  assembleOptionalBlocks,
  buildDialogsBlock,
  buildDownloadsBlock,
  buildFsPickerRequestsBlock,
  buildNetworkBlock,
  buildNotificationsBlock,
  buildPermissionRequestsBlock,
  maybeRecord,
} from "./actionresult-blocks.js";

// The snapshot/navigation/console shape helpers + their types live in
// `actionresult-shape.ts`; `SnapshotMode` + `Region` are re-exported here so the
// public surface (callers importing `SnapshotMode` from `./actionresult.js`) is
// unchanged.
export type { SnapshotMode } from "./actionresult-shape.js";
import type { SnapshotMode, Region } from "./actionresult-shape.js";
import {
  buildSnapshotDelta,
  describeNavigation,
  diffRegions,
  sleep,
  summariseConsoleErrors,
  topLevelRegions,
} from "./actionresult-shape.js";

/** The network slice when there is no CDP tap (off Chromium, where the
 *  Playwright-event network tap is used instead). Matches `NetworkTap.close()`'s
 *  shape so the envelope builder downstream is engine-blind: zero requests, zero
 *  mutations. Frozen so it is never mutated by a downstream consumer. */
const EMPTY_NETWORK: {
  summary: NetworkSummary;
  requests: NetworkEntry[];
  mutations: MutationEntry[];
} = Object.freeze({
  summary: { total: 0, byType: {}, failed: 0 },
  requests: [],
  mutations: [],
});


// The ActionResult type surface lives in `actionresult-types.ts`; re-exported
// here so callers import the types from `./actionresult.js` unchanged.
export type {
  DispatchedAction,
  ElementProbe,
  HitPoint,
  ActionResult,
  ActionContext,
  ActionWindowOptions,
} from "./actionresult-types.js";
import type {
  ActionContext,
  ActionResult,
  ActionWindowOptions,
  DispatchedAction,
  ElementProbe,
} from "./actionresult-types.js";

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
  // mode / maxResultTokens / networkRequestCap defaults are resolved inside
  // shapeActionResult (the only consumer); the orchestrator needs only the
  // dispatch-phase knobs.
  const deadlineMs = opts.deadlineMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const settleMs = opts.settleMs ?? 400;
  const warnings: string[] = [];
  if (opts.deadlineWarning) warnings.push(opts.deadlineWarning);
  if (opts.extraWarnings) warnings.push(...opts.extraWarnings);

  // --- pre-state ---
  const pre = await openActionWindow(ctx);
  const { urlBefore, tabsBefore, tBefore, preTree, preRegions } = pre;
  if (pre.net) await pre.net.open();

  // --- dispatch ---
  const dispatch = await dispatchActionBody(body, deadlineMs, descriptor.type, warnings);
  let { ok, error, failure } = dispatch;
  const elementProbe = dispatch.elementProbe;

  // --- settle ---
  await sleep(settleMs);
  try {
    await ctx.page.waitForLoadState("networkidle", { timeout: 1500 });
  } catch {
    /* noisy SPAs never idle */
  }

  // --- post-state ---
  const frameNavigatedMain = pre.detach();
  const urlAfter = ctx.page.url();
  const postTree = await ctx.snapshot.a11yTree(ctx.refs, ctx.testAttributes).catch(() => null);
  const postRegions = postTree ? topLevelRegions(postTree) : new Map<string, Region>();
  const network = pre.net ? await pre.net.close() : EMPTY_NETWORK;

  // policy capture — dialogs / permission requests / notifications / fs-picker
  // calls that fired in the window; a `raise` flips ok→false (see capturePolicy).
  const policy = capturePolicy(ctx, tBefore, { ok, error, failure });
  ({ ok, error, failure } = policy.outcome);

  // --- shape ---
  const shaped = await shapeActionResult({
    ctx,
    descriptor,
    opts,
    warnings,
    tBefore,
    urlBefore,
    urlAfter,
    frameNavigatedMain,
    preTree,
    postTree,
    preRegions,
    postRegions,
    tabsBefore,
    network,
    policy,
  });
  const { navigation, structure, consoleSlice, pageErrors, snapshotDelta, networkBlock, blocks } =
    shaped;

  // append to recording when the action succeeded, recording is active, and the
  // action is replayable as a flow-file step (see maybeRecord for the coord-mode
  // escape-hatch handling).
  maybeRecord(ctx.recorder, ok, { descriptor, urlAfter, recordingHint: opts.recordingHint }, warnings);

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
    ...blocks,
    tokensEstimate: shaped.tokensEstimate,
    warnings,
    error,
    ...(failure ? { failure } : {}),
  };
}

/** The network slice shape `NetworkTap.close()` (and its Playwright twin) emit. */
type NetworkClose = { summary: NetworkSummary; requests: NetworkEntry[]; mutations: MutationEntry[] };

interface OpenWindow {
  urlBefore: string;
  tabsBefore: Set<string>;
  tBefore: number;
  preTree: A11yNode | null;
  preRegions: Map<string, Region>;
  net: ReturnType<NonNullable<ActionContext["network"]>["openActionTap"]> | null;
  detach: () => boolean;
}

/** Open the action window: capture pre-state (url / tabs / time / a11y tree +
 *  top-level regions), wire the cross-browser `framenavigated` listener, and mint
 *  the per-action network tap from the engine's substrate. `detach()` removes the
 *  listener and reports whether the main frame fully navigated. The order
 *  (pre-tree → listener → tap) is preserved verbatim from the inline version. */
async function openActionWindow(ctx: ActionContext): Promise<OpenWindow> {
  const urlBefore = ctx.page.url();
  const tabsBefore = new Set(ctx.pages().map((p) => p.url()));
  const tBefore = Date.now();
  const preTree = await ctx.snapshot.a11yTree(ctx.refs, ctx.testAttributes).catch(() => null);
  const preRegions = preTree ? topLevelRegions(preTree) : new Map<string, Region>();
  // Playwright's `framenavigated` is cross-browser and fires on the same main-frame
  // nav the CDP `Page.frameNavigated` did, so navigation detection works on every
  // engine (the CDP `Page.enable` + raw listener it replaced was Chromium-only).
  let frameNavigatedMain = false;
  const onFrameNav = (frame: import("playwright-core").Frame) => {
    if (frame === ctx.page.mainFrame()) frameNavigatedMain = true;
  };
  ctx.page.on("framenavigated", onFrameNav);
  // The per-action network tap comes from the engine's substrate: chromium → the
  // CDP NetworkTap; firefox/webkit → the Playwright context-event tap. Both emit
  // the same `{summary, requests, mutations}` close shape, so the envelope builder
  // is engine-blind. (`ctx.secrets` was wired into the substrate at session
  // creation; the tap inherits it.)
  const net = ctx.network ? ctx.network.openActionTap() : null;
  return {
    urlBefore,
    tabsBefore,
    tBefore,
    preTree,
    preRegions,
    net,
    detach: () => {
      ctx.page.off("framenavigated", onFrameNav);
      return frameNavigatedMain;
    },
  };
}

interface ShapeInput {
  ctx: ActionContext;
  descriptor: DispatchedAction;
  opts: ActionWindowOptions;
  warnings: string[];
  tBefore: number;
  urlBefore: string;
  urlAfter: string;
  frameNavigatedMain: boolean;
  preTree: A11yNode | null;
  postTree: A11yNode | null;
  preRegions: Map<string, Region>;
  postRegions: Map<string, Region>;
  tabsBefore: Set<string>;
  network: NetworkClose;
  policy: ReturnType<typeof capturePolicy>;
}

interface ShapedResult {
  navigation: ReturnType<typeof describeNavigation>;
  structure: ReturnType<typeof diffRegions>;
  consoleSlice: ReturnType<typeof buildConsoleSlice>;
  pageErrors: string[];
  snapshotDelta: ReturnType<typeof computeSnapshotDelta>;
  networkBlock: ReturnType<typeof buildNetworkBlock>;
  blocks: ReturnType<typeof assembleOptionalBlocks>;
  tokensEstimate: number;
}

/** Assemble the post-state result blocks (navigation, structure, console,
 *  snapshotDelta, network, the optional policy/download blocks, token estimate).
 *  Pure shaping over already-captured window data — pulled out of
 *  `runInActionWindow` to keep the orchestrator under budget. */
async function shapeActionResult(p: ShapeInput): Promise<ShapedResult> {
  const { ctx, warnings, tBefore } = p;
  const navigation = describeNavigation(p.urlBefore, p.urlAfter, p.frameNavigatedMain);
  const structure = diffRegions(p.preRegions, p.postRegions);
  for (const page of ctx.pages()) {
    if (!p.tabsBefore.has(page.url())) {
      structure.newTabs.push({ url: page.url(), title: await page.title().catch(() => "") });
    }
  }
  const consoleSlice = buildConsoleSlice(ctx, tBefore, warnings);
  const pageErrors = ctx.console.pageErrorsSince(tBefore);

  const snapshotDelta = computeSnapshotDelta({
    mode: p.opts.mode ?? "scoped_snapshot",
    descriptor: p.descriptor,
    structure,
    preTree: p.preTree,
    postTree: p.postTree,
    urlBefore: p.urlBefore,
    urlAfter: p.urlAfter,
    maxTokens: p.opts.maxResultTokens ?? 600,
    warnings,
  });
  const networkBlock = await buildActionNetworkBlock(
    ctx,
    p.network,
    p.opts.networkRequestCap ?? 10,
    tBefore,
    warnings,
  );
  const blocks = assembleOptionalBlocks({
    dialogs: buildDialogsBlock(p.policy.dialogSlice),
    permissionRequests: buildPermissionRequestsBlock(p.policy.permissionSlice),
    notifications: buildNotificationsBlock(p.policy.notificationSlice),
    fsPickerRequests: buildFsPickerRequestsBlock(p.policy.fsPickerSlice),
    downloads: buildDownloadsBlock(ctx.downloads ? ctx.downloads.since(tBefore) : []),
  });

  const tokensEstimate = estimateTokens(
    JSON.stringify({
      navigation,
      structure,
      console: consoleSlice,
      pageErrors,
      snapshotDelta,
      network: networkBlock,
      ...blocks,
    }),
  );
  return {
    navigation,
    structure,
    consoleSlice,
    pageErrors,
    snapshotDelta,
    networkBlock,
    blocks,
    tokensEstimate,
  };
}

/** Compute the egress-off-allowlist count + WS slice and fold them into the
 *  `network` result block. The egress count feeds the security model's
 *  network-egress-visibility surface (docs/threat-model.md §"What browxai
 *  defends against" #2); it is 0 when no allowlist is configured. */
async function buildActionNetworkBlock(
  ctx: ActionContext,
  network: NetworkClose,
  requestCap: number,
  tBefore: number,
  warnings: string[],
): Promise<ReturnType<typeof buildNetworkBlock>> {
  const egressOffAllowlist =
    ctx.originPolicy && ctx.originPolicy.allowed.length > 0
      ? (await import("../policy/confirm.js")).countEgressOffAllowlist(
          network.requests,
          ctx.originPolicy,
        )
      : 0;
  const wsSlice = ctx.ws ? ctx.ws.since(tBefore) : [];
  return buildNetworkBlock(network, wsSlice, egressOffAllowlist, requestCap, warnings);
}

/** Run the action body, raced against the hard anti-wedge deadline. A wedged
 *  page op (evaluate/CDP ignoring timeouts) becomes a clean ok:false within the
 *  deadline instead of an infinite stall. Body-side mid-action warnings (e.g.
 *  click auto-recovery) are spliced onto the result warnings and removed from
 *  the probe so they don't leak into the `element` block. */
async function dispatchActionBody(
  body: () => Promise<ElementProbe | void>,
  deadlineMs: number,
  descriptorType: string,
  warnings: string[],
): Promise<{
  ok: boolean;
  error: string | undefined;
  failure: import("../util/failure.js").FailureClass | undefined;
  elementProbe: ElementProbe | undefined;
}> {
  try {
    const probe = await withDeadline(Promise.resolve().then(body), deadlineMs, descriptorType);
    let elementProbe: ElementProbe | undefined;
    if (probe) {
      elementProbe = probe;
      if (probe.warnings && probe.warnings.length > 0) {
        warnings.push(...probe.warnings);
        delete probe.warnings;
      }
    }
    return { ok: true, error: undefined, failure: undefined, elementProbe };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, error, failure: classifyFailure(error), elementProbe: undefined };
  }
}

/** Slice the four per-session policy buffers since `tBefore` and apply each
 *  `raise` to the outcome (first raise wins, in dialog → permission →
 *  notification → fs-picker order). Returns the slices for block-building plus
 *  the possibly-flipped outcome. */
function capturePolicy(
  ctx: ActionContext,
  tBefore: number,
  start: ActionOutcome,
): {
  outcome: ActionOutcome;
  dialogSlice: DialogRecord[];
  permissionSlice: PermissionRecord[];
  notificationSlice: NotificationRecord[];
  fsPickerSlice: FsPickerRecord[];
} {
  const dialogSlice = ctx.dialog ? ctx.dialog.since(tBefore) : [];
  const permissionSlice = ctx.permission ? ctx.permission.since(tBefore) : [];
  const notificationSlice = ctx.notification ? ctx.notification.since(tBefore) : [];
  const fsPickerSlice = ctx.fsPicker ? ctx.fsPicker.since(tBefore) : [];
  let outcome = applyPolicyRaise(
    start,
    ctx.dialog?.raisedSince(tBefore) ?? false,
    UNHANDLED_DIALOG_HINT,
  );
  outcome = applyPolicyRaise(
    outcome,
    ctx.permission?.raisedSince(tBefore) ?? false,
    UNHANDLED_PERMISSION_HINT,
  );
  outcome = applyPolicyRaise(
    outcome,
    ctx.notification?.raisedSince(tBefore) ?? false,
    UNHANDLED_NOTIFICATION_HINT,
  );
  outcome = applyPolicyRaise(
    outcome,
    ctx.fsPicker?.raisedSince(tBefore) ?? false,
    UNHANDLED_FS_PICKER_HINT,
  );
  return { outcome, dialogSlice, permissionSlice, notificationSlice, fsPickerSlice };
}

/** Summarise long console errors inline. A single React stack-trace is routinely
 *  ~50 lines / ~1500 tokens; the agent rarely needs the full thing in an
 *  ActionResult, so each error is truncated to its first line + a token-budget
 *  cap, and a warning points at `console_read` for the full text. */
function buildConsoleSlice(
  ctx: ActionContext,
  tBefore: number,
  warnings: string[],
): ReturnType<typeof summariseConsoleErrors> {
  const consoleSlice = summariseConsoleErrors(ctx.console.errorsSince(tBefore), warnings);
  consoleSlice.warnings = ctx.console.warningCountSince(tBefore);
  return consoleSlice;
}

/** Compute the snapshotDelta: promote `scoped_snapshot` to `none` when the
 *  action produced no nav/structure change (the adopter's common case), then
 *  serialise just the action's subtree + appeared regions (scope-down). */
function computeSnapshotDelta(args: {
  mode: SnapshotMode;
  descriptor: DispatchedAction;
  structure: { appeared: Region[]; removed: Region[] };
  preTree: A11yNode | null;
  postTree: A11yNode | null;
  urlBefore: string;
  urlAfter: string;
  maxTokens: number;
  warnings: string[];
}): ActionResult["snapshotDelta"] {
  const navigationChanged = args.urlBefore !== args.urlAfter;
  const structureChanged =
    !!args.postTree &&
    !!args.preTree &&
    (args.structure.appeared.length > 0 || args.structure.removed.length > 0);
  let effectiveMode = args.mode;
  if (args.mode === "scoped_snapshot" && !navigationChanged && !structureChanged) {
    effectiveMode = "none";
    args.warnings.push(
      'snapshotDelta auto-omitted (mode: scoped_snapshot) — no nav/structure change; pass mode:"full" if you need the post-action tree anyway',
    );
  }
  const scopeRefs: string[] = [];
  if (args.descriptor.ref) scopeRefs.push(args.descriptor.ref);
  for (const r of args.structure.appeared) scopeRefs.push(r.ref);
  return buildSnapshotDelta(effectiveMode, args.postTree, args.maxTokens, args.warnings, scopeRefs);
}
