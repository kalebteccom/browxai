// Action primitives. Each wraps a Playwright `Locator` action in the
// action-window machinery from actionresult.ts so callers always get a
// structured `ActionResult` instead of a bare "ok".

import type { Locator, Page } from "playwright-core";
import {
  runInActionWindow,
  type ActionContext,
  type DispatchedAction,
  type ActionResult,
  type ActionWindowOptions,
} from "./actionresult.js";
import {
  locatorFor,
  resolveTargetChecked,
  refOrSelector,
  targetDescriptor,
  type ActionTarget,
} from "./locator.js";
import { preProbe, probe, captureHit, captureFocusedRef } from "./actions-probe.js";
import { materialiseValue, maskProbe, failedFill, failedPress } from "./actions-secrets.js";

// aligned with the anti-wedge default (5s). Inner Playwright ops use
// the per-call `deadlineMs` when provided so a raised `timeoutMs` is honoured
// by the inner op too (not just the outer race in runInActionWindow).
const DEFAULT_TIMEOUT_MS = 5_000;

export interface ClickArgs extends ActionWindowOptions {
  target: ActionTarget;
  button?: "left" | "right" | "middle";
  force?: boolean;
}
export async function click(ctx: ActionContext, args: ClickArgs): Promise<ActionResult> {
  const descriptor: DispatchedAction = { type: "click", ...targetDescriptor(args.target) };
  const { resolved, warning } = await resolveTargetChecked(ctx.page, ctx.refs, args.target);
  const opts = warning
    ? { ...args, extraWarnings: [...(args.extraWarnings ?? []), warning] }
    : args;
  return runInActionWindow(ctx, descriptor, opts, async () => {
    if (resolved.kind === "coords") {
      const hitBefore = await captureHit(ctx.page, resolved.x, resolved.y);
      const focusBefore = await captureFocusedRef(ctx.page);
      await ctx.page.mouse.click(
        resolved.x,
        resolved.y,
        args.button ? { button: args.button } : undefined,
      );
      const hitAfter = await captureHit(ctx.page, resolved.x, resolved.y);
      const focusAfter = await captureFocusedRef(ctx.page);
      return {
        stillAttached: true,
        hit: {
          before: hitBefore,
          after: hitAfter,
          focusChanged: focusBefore !== focusAfter,
        },
      };
    }
    const pre = await preProbe(resolved.loc);
    // Click strategy: try the standard actionability path first with a
    // SHORTER budget than the outer action deadline, so the auto-recovery
    // pass with `force: true` has headroom. The recovery surfaces a
    // warning so the caller knows the click-only pre-dispatch path was
    // bypassed. Explicit `force:true` from the caller skips the strategy
    // entirely.
    //
    // RCA (adopter, 2026-06-08): the busy-SPA cost is Playwright's
    // mousedown hit-target interceptor — the one pre-dispatch check
    // `click` does that `hover` does not (~500ms hover vs ~4s click on
    // the same provably-actionable static element). Visibility /
    // stability / receives-events / bbox aren't the culprit. `force: true`
    // skips the interceptor.
    const fullTimeout = args.deadlineMs ?? DEFAULT_TIMEOUT_MS;
    if (args.force) {
      await resolved.loc.click({ timeout: fullTimeout, button: args.button, force: true });
      return probe(resolved.loc, args.target, undefined, pre);
    }
    // Reserve ~30% of the deadline for the recovery click; the rest is
    // the actionability budget. Floor at 500ms each so neither path is
    // unreasonably short on tiny custom deadlines.
    const recoveryMs = Math.max(500, Math.floor(fullTimeout * 0.3));
    const actionabilityMs = Math.max(500, fullTimeout - recoveryMs);
    try {
      await resolved.loc.click({ timeout: actionabilityMs, button: args.button });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isActionabilityTimeout =
        /Timeout|exceeded|element is not stable|element is not visible|element is outside of the viewport|element is not enabled|intercepts pointer events|did not receive/i.test(
          msg,
        );
      if (!isActionabilityTimeout) throw e;
      // Auto-recovery: the actionability check timed out. Try once with
      // `force: true` — common on busy SPAs (perpetual rAF / WS keepalives /
      // re-renders) where the stability check thrashes forever but the
      // element IS clickable. Surface the recovery via an extra warning so
      // the caller doesn't silently get a force-click they didn't opt into.
      await resolved.loc.click({ timeout: recoveryMs, button: args.button, force: true });
      const probed = await probe(resolved.loc, args.target, undefined, pre);
      // Stamp the recovery warning on the probe — `runInActionWindow`
      // splices probe.warnings[] onto the result's top-level warnings.
      probed.warnings = [
        `click: actionability path exceeded ${actionabilityMs}ms — recovered via \`force: true\` (bypasses Playwright's mousedown hit-target interceptor, the click-specific pre-dispatch check that loops/retries on busy SPAs). The page-side click event DID fire (trusted). Pass \`force: true\` explicitly on known-clickable targets to skip the auto-recovery and dispatch immediately. RCA reference: \`hover\` on the same element takes ~500ms vs \`click\` ~4s — the cost is entirely the click-only interceptor, not stability/visibility/receives-events.`,
      ];
      return probed;
    }
    return probe(resolved.loc, args.target, undefined, pre);
  });
}

export interface FillArgs extends ActionWindowOptions {
  target: ActionTarget;
  value: string;
}
export async function fill(ctx: ActionContext, args: FillArgs): Promise<ActionResult> {
  // Secrets materialisation: a `<NAME>`-shaped `value` is swapped for the
  // registered real string AT dispatch. The descriptor records the alias
  // (`<NAME>`), NEVER the real value — so `ActionResult.action.value`, any
  // recorder appendage, and the post-probe's `valueRequested` echo the
  // alias. Plain strings pass through unchanged.
  const mat = materialiseValue(ctx, args.value);
  if (!mat.ok) return failedFill(args.target, args.value, mat.error);
  const descriptorValue = mat.alias ? `<${mat.alias}>` : args.value;
  const descriptor: DispatchedAction = {
    type: "fill",
    value: descriptorValue,
    ...refOrSelector(args.target),
  };
  return runInActionWindow(ctx, descriptor, args, async () => {
    const loc = locatorFor(ctx.page, ctx.refs, args.target);
    const pre = await preProbe(loc);
    await loc.fill(mat.value, { timeout: args.deadlineMs ?? DEFAULT_TIMEOUT_MS });
    // pass the alias as `valueRequested` so `value === valueRequested`
    // comparison still works without the real secret reaching the probe.
    const probed = await probe(loc, args.target, descriptorValue, pre);
    // Defence-in-depth: the field's DOM value reflects what we typed, so
    // `probed.value` carries the secret. Mask before returning — the
    // action-window will surface it on the ActionResult otherwise.
    return maskProbe(probed, ctx);
  });
}

export interface NavigateArgs extends ActionWindowOptions {
  url: string;
}
export async function navigate(ctx: ActionContext, args: NavigateArgs): Promise<ActionResult> {
  const descriptor: DispatchedAction = { type: "navigate", url: args.url };
  return runInActionWindow(ctx, descriptor, args, async () => {
    await ctx.page.goto(args.url, {
      waitUntil: "domcontentloaded",
      timeout: args.deadlineMs ?? DEFAULT_TIMEOUT_MS,
    });
  });
}

export interface PressArgs extends ActionWindowOptions {
  target?: ActionTarget;
  key: string;
}
export async function press(ctx: ActionContext, args: PressArgs): Promise<ActionResult> {
  // Secrets materialisation on `key` — mirrors `fill`. The realistic case is
  // a one-shot OTP/passphrase that the agent needs to "press" into a focused
  // field. Playwright's `press` accepts modifier+key strings ("Shift+A") and
  // single chars; the `<NAME>` shape doesn't collide with either, so the
  // alias detection in the registry is unambiguous.
  const mat = materialiseValue(ctx, args.key);
  if (!mat.ok) return failedPress(args.target, args.key, mat.error);
  const descriptorValue = mat.alias ? `<${mat.alias}>` : args.key;
  const descriptor: DispatchedAction = {
    type: "press",
    value: descriptorValue,
    ...(args.target ? refOrSelector(args.target) : {}),
  };
  return runInActionWindow(ctx, descriptor, args, async () => {
    if (args.target) {
      const loc = locatorFor(ctx.page, ctx.refs, args.target);
      const pre = await preProbe(loc);
      await loc.press(mat.value, { timeout: args.deadlineMs ?? DEFAULT_TIMEOUT_MS });
      const probed = await probe(loc, args.target, undefined, pre);
      return maskProbe(probed, ctx);
    } else {
      await ctx.page.keyboard.press(mat.value);
    }
  });
}

export interface HoverArgs extends ActionWindowOptions {
  target: ActionTarget;
}
export async function hover(ctx: ActionContext, args: HoverArgs): Promise<ActionResult> {
  const descriptor: DispatchedAction = { type: "hover", ...targetDescriptor(args.target) };
  const { resolved, warning } = await resolveTargetChecked(ctx.page, ctx.refs, args.target);
  const opts = warning
    ? { ...args, extraWarnings: [...(args.extraWarnings ?? []), warning] }
    : args;
  return runInActionWindow(ctx, descriptor, opts, async () => {
    if (resolved.kind === "coords") {
      const hitBefore = await captureHit(ctx.page, resolved.x, resolved.y);
      await ctx.page.mouse.move(resolved.x, resolved.y);
      const hitAfter = await captureHit(ctx.page, resolved.x, resolved.y);
      return { stillAttached: true, hit: { before: hitBefore, after: hitAfter } };
    }
    const pre = await preProbe(resolved.loc);
    await resolved.loc.hover({ timeout: args.deadlineMs ?? DEFAULT_TIMEOUT_MS });
    return probe(resolved.loc, args.target, undefined, pre);
  });
}

export interface SelectArgs extends ActionWindowOptions {
  target: ActionTarget;
  values: string[];
}
export async function select(ctx: ActionContext, args: SelectArgs): Promise<ActionResult> {
  const descriptor: DispatchedAction = {
    type: "select",
    value: args.values.join(", "),
    ...refOrSelector(args.target),
  };
  return runInActionWindow(ctx, descriptor, args, async () => {
    const loc = locatorFor(ctx.page, ctx.refs, args.target);
    const pre = await preProbe(loc);
    await loc.selectOption(args.values, { timeout: args.deadlineMs ?? DEFAULT_TIMEOUT_MS });
    return probe(loc, args.target, undefined, pre);
  });
}

export interface WaitForArgs extends ActionWindowOptions {
  /** Element-visibility wait (mutually exclusive with `text`). */
  target?: ActionTarget;
  /** SPA-readiness wait — poll until this visible text appears anywhere
   *  in the page. The non-target gating mode real apps need after a reload /
   *  nav. NO arbitrary-JS predicate mode by design — that stays `eval_js`'s
   *  domain (the single `eval`-gated loophole). */
  text?: string;
  timeoutMs?: number;
}
export async function waitFor(ctx: ActionContext, args: WaitForArgs): Promise<ActionResult> {
  const timeout = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (args.text !== undefined) {
    const descriptor: DispatchedAction = { type: "waitFor", value: `text:${args.text}` };
    const wanted = args.text;
    return runInActionWindow(ctx, descriptor, args, async () => {
      // true substring match (case-insensitive, whitespace-trimmed)
      // — `getByText(string)` is substring by default. The earlier
      // `locator('text="…"')` form lowered to Playwright's quoted/exact-ish
      // engine, contradicting the documented "substring" contract (a short
      // token inside a longer string timed out). Visible-only; throws on
      // timeout (caught by the action window → ok:false).
      await ctx.page.getByText(wanted).first().waitFor({ state: "visible", timeout });
      return { stillAttached: true };
    });
  }
  if (!args.target) {
    throw new Error("wait_for: pass a `target` (ref/selector/named/coords) or `text`");
  }
  const target = args.target;
  const descriptor: DispatchedAction = { type: "waitFor", ...refOrSelector(target) };
  return runInActionWindow(ctx, descriptor, args, async () => {
    const loc = locatorFor(ctx.page, ctx.refs, target);
    await loc.waitFor({ state: "visible", timeout });
    return probe(loc, target);
  });
}

export interface SetViewportArgs extends ActionWindowOptions {
  width: number;
  height: number;
}
/** mid-session viewport resize. `page.setViewportSize` re-lays-out and
 *  often triggers responsive re-render / lazy-load — wrapped in the action
 *  window so `structure` / `network` / `snapshotDelta` show what changed.
 *  Device emulation (isMobile/touch/UA/DPR) is creation-time only; this only
 *  changes the size. */
export async function setViewport(
  ctx: ActionContext,
  args: SetViewportArgs,
): Promise<ActionResult> {
  const descriptor: DispatchedAction = {
    type: "setViewport",
    value: `${args.width}x${args.height}`,
  };
  return runInActionWindow(ctx, descriptor, args, async () => {
    await ctx.page.setViewportSize({ width: args.width, height: args.height });
    return { stillAttached: true };
  });
}

export interface ChooseOptionArgs extends ActionWindowOptions {
  target: ActionTarget;
  option: string;
  exact?: boolean;
}

/**
 * `choose_option` primitive. Generic combobox/listbox/menu selection
 * for custom controls that aren't native `<select>` (so the existing `select`
 * tool can't drive them). The pattern: open the target control, wait for a
 * visible listbox/menu/portal, find the option element by exact text, click
 * it, return the probe on the *trigger* so `ownerControl.displayText`
 * shows the committed selection.
 *
 * Falls back across `role=option` → `role=menuitem` → `getByText` so works
 * on any reasonable combobox shape. Does **not** simulate keyboard navigation
 * (type-and-press-Enter) — that's a different primitive and prone to picking
 * the wrong option in dense lists.
 */
export async function chooseOption(
  ctx: ActionContext,
  args: ChooseOptionArgs,
): Promise<ActionResult> {
  const descriptor: DispatchedAction = {
    type: "chooseOption",
    value: args.option,
    ...targetDescriptor(args.target),
  };
  return runInActionWindow(ctx, descriptor, args, async () => {
    if (args.target.coords) {
      throw new Error(
        "choose_option requires a ref/selector/named target (the combobox/menu trigger), not coords",
      );
    }
    const trigger = locatorFor(ctx.page, ctx.refs, args.target);
    const pre = await preProbe(trigger);

    // Open the control if not already expanded. `aria-expanded` is the strongest
    // signal; absence isn't proof it's closed, so we still click if false-or-missing.
    const isExpanded = await trigger
      .evaluate(
        (el: { getAttribute?: (k: string) => string | null }) =>
          !!el.getAttribute && el.getAttribute("aria-expanded") === "true",
      )
      .catch(() => false);
    if (!isExpanded) {
      await trigger.click({ timeout: args.deadlineMs ?? DEFAULT_TIMEOUT_MS });
    }

    const optionLoc = await resolveOption(ctx.page, args.option, args.exact ?? true);
    await optionLoc.click({ timeout: args.deadlineMs ?? DEFAULT_TIMEOUT_MS });

    return probe(trigger, args.target, undefined, pre);
  });
}

/** Resolve the option element by exact text across the three common shapes a
 *  custom combobox/listbox emits. Tries each in order, returning the first
 *  attempt that has a non-zero count. Last attempt is returned even if empty
 *  so the subsequent `click()` produces a clean timeout error instead of
 *  silently doing nothing. */
async function resolveOption(page: Page, text: string, exact: boolean): Promise<Locator> {
  const attempts: Array<() => Locator> = [
    () => page.getByRole("option", { name: text, exact }).first(),
    () => page.getByRole("menuitem", { name: text, exact }).first(),
    () => page.getByText(text, { exact }).first(),
  ];
  for (const make of attempts) {
    const loc = make();
    const count = await loc.count().catch(() => 0);
    if (count > 0) return loc;
  }
  return attempts[0]!();
}

export type GoBackArgs = ActionWindowOptions;
export async function goBack(ctx: ActionContext, args: GoBackArgs = {}): Promise<ActionResult> {
  return runInActionWindow(ctx, { type: "goBack" }, args, async () => {
    await ctx.page.goBack({
      waitUntil: "domcontentloaded",
      timeout: args.deadlineMs ?? DEFAULT_TIMEOUT_MS,
    });
  });
}

export type GoForwardArgs = ActionWindowOptions;
export async function goForward(
  ctx: ActionContext,
  args: GoForwardArgs = {},
): Promise<ActionResult> {
  return runInActionWindow(ctx, { type: "goForward" }, args, async () => {
    await ctx.page.goForward({
      waitUntil: "domcontentloaded",
      timeout: args.deadlineMs ?? DEFAULT_TIMEOUT_MS,
    });
  });
}

// The post-action element-probe machinery (preProbe / probe / captureHit /
// captureFocusedRef + their in-page scripts) lives in `actions-probe.ts` to keep
// this file under the size budget; re-exported here so callers import unchanged.
export type { PreProbeData } from "./actions-probe.js";
export { preProbe, probe, captureHit, captureFocusedRef } from "./actions-probe.js";

// The secrets / mask plumbing (materialiseValue / maskProbe + the failure
// builders) lives in `actions-secrets.ts` — the second reason-to-change,
// separated from the verb primitives. Re-exported so `fill-form` and any other
// composer import `materialiseValue` / `maskProbe` from this path unchanged.
export { materialiseValue, maskProbe } from "./actions-secrets.js";

// The `scroll` action surface (scroll verb + scroll-behaviour types + the pure
// `scrollMode` dispatch resolver) lives in `actions-scroll.ts` next to its
// post-scroll geometry helpers. Re-exported so `plan` / `action-substrate` and
// the colocated tests import `scroll` / `ScrollArgs` / `scrollMode` from this
// path unchanged.
export { scroll, scrollMode } from "./actions-scroll.js";
export type { ScrollEdge, ScrollArgs, ScrollMode } from "./actions-scroll.js";
