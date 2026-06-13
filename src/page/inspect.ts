/// <reference lib="dom" />
// computed-style + box probe.
//
// Layout-break and control-state bugs (a flex row losing a child →
// misalignment; `cursor-wait` vs `cursor-not-allowed`; a label that clips /
// overflows) need computed style + box geometry, which the curated surface
// doesn't otherwise expose. `inspect` is a read primitive returning a
// *whitelisted* style set + box + overflow/clip state — generalizes the
// visible-rect work to "is this visually broken".

import type { Locator } from "playwright-core";

/** Always-returned style keys — the ones layout/control-state bugs hinge on.
 *  Callers can request extra properties via `extra`. */
export const DEFAULT_STYLE_KEYS = [
  "display",
  "visibility",
  "opacity",
  "position",
  "cursor",
  "pointerEvents",
  "overflow",
  "overflowX",
  "overflowY",
  "zIndex",
  "flexDirection",
  "justifyContent",
  "alignItems",
] as const;

export interface InspectResult {
  found: boolean;
  /** Bounding box in CSS px (raw getBoundingClientRect — not viewport-clipped;
   *  use `find()`'s visible-rect bbox when you need the clipped version). */
  box?: { x: number; y: number; width: number; height: number };
  styles?: Record<string, string>;
  /** True when the element overflows its own padding box on either axis
   *  (scrollWidth/Height > clientWidth/Height) — the "label clips / content
   *  overflows" signal. */
  overflowing?: { x: boolean; y: boolean };
  /** Cheap visibility read: non-zero box + not display:none/visibility:hidden
   *  + opacity > 0. Not the full visible-rect intersection (that's `find`). */
  visible?: boolean;
  childCount?: number;
}

/**
 * Read the whitelisted computed styles + box for a resolved element. Pure
 * read (no action window). `extra` appends caller-requested style properties
 * to the default set. Returns `{ found:false }` when the locator matches
 * nothing.
 */
export async function inspectElement(loc: Locator, extra: string[] = []): Promise<InspectResult> {
  try {
    if ((await loc.count()) === 0) return { found: false };
    const keys = [...DEFAULT_STYLE_KEYS, ...extra];
    return await loc
      .evaluate((e: Element, styleKeys: string[]): InspectResult => {
        // CSS property names read back from a computed style as strings; this
        // selects just the string-valued members of CSSStyleDeclaration so the
        // dynamic `cs[k]` read is a `string` (not one of its method members).
        type StringStyleKey = {
          [K in keyof CSSStyleDeclaration]: CSSStyleDeclaration[K] extends string ? K : never;
        }[keyof CSSStyleDeclaration];
        const cs = getComputedStyle(e);
        const styles: Record<string, string> = {};
        for (const k of styleKeys) {
          try {
            styles[k] = String(cs[k as StringStyleKey]);
          } catch {
            /* unknown prop — skip */
          }
        }
        const r = e.getBoundingClientRect();
        const box = { x: r.x, y: r.y, width: r.width, height: r.height };
        const overflowing = {
          x: e.scrollWidth > e.clientWidth + 1,
          y: e.scrollHeight > e.clientHeight + 1,
        };
        const visible =
          box.width > 0 &&
          box.height > 0 &&
          styles.display !== "none" &&
          styles.visibility !== "hidden" &&
          Number(styles.opacity || "1") > 0;
        return {
          found: true,
          box,
          styles,
          overflowing,
          visible,
          childCount: e.childElementCount,
        };
      }, keys)
      .catch((): InspectResult => ({ found: false }));
  } catch {
    return { found: false };
  }
}
