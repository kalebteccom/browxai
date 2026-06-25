// Action / navigation tool argument and result-data shapes for the SDK surface.
//
// One section of the `tool-types` split. Shared primitives come from
// `tool-types-shared.js` (the leaf); `ActionDescriptor` (the `execute` payload)
// comes from the read section's `plan` family in `tool-types-read.js`. Neither
// import is the `tool-types.js` barrel that re-exports this file — a back-import
// there would be a cycle. See `tool-types.ts` for the authoritative header.

import type { BrowxaiResult } from "./types.js";
import type {
  ActionOpts,
  Coords,
  RefTarget,
  SessionArg,
  Target,
  TimeoutArg,
} from "./tool-types-shared.js";
import type { ActionDescriptor } from "./tool-types-read.js";

// =============================================================================
// Action / navigation tools
// =============================================================================

/** Shared per-action result envelope (the JSON body of `ActionResult`).
 *  Kept structural so each action tool can refine where useful without
 *  forcing every consumer to re-import a wide tree of interfaces. */
export interface ActionResultData {
  ok: boolean;
  action?: Record<string, unknown>;
  navigation?: Record<string, unknown>;
  structure?: Record<string, unknown>;
  console?: Record<string, unknown>;
  pageErrors?: ReadonlyArray<string>;
  element?: Record<string, unknown>;
  snapshotDelta?: Record<string, unknown>;
  network?: Record<string, unknown>;
  dialogs?: ReadonlyArray<Record<string, unknown>>;
  downloads?: ReadonlyArray<Record<string, unknown>>;
  failure?: { source: string; hint?: string };
  warnings?: ReadonlyArray<string>;
  error?: string | null;
  tokensEstimate?: number;
}
export type ActionResult = BrowxaiResult<ActionResultData>;

// --- navigation -----------------------------------------------------------

export interface NavigateArgs extends ActionOpts {
  url: string;
}
export type NavigateResult = ActionResult;

export type GoBackArgs = ActionOpts;
export type GoForwardArgs = ActionOpts;
export type GoBackResult = ActionResult;
export type GoForwardResult = ActionResult;

export interface ScrollArgs extends ActionOpts {
  ref?: string;
  selector?: string;
  named?: string;
  coords?: Coords;
  contextRef?: string;
  to?: "top" | "bottom" | "left" | "right";
  by?: { x?: number; y?: number };
  intoView?: boolean;
}
export type ScrollResult = ActionResult;

export interface SetViewportArgs extends SessionArg, TimeoutArg {
  width: number;
  height: number;
}
export type SetViewportResult = ActionResult;

// --- click / hover / fill / press / select / shortcut --------------------

export type ClickArgs = Target & ActionOpts & { button?: "left" | "right" | "middle" };
export type ClickResult = ActionResult;

export type HoverArgs = Target & ActionOpts;
export type HoverResult = ActionResult;

export type FillArgs = RefTarget & ActionOpts & { value: string };
export type FillResult = ActionResult;

export type PressArgs = (
  | RefTarget
  | (SessionArg & { ref?: undefined; selector?: undefined; named?: undefined })
) &
  ActionOpts & { key: string };
export type PressResult = ActionResult;

export type SelectArgs = RefTarget & ActionOpts & { values: ReadonlyArray<string> };
export type SelectResult = ActionResult;

export type ChooseOptionArgs = RefTarget & ActionOpts & { option: string; exact?: boolean };
export type ChooseOptionResult = ActionResult;

// --- fill_form ------------------------------------------------------------

export interface FillFormFieldArg {
  ref?: string;
  selector?: string;
  named?: string;
  contextRef?: string;
  value: string;
}
export interface FillFormSubmitArg {
  ref?: string;
  selector?: string;
  named?: string;
  contextRef?: string;
}
export interface FillFormArgs extends ActionOpts {
  fields: ReadonlyArray<FillFormFieldArg>;
  submit?: FillFormSubmitArg;
}
export type FillFormResult = ActionResult;

// --- wait_for / execute ---------------------------------------------------

export interface WaitForArgs extends ActionOpts {
  ref?: string;
  selector?: string;
  named?: string;
  coords?: Coords;
  contextRef?: string;
  text?: string;
}
export type WaitForResult = ActionResult;

export interface ExecuteArgs extends ActionOpts {
  descriptor: ActionDescriptor;
}
export type ExecuteResult = ActionResult;
