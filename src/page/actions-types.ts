// The action argument vocabulary — the twelve verb argument shapes the
// ActionSubstrate port declares, plus the target descriptor they all name.
//
// This module exists because of a dependency-direction defect: the port
// (`action-substrate-types.ts`) used to take its whole argument vocabulary from
// `actions.ts` via `import type * as actions`, and `actions.ts` IS the
// Playwright adapter body — it imports `Page` and `Locator` and calls
// `page.mouse.click` / `page.getByRole`. A port whose signatures are defined by
// one of its own implementations is not a port; it is that implementation's
// header file, and no second engine could satisfy it without matching
// Playwright's shape. Safari's implementation reads the same argument types and
// drives WebDriver Classic with them, which only works because the shapes are
// plain data. So the shapes live here, above both adapters, and both adapters
// import them. (RFC 0009 P1.)
//
// Every declaration is plain data: strings, numbers, unions. Nothing here
// reaches playwright-core, which the `ports-name-no-vendor-type`
// dependency-cruiser rule enforces reachably. `actions.ts`, `actions-scroll.ts`,
// `locator.ts` and `actions-direct-dispatch.ts` re-export their own names from
// here so existing importers are unchanged.

import type { ActionWindowOptions } from "./actionresult-types.js";

/**
 * Action target shape. Exactly one of `ref` / `selector` / `coords` is
 * required. `contextRef` optionally scopes a `selector` to the subtree of a
 * prior ref — lets callers say "the [data-testid=...] *inside this row*"
 * without baking positional `:nth` chains into the selector. `coords` is the
 * escape hatch for visually-located targets (canvas, custom-painted UIs,
 * dismiss-empty-space) that ref/selector resolution genuinely can't address.
 */
export type ActionTarget =
  | { ref: string; selector?: undefined; contextRef?: undefined; coords?: undefined }
  | { selector: string; ref?: undefined; contextRef?: string; coords?: undefined }
  | {
      coords: { x: number; y: number };
      ref?: undefined;
      selector?: undefined;
      contextRef?: undefined;
    };

/** How a click reaches the element. `"actionability"` (the default) goes
 *  through the engine's locator engine with its pre-dispatch checks;
 *  `"direct"` skips them and dispatches at a measured point. An engine with no
 *  raw-CDP handle refuses `"direct"` structurally rather than degrading. */
export type ClickDispatch = "actionability" | "direct";

export interface ClickArgs extends ActionWindowOptions {
  target: ActionTarget;
  button?: "left" | "right" | "middle";
  force?: boolean;
  /** Unset / `"actionability"` is the default path, byte-identical to a call
   *  that never names it. `"direct"` skips the locator engine's pre-dispatch
   *  work — the action substrate refuses it on an engine with no CDP handle
   *  before the primitive is reached. */
  dispatch?: ClickDispatch;
}

export interface FillArgs extends ActionWindowOptions {
  target: ActionTarget;
  value: string;
}

export interface NavigateArgs extends ActionWindowOptions {
  url: string;
}

export interface PressArgs extends ActionWindowOptions {
  target?: ActionTarget;
  key: string;
}

export interface HoverArgs extends ActionWindowOptions {
  target: ActionTarget;
}

export interface SelectArgs extends ActionWindowOptions {
  target: ActionTarget;
  values: string[];
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

export interface SetViewportArgs extends ActionWindowOptions {
  width: number;
  height: number;
}

export interface ChooseOptionArgs extends ActionWindowOptions {
  target: ActionTarget;
  option: string;
  exact?: boolean;
}

export type GoBackArgs = ActionWindowOptions;
export type GoForwardArgs = ActionWindowOptions;

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
  { kind: "into-view" } | { kind: "container" } | { kind: "wheel-at" } | { kind: "window" };
