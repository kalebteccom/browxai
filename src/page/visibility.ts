// Tab background / foreground control.
//
// A whole class of real bugs only reproduces when the tab is *backgrounded*
// during a transition: the browser throttles `setTimeout`, pauses
// `requestAnimationFrame` (framework enter/animation hooks never fire), and on
// return a `visibilitychange`/focus handler replays stale state. browxai
// otherwise keeps the driven tab foreground, so agentic QA scores these flows
// PASS while they are broken.
//
// Two levers, applied together:
//   1. Synthetic: server-injected *fixed* script (not agent JS — same posture
//      as the sampler / overlay-hide) overrides `document.visibilityState` /
//      `document.hidden` and dispatches `visibilitychange`. This deterministic
//      across managed/incognito/attached/headless, and covers the large
//      on-focus-refetch / visibilitychange-handler / realtime-replay subset.
//   2. Real best-effort: bring a blank scratch page in the same context to the
//      front so Chromium actually treats the driven page as hidden (real
//      timer/rAF throttling). Headless Chromium may not throttle even when
//      backgrounded — so this is best-effort and reported as such, never
//      silently assumed (cf. the documented headless gaps).

import type { BrowserContext, Page } from "playwright-core";

export type VisibilityState = "background" | "foreground";

const SCRATCH_URL = "about:blank";

// Fixed in-page scripts. `configurable: true` so the two states can be
// re-applied across calls. No agent-supplied code path.
const HIDE = `(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('blur'));
})()`;

const SHOW = `(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
})()`;

export interface VisibilityResult {
  ok: boolean;
  state: VisibilityState;
  /** true when a real scratch-page background swap was applied (the driven
   *  page is genuinely not the front tab), false when only the synthetic
   *  visibility flip was possible. */
  realBackgrounding: boolean;
  /** present on a `background` call with `holdMs`: how long the page was held
   *  hidden before auto-foregrounding. */
  heldMs?: number;
  note?: string;
}

/** Reuse-or-create a blank scratch page for this context (used to actually
 *  background the driven page by taking front focus away from it). */
async function scratchPage(context: BrowserContext, driven: Page): Promise<Page | null> {
  try {
    const existing = context.pages().find((p) => p !== driven && p.url() === SCRATCH_URL);
    if (existing) return existing;
    const p = await context.newPage();
    await p.goto(SCRATCH_URL).catch(() => undefined);
    return p;
  } catch {
    return null;
  }
}

/**
 * Drive the tab's visibility. `background` with `holdMs` is the headline
 * primitive: background the page, hold it hidden for `holdMs` (real throttling
 * in effect where the browser honours it), then auto-foreground — so the
 * background→return transition that triggers the bug is reproducible in one
 * call. `holdMs` is ignored for `foreground`.
 */
export async function setTabVisibility(
  page: Page,
  context: BrowserContext,
  state: VisibilityState,
  holdMs?: number,
): Promise<VisibilityResult> {
  if (state === "foreground") {
    await page.evaluate(SHOW).catch(() => undefined);
    await page.bringToFront().catch(() => undefined);
    return { ok: true, state, realBackgrounding: false };
  }

  // background
  const scratch = await scratchPage(context, page);
  let realBackgrounding = false;
  if (scratch) {
    await scratch.bringToFront().catch(() => undefined);
    realBackgrounding = true;
  }
  await page.evaluate(HIDE).catch(() => undefined);

  if (holdMs !== undefined && holdMs > 0) {
    await new Promise((r) => setTimeout(r, holdMs));
    await page.evaluate(SHOW).catch(() => undefined);
    await page.bringToFront().catch(() => undefined);
    return {
      ok: true,
      state: "foreground",
      realBackgrounding,
      heldMs: holdMs,
      note: realBackgrounding
        ? "backgrounded for the hold window (real front-tab swap + synthetic visibilitychange), then auto-foregrounded; timer/rAF throttling is best-effort and may not occur under headless"
        : "synthetic visibilitychange only (no second page could be created to take front focus); on-focus/visibilitychange handlers fire but real timer throttling is not simulated",
    };
  }

  return {
    ok: true,
    state,
    realBackgrounding,
    note: realBackgrounding
      ? "page backgrounded (front-tab swap + synthetic visibilitychange); call tab_visibility({state:'foreground'}) to return. Real timer/rAF throttling is best-effort under headless."
      : "synthetic visibilitychange only; real timer throttling not simulated",
  };
}
