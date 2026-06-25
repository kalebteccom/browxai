// The `scroll` action surface — the scroll-verb primitive together with the
// post-scroll geometry of the window/document scroller and of a scroll-container
// element. Split out of actions.ts so that file stays focused on the other verb
// primitives; behavior-identical. The verb and its geometry live together here
// because they change for the same reason (the scroll-behaviour story).
//
// These scripts run in the browser where TS's DOM lib is intentionally NOT in
// scope, so the structural shape each one touches is described precisely and
// `unknown` runtime values are narrowed via real guards.

import type { Locator, Page } from "playwright-core";
import {
  runInActionWindow,
  type ActionContext,
  type DispatchedAction,
  type ActionResult,
  type ActionWindowOptions,
  type ElementProbe,
} from "./actionresult.js";
import { locatorFor, refOrSelector, type ActionTarget } from "./locator.js";
import { probe } from "./actions-probe.js";

// aligned with the anti-wedge default (5s); mirrors actions.ts so a raised
// `timeoutMs` is honoured by the inner Playwright op too.
const DEFAULT_TIMEOUT_MS = 5_000;

/** Minimal structural view of an element exposing scroll geometry/mutators. */
export interface ScrollContainerEl {
  scrollTop: number;
  scrollLeft: number;
  readonly scrollHeight: number;
  readonly scrollWidth: number;
  readonly clientHeight: number;
  readonly clientWidth: number;
  scrollBy: (x: number, y: number) => void;
}

/** Minimal structural view of the scrolling element read by the geometry probes. */
export interface ScrollingEl {
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly scrollHeight: number;
  readonly scrollWidth: number;
  readonly clientHeight: number;
  readonly clientWidth: number;
}

/** Minimal structural view of `document` as used by the scroll geometry scripts. */
interface DocumentLike {
  readonly documentElement?: ScrollingEl;
  readonly scrollingElement?: ScrollingEl | null;
}

/** Minimal structural view of `window`/`globalThis` as used by the scroll script. */
export interface WindowLike {
  readonly document?: DocumentLike;
  readonly scrollX: number;
  readonly scrollY: number;
  scrollTo: (x: number, y: number) => void;
  scrollBy: (x: number, y: number) => void;
}

export type ScrollGeometry = NonNullable<ElementProbe["scroll"]>;

/** Post-scroll geometry of the document/window scroller. */
export async function windowScrollGeometry(page: Page): Promise<ScrollGeometry | undefined> {
  return page
    .evaluate((): ScrollGeometry | undefined => {
      const g: unknown = globalThis;
      const w = g as WindowLike;
      const d = w.document;
      const s: ScrollingEl | null | undefined = d?.scrollingElement || d?.documentElement;
      if (!s) return undefined;
      const x = w.scrollX ?? s.scrollLeft ?? 0;
      const y = w.scrollY ?? s.scrollTop ?? 0;
      return {
        x,
        y,
        scrollWidth: s.scrollWidth,
        scrollHeight: s.scrollHeight,
        clientWidth: s.clientWidth,
        clientHeight: s.clientHeight,
        atTop: y <= 1,
        atBottom: y + s.clientHeight >= s.scrollHeight - 1,
      };
    })
    .catch(() => undefined);
}

/** Post-scroll geometry of a scroll-container element. */
export async function elementScrollGeometry(loc: Locator): Promise<ScrollGeometry | undefined> {
  return loc
    .evaluate((el: unknown): ScrollGeometry | undefined => {
      const e = el as ScrollingEl | null | undefined;
      if (!e) return undefined;
      const y = e.scrollTop ?? 0;
      return {
        x: e.scrollLeft ?? 0,
        y,
        scrollWidth: e.scrollWidth,
        scrollHeight: e.scrollHeight,
        clientWidth: e.clientWidth,
        clientHeight: e.clientHeight,
        atTop: y <= 1,
        atBottom: y + e.clientHeight >= e.scrollHeight - 1,
      };
    })
    .catch(() => undefined);
}

// ---------- scroll verb ----------

export type ScrollEdge = "top" | "bottom" | "left" | "right";
export interface ScrollArgs extends ActionWindowOptions {
  /** What to scroll. Omitted → the page/window. A ref/selector/named element
   *  is either scrolled *into view* (default) or scrolled *within* (when it's
   *  a scroll container and `to`/`by` is given). A coords target does a wheel
   *  scroll at that point (canvas / map panning). */
  target?: ActionTarget;
  /** Scroll to an edge of the page (or the targeted container). */
  to?: ScrollEdge;
  /** Wheel-style delta in CSS px. Positive y = down, positive x = right. */
  by?: { x?: number; y?: number };
  /** When `target` is an element: scroll it into view. Defaults to true when a
   *  target is given and neither `to` nor `by` is set. */
  intoView?: boolean;
}

export type ScrollMode =
  | { kind: "into-view" }
  | { kind: "container" }
  | { kind: "wheel-at" }
  | { kind: "window" };

/**
 * Resolve which of the four scroll behaviours a `ScrollArgs` selects, or throw
 * a clear error for a no-op call. Pure — exported for unit tests.
 *
 *   - target + (no to/by) | intoView:true  → scroll the element into view
 *   - target + (to|by) + intoView:false    → scroll *within* the container
 *   - coords target                        → wheel scroll at the point
 *   - no target + (to|by)                  → window scroll
 */
export function scrollMode(args: ScrollArgs): ScrollMode {
  if (args.target?.coords) return { kind: "wheel-at" };
  if (args.target) {
    const wantsInto = args.intoView ?? (args.to === undefined && args.by === undefined);
    return wantsInto ? { kind: "into-view" } : { kind: "container" };
  }
  if (args.to === undefined && args.by === undefined) {
    throw new Error(
      "scroll: no-op — pass `to` (top|bottom|left|right) or `by` {x,y}, or a `target` to scroll into view",
    );
  }
  return { kind: "window" };
}

export async function scroll(ctx: ActionContext, args: ScrollArgs): Promise<ActionResult> {
  const descriptor: DispatchedAction = {
    type: "scroll",
    value: args.to ?? (args.by ? `by ${args.by.x ?? 0},${args.by.y ?? 0}` : "into-view"),
    ...(args.target ? refOrSelector(args.target) : {}),
  };
  return runInActionWindow(ctx, descriptor, args, async () => {
    const mode = scrollMode(args);
    if (mode.kind === "wheel-at") {
      const c = args.target!.coords!;
      await ctx.page.mouse.move(c.x, c.y);
      await ctx.page.mouse.wheel(args.by?.x ?? 0, args.by?.y ?? 0);
      return { stillAttached: true, scroll: await windowScrollGeometry(ctx.page) };
    }
    if (mode.kind === "into-view") {
      const loc = locatorFor(ctx.page, ctx.refs, args.target!);
      await loc.scrollIntoViewIfNeeded({ timeout: args.deadlineMs ?? DEFAULT_TIMEOUT_MS });
      const p = await probe(loc, args.target!);
      p.scroll = await windowScrollGeometry(ctx.page);
      return p;
    }
    if (mode.kind === "container") {
      const loc = locatorFor(ctx.page, ctx.refs, args.target!);
      await loc.evaluate(
        (el: ScrollContainerEl, a: { to?: ScrollEdge; by?: { x?: number; y?: number } }) => {
          if (a.to === "top") el.scrollTop = 0;
          else if (a.to === "bottom") el.scrollTop = el.scrollHeight;
          else if (a.to === "left") el.scrollLeft = 0;
          else if (a.to === "right") el.scrollLeft = el.scrollWidth;
          if (a.by) el.scrollBy(a.by.x ?? 0, a.by.y ?? 0);
        },
        { to: args.to, by: args.by },
      );
      const p = await probe(loc, args.target!);
      p.scroll = await elementScrollGeometry(loc);
      return p;
    }
    // window
    await ctx.page.evaluate(
      (a: { to?: ScrollEdge; by?: { x?: number; y?: number } }) => {
        const g: unknown = globalThis;
        const w = g as WindowLike;
        const doc = w.document?.documentElement;
        if (a.to === "top") w.scrollTo(w.scrollX, 0);
        else if (a.to === "bottom") w.scrollTo(w.scrollX, doc ? doc.scrollHeight : 1e9);
        else if (a.to === "left") w.scrollTo(0, w.scrollY);
        else if (a.to === "right") w.scrollTo(doc ? doc.scrollWidth : 1e9, w.scrollY);
        if (a.by) w.scrollBy(a.by.x ?? 0, a.by.y ?? 0);
      },
      { to: args.to, by: args.by },
    );
    return { stillAttached: true, scroll: await windowScrollGeometry(ctx.page) };
  });
}
