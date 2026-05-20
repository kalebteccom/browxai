// Pointer-gesture primitives (W-Q8) — the `unstable` lane.
//
// `click`/`hover` cover taps; media editors and drag-reorder UIs also need
// drag, double-click, and raw mouse down/move/up. These are explicitly
// experimental (capability `unstable`) — shapes may change before promotion.

import type { Page } from "playwright-core";
import type { RefRegistry } from "./refs.js";
import { locatorFor, type ActionTarget } from "./locator.js";

export interface Point { x: number; y: number }

/** Resolve an action target to a viewport point — the element's box centre
 *  for ref/selector, or the literal coords. */
export async function targetPoint(page: Page, refs: RefRegistry, t: ActionTarget): Promise<Point> {
  if (t.coords) return { x: t.coords.x, y: t.coords.y };
  const box = await locatorFor(page, refs, t).boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error("drag/gesture target has no rendered box");
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export interface DragResult { ok: boolean; from: Point; to: Point; steps: number }

/** Press at `from`, move to `to` over `steps` intermediate points, release. */
export async function drag(
  page: Page,
  refs: RefRegistry,
  args: { from: ActionTarget; to: ActionTarget; steps?: number },
): Promise<DragResult> {
  const steps = Math.min(Math.max(args.steps ?? 12, 1), 100);
  const from = await targetPoint(page, refs, args.from);
  const to = await targetPoint(page, refs, args.to);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
  return { ok: true, from, to, steps };
}

export interface DoubleClickResult { ok: boolean; point: Point }

export async function doubleClick(
  page: Page,
  refs: RefRegistry,
  target: ActionTarget,
): Promise<DoubleClickResult> {
  const point = await targetPoint(page, refs, target);
  await page.mouse.dblclick(point.x, point.y);
  return { ok: true, point };
}

export type MouseAction = "down" | "move" | "up";

/** Low-level mouse control for gestures the higher-level tools don't cover
 *  (custom scrub/trim handles). `move` requires coords; `down`/`up` move
 *  there first when coords are given, else act at the current position. */
export async function mouseAction(
  page: Page,
  action: MouseAction,
  coords?: Point,
): Promise<{ ok: boolean; action: MouseAction; coords?: Point }> {
  if (action === "move") {
    if (!coords) throw new Error("mouse_move requires coords");
    await page.mouse.move(coords.x, coords.y);
  } else {
    if (coords) await page.mouse.move(coords.x, coords.y);
    if (action === "down") await page.mouse.down();
    else await page.mouse.up();
  }
  return { ok: true, action, ...(coords ? { coords } : {}) };
}
