// Action primitives. Each wraps a Playwright `Locator` action in the
// action-window machinery from actionresult.ts so callers always get a
// structured `ActionResult` instead of a bare "ok".

import type { Locator } from "playwright-core";
import {
  runInActionWindow,
  type ActionContext,
  type ActionDescriptor,
  type ActionResult,
  type ActionWindowOptions,
  type ElementProbe,
} from "./actionresult.js";
import { locatorFor, type ActionTarget } from "./locator.js";

const DEFAULT_TIMEOUT_MS = 8_000;

export interface ClickArgs extends ActionWindowOptions { target: ActionTarget; }
export async function click(ctx: ActionContext, args: ClickArgs): Promise<ActionResult> {
  const descriptor: ActionDescriptor = { type: "click", ...refOrSelector(args.target) };
  return runInActionWindow(ctx, descriptor, args, async () => {
    const loc = locatorFor(ctx.page, ctx.refs, args.target);
    await loc.click({ timeout: DEFAULT_TIMEOUT_MS });
    return probe(loc, args.target);
  });
}

export interface FillArgs extends ActionWindowOptions { target: ActionTarget; value: string; }
export async function fill(ctx: ActionContext, args: FillArgs): Promise<ActionResult> {
  const descriptor: ActionDescriptor = { type: "fill", value: args.value, ...refOrSelector(args.target) };
  return runInActionWindow(ctx, descriptor, args, async () => {
    const loc = locatorFor(ctx.page, ctx.refs, args.target);
    await loc.fill(args.value, { timeout: DEFAULT_TIMEOUT_MS });
    return probe(loc, args.target, args.value);
  });
}

export interface NavigateArgs extends ActionWindowOptions { url: string; }
export async function navigate(ctx: ActionContext, args: NavigateArgs): Promise<ActionResult> {
  const descriptor: ActionDescriptor = { type: "navigate", url: args.url };
  return runInActionWindow(ctx, descriptor, args, async () => {
    await ctx.page.goto(args.url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
  });
}

export interface PressArgs extends ActionWindowOptions { target?: ActionTarget; key: string; }
export async function press(ctx: ActionContext, args: PressArgs): Promise<ActionResult> {
  const descriptor: ActionDescriptor = { type: "press", value: args.key, ...(args.target ? refOrSelector(args.target) : {}) };
  return runInActionWindow(ctx, descriptor, args, async () => {
    if (args.target) {
      const loc = locatorFor(ctx.page, ctx.refs, args.target);
      await loc.press(args.key, { timeout: DEFAULT_TIMEOUT_MS });
      return probe(loc, args.target);
    } else {
      await ctx.page.keyboard.press(args.key);
    }
  });
}

export interface HoverArgs extends ActionWindowOptions { target: ActionTarget; }
export async function hover(ctx: ActionContext, args: HoverArgs): Promise<ActionResult> {
  const descriptor: ActionDescriptor = { type: "hover", ...refOrSelector(args.target) };
  return runInActionWindow(ctx, descriptor, args, async () => {
    const loc = locatorFor(ctx.page, ctx.refs, args.target);
    await loc.hover({ timeout: DEFAULT_TIMEOUT_MS });
    return probe(loc, args.target);
  });
}

export interface SelectArgs extends ActionWindowOptions { target: ActionTarget; values: string[]; }
export async function select(ctx: ActionContext, args: SelectArgs): Promise<ActionResult> {
  const descriptor: ActionDescriptor = { type: "select", value: args.values.join(", "), ...refOrSelector(args.target) };
  return runInActionWindow(ctx, descriptor, args, async () => {
    const loc = locatorFor(ctx.page, ctx.refs, args.target);
    await loc.selectOption(args.values, { timeout: DEFAULT_TIMEOUT_MS });
    return probe(loc, args.target);
  });
}

export interface WaitForArgs extends ActionWindowOptions { target: ActionTarget; timeoutMs?: number; }
export async function waitFor(ctx: ActionContext, args: WaitForArgs): Promise<ActionResult> {
  const descriptor: ActionDescriptor = { type: "waitFor", ...refOrSelector(args.target) };
  return runInActionWindow(ctx, descriptor, args, async () => {
    const loc = locatorFor(ctx.page, ctx.refs, args.target);
    await loc.waitFor({ state: "visible", timeout: args.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    return probe(loc, args.target);
  });
}

export interface GoBackArgs extends ActionWindowOptions {}
export async function goBack(ctx: ActionContext, args: GoBackArgs = {}): Promise<ActionResult> {
  return runInActionWindow(ctx, { type: "goBack" }, args, async () => {
    await ctx.page.goBack({ waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
  });
}

export interface GoForwardArgs extends ActionWindowOptions {}
export async function goForward(ctx: ActionContext, args: GoForwardArgs = {}): Promise<ActionResult> {
  return runInActionWindow(ctx, { type: "goForward" }, args, async () => {
    await ctx.page.goForward({ waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
  });
}

// ---------- helpers ----------

function refOrSelector(t: ActionTarget): { ref?: string; selector?: string } {
  return t.ref ? { ref: t.ref } : { selector: t.selector };
}

/**
 * Always read post-action DOM state so callers can confirm a write landed
 * without a follow-up `snapshot`/`screenshot` round-trip. We deliberately
 * do not echo back `valueRequested` as `value` — the probe must report what
 * the DOM actually holds, not what the caller asked for.
 *
 * Exported for unit tests.
 */
export async function probe(loc: Locator, target: ActionTarget, valueRequested?: string): Promise<ElementProbe> {
  const ref = target.ref;
  try {
    const count = await loc.count();
    if (count === 0) return { ref, stillAttached: false };
    // Run in page context — TS doesn't have DOM lib here, so cast loosely.
    const focused = await loc
      .evaluate((el: { ownerDocument?: { activeElement?: unknown } }) => el === el.ownerDocument?.activeElement)
      .catch(() => false);
    // Always probe DOM `value` directly. `loc.inputValue()` is defined for
    // <input>/<textarea>/<select>; for everything else it throws, so we null
    // it out via the catch. Contenteditable falls through to textContent.
    const inputValue = await loc.inputValue().catch(() => undefined);
    const value = inputValue !== undefined
      ? inputValue
      : await loc
          .evaluate((el: { isContentEditable?: boolean; textContent?: string | null }) =>
            el.isContentEditable ? (el.textContent ?? "") : null,
          )
          .catch(() => null);
    const checked = await loc
      .evaluate((el: { tagName?: string; type?: string; checked?: boolean; indeterminate?: boolean }) => {
        const tag = el.tagName?.toLowerCase();
        const type = el.type?.toLowerCase();
        if (tag !== "input" || (type !== "checkbox" && type !== "radio")) return undefined;
        if (el.indeterminate) return "mixed" as const;
        return el.checked === true;
      })
      .catch(() => undefined);
    // Visible-wrapper text. Covers controls that render the post-action state
    // outside `input.value` (chip-style selects, combobox displays, badge
    // pickers, custom dropdowns that clear the underlying input on commit).
    // Walks up to 4 ancestors looking for a labelled node (role attr or
    // `data-testid|test|cy|qa`); falls back to immediate parent's innerText.
    // Capped at 200 chars.
    const displayText = await loc
      .evaluate((el: unknown) => {
        const DOC_BODY_TAG = "BODY";
        const isElement = (n: unknown): n is { parentElement: unknown; tagName?: string; getAttribute?: (k: string) => string | null; dataset?: Record<string, string | undefined>; innerText?: string } =>
          !!n && typeof n === "object";
        type ElLike = { parentElement: unknown; tagName?: string; getAttribute?: (k: string) => string | null; dataset?: Record<string, string | undefined>; innerText?: string };
        let cur: ElLike | null = isElement(el) ? el : null;
        for (let i = 0; i < 4 && cur; i++) {
          const next = cur.parentElement;
          if (!isElement(next) || next.tagName === DOC_BODY_TAG) break;
          cur = next;
          const role = cur.getAttribute?.("role") || null;
          const ds = cur.dataset || {};
          if (role || ds.testid || ds.test || ds.cy || ds.qa) {
            const t = (cur.innerText || "").trim();
            return t ? t.slice(0, 200) : null;
          }
        }
        if (isElement(el)) {
          const parent = el.parentElement;
          if (isElement(parent)) {
            const t = (parent.innerText || "").trim();
            return t ? t.slice(0, 200) : null;
          }
        }
        return null;
      })
      .catch(() => null);
    const out: ElementProbe = { ref, stillAttached: true, focused, value: value ?? null };
    if (checked !== undefined) out.checked = checked;
    if (valueRequested !== undefined) out.valueRequested = valueRequested;
    if (displayText !== null) out.displayText = displayText;
    return out;
  } catch {
    return { ref, stillAttached: false };
  }
}
