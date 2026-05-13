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

async function probe(loc: Locator, target: ActionTarget, justFilled?: string): Promise<ElementProbe> {
  const ref = target.ref;
  try {
    const count = await loc.count();
    if (count === 0) return { ref, stillAttached: false };
    // Run in page context — TS doesn't have DOM lib here, so cast loosely.
    const focused = await loc
      .evaluate((el: { ownerDocument?: { activeElement?: unknown } }) => el === el.ownerDocument?.activeElement)
      .catch(() => false);
    const value = justFilled !== undefined
      ? justFilled
      : await loc.inputValue().catch(() => null);
    return { ref, stillAttached: true, focused, value: value ?? null };
  } catch {
    return { ref, stillAttached: false };
  }
}
