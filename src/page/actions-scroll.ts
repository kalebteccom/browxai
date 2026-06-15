// Scroll geometry helpers for the `scroll` action — post-scroll geometry of the
// window/document scroller and of a scroll-container element. Split out of
// actions.ts so that file stays under the size budget; behavior-identical.
//
// These scripts run in the browser where TS's DOM lib is intentionally NOT in
// scope, so the structural shape each one touches is described precisely and
// `unknown` runtime values are narrowed via real guards.

import type { Locator, Page } from "playwright-core";
import type { ElementProbe } from "./actionresult.js";

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
