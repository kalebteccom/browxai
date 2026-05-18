// Action primitives. Each wraps a Playwright `Locator` action in the
// action-window machinery from actionresult.ts so callers always get a
// structured `ActionResult` instead of a bare "ok".

import type { Locator, Page } from "playwright-core";
import {
  runInActionWindow,
  type ActionContext,
  type ActionDescriptor,
  type ActionResult,
  type ActionWindowOptions,
  type ElementProbe,
  type HitPoint,
} from "./actionresult.js";
import { locatorFor, resolveTarget, type ActionTarget } from "./locator.js";

const DEFAULT_TIMEOUT_MS = 8_000;

export interface ClickArgs extends ActionWindowOptions { target: ActionTarget; button?: "left" | "right" | "middle"; }
export async function click(ctx: ActionContext, args: ClickArgs): Promise<ActionResult> {
  const descriptor: ActionDescriptor = { type: "click", ...targetDescriptor(args.target) };
  return runInActionWindow(ctx, descriptor, args, async () => {
    const resolved = resolveTarget(ctx.page, ctx.refs, args.target);
    if (resolved.kind === "coords") {
      const hitBefore = await captureHit(ctx.page, resolved.x, resolved.y);
      const focusBefore = await captureFocusedRef(ctx.page);
      await ctx.page.mouse.click(resolved.x, resolved.y, args.button ? { button: args.button } : undefined);
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
    await resolved.loc.click({ timeout: DEFAULT_TIMEOUT_MS, button: args.button });
    return probe(resolved.loc, args.target, undefined, pre);
  });
}

export interface FillArgs extends ActionWindowOptions { target: ActionTarget; value: string; }
export async function fill(ctx: ActionContext, args: FillArgs): Promise<ActionResult> {
  const descriptor: ActionDescriptor = { type: "fill", value: args.value, ...refOrSelector(args.target) };
  return runInActionWindow(ctx, descriptor, args, async () => {
    const loc = locatorFor(ctx.page, ctx.refs, args.target);
    const pre = await preProbe(loc);
    await loc.fill(args.value, { timeout: DEFAULT_TIMEOUT_MS });
    return probe(loc, args.target, args.value, pre);
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
      const pre = await preProbe(loc);
      await loc.press(args.key, { timeout: DEFAULT_TIMEOUT_MS });
      return probe(loc, args.target, undefined, pre);
    } else {
      await ctx.page.keyboard.press(args.key);
    }
  });
}

export interface HoverArgs extends ActionWindowOptions { target: ActionTarget; }
export async function hover(ctx: ActionContext, args: HoverArgs): Promise<ActionResult> {
  const descriptor: ActionDescriptor = { type: "hover", ...targetDescriptor(args.target) };
  return runInActionWindow(ctx, descriptor, args, async () => {
    const resolved = resolveTarget(ctx.page, ctx.refs, args.target);
    if (resolved.kind === "coords") {
      const hitBefore = await captureHit(ctx.page, resolved.x, resolved.y);
      await ctx.page.mouse.move(resolved.x, resolved.y);
      const hitAfter = await captureHit(ctx.page, resolved.x, resolved.y);
      return { stillAttached: true, hit: { before: hitBefore, after: hitAfter } };
    }
    const pre = await preProbe(resolved.loc);
    await resolved.loc.hover({ timeout: DEFAULT_TIMEOUT_MS });
    return probe(resolved.loc, args.target, undefined, pre);
  });
}

export interface SelectArgs extends ActionWindowOptions { target: ActionTarget; values: string[]; }
export async function select(ctx: ActionContext, args: SelectArgs): Promise<ActionResult> {
  const descriptor: ActionDescriptor = { type: "select", value: args.values.join(", "), ...refOrSelector(args.target) };
  return runInActionWindow(ctx, descriptor, args, async () => {
    const loc = locatorFor(ctx.page, ctx.refs, args.target);
    const pre = await preProbe(loc);
    await loc.selectOption(args.values, { timeout: DEFAULT_TIMEOUT_MS });
    return probe(loc, args.target, undefined, pre);
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
    throw new Error("scroll: no-op — pass `to` (top|bottom|left|right) or `by` {x,y}, or a `target` to scroll into view");
  }
  return { kind: "window" };
}

export async function scroll(ctx: ActionContext, args: ScrollArgs): Promise<ActionResult> {
  const descriptor: ActionDescriptor = {
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
      return { stillAttached: true };
    }
    if (mode.kind === "into-view") {
      const loc = locatorFor(ctx.page, ctx.refs, args.target!);
      await loc.scrollIntoViewIfNeeded({ timeout: DEFAULT_TIMEOUT_MS });
      return probe(loc, args.target!);
    }
    if (mode.kind === "container") {
      const loc = locatorFor(ctx.page, ctx.refs, args.target!);
      await loc.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (el: any, a: { to?: ScrollEdge; by?: { x?: number; y?: number } }) => {
          if (a.to === "top") el.scrollTop = 0;
          else if (a.to === "bottom") el.scrollTop = el.scrollHeight;
          else if (a.to === "left") el.scrollLeft = 0;
          else if (a.to === "right") el.scrollLeft = el.scrollWidth;
          if (a.by) el.scrollBy(a.by.x ?? 0, a.by.y ?? 0);
        },
        { to: args.to, by: args.by },
      );
      return probe(loc, args.target!);
    }
    // window
    await ctx.page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (a: { to?: ScrollEdge; by?: { x?: number; y?: number } }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = globalThis as any;
        const doc = w.document?.documentElement;
        if (a.to === "top") w.scrollTo(w.scrollX, 0);
        else if (a.to === "bottom") w.scrollTo(w.scrollX, doc ? doc.scrollHeight : 1e9);
        else if (a.to === "left") w.scrollTo(0, w.scrollY);
        else if (a.to === "right") w.scrollTo(doc ? doc.scrollWidth : 1e9, w.scrollY);
        if (a.by) w.scrollBy(a.by.x ?? 0, a.by.y ?? 0);
      },
      { to: args.to, by: args.by },
    );
    return { stillAttached: true };
  });
}

export interface ChooseOptionArgs extends ActionWindowOptions {
  target: ActionTarget;
  option: string;
  exact?: boolean;
}

/**
 * W-F3 — `choose_option` primitive. Generic combobox/listbox/menu selection
 * for custom controls that aren't native `<select>` (so the existing `select`
 * tool can't drive them). The pattern: open the target control, wait for a
 * visible listbox/menu/portal, find the option element by exact text, click
 * it, return the W-F2 probe on the *trigger* so `ownerControl.displayText`
 * shows the committed selection.
 *
 * Falls back across `role=option` → `role=menuitem` → `getByText` so works
 * on any reasonable combobox shape. Does **not** simulate keyboard navigation
 * (type-and-press-Enter) — that's a different primitive and prone to picking
 * the wrong option in dense lists.
 */
export async function chooseOption(ctx: ActionContext, args: ChooseOptionArgs): Promise<ActionResult> {
  const descriptor: ActionDescriptor = { type: "chooseOption", value: args.option, ...targetDescriptor(args.target) };
  return runInActionWindow(ctx, descriptor, args, async () => {
    if (args.target.coords) {
      throw new Error("choose_option requires a ref/selector/named target (the combobox/menu trigger), not coords");
    }
    const trigger = locatorFor(ctx.page, ctx.refs, args.target);
    const pre = await preProbe(trigger);

    // Open the control if not already expanded. `aria-expanded` is the strongest
    // signal; absence isn't proof it's closed, so we still click if false-or-missing.
    const isExpanded = await trigger
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .evaluate((el: any) => el.getAttribute && el.getAttribute("aria-expanded") === "true")
      .catch(() => false);
    if (!isExpanded) {
      await trigger.click({ timeout: DEFAULT_TIMEOUT_MS });
    }

    const optionLoc = await resolveOption(ctx.page, args.option, args.exact ?? true);
    await optionLoc.click({ timeout: DEFAULT_TIMEOUT_MS });

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
  if (t.ref) return { ref: t.ref };
  if (t.selector) return { selector: t.selector };
  return {};
}

function targetDescriptor(t: ActionTarget): { ref?: string; selector?: string } {
  // ActionDescriptor's `ref`/`selector` fields are advisory metadata for the
  // recording layer; coords targets simply omit them.
  return refOrSelector(t);
}

/** State captured *before* the action runs so the post-action probe can compute
 *  before/after deltas for `ownerControl` / `container`. */
export interface PreProbeData {
  ownerLabel?: string;
  ownerText?: string;
  container?: { kind: string; rowKey?: string; rowText?: string };
}

/**
 * Capture the pre-action state of the owning control and the enclosing
 * repeated container, so the post-action probe can emit `changed` flags
 * without the caller having to re-snapshot.
 *
 * Exported for unit tests; runs at the DOM level (cheap, no a11y tree).
 */
export async function preProbe(loc: Locator): Promise<PreProbeData> {
  try {
    const count = await loc.count();
    if (count === 0) return {};
    return await loc.evaluate(probeAncestorsScript).catch(() => ({}));
  } catch {
    return {};
  }
}

/**
 * Always read post-action DOM state so callers can confirm a write landed
 * without a follow-up `snapshot`/`screenshot` round-trip. We deliberately
 * do not echo back `valueRequested` as `value` — the probe must report what
 * the DOM actually holds, not what the caller asked for.
 *
 * Exported for unit tests.
 */
export async function probe(loc: Locator, target: ActionTarget, valueRequested?: string, pre?: PreProbeData): Promise<ElementProbe> {
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

    // W-F2: post-action owner/container state. Always read; compose deltas
    // against `pre` when supplied. Same in-page script as preProbe, so the
    // pre/post values are directly comparable.
    const post = await loc.evaluate(probeAncestorsScript).catch(() => ({} as PreProbeData));
    if (pre && (pre.ownerText !== undefined || post.ownerText !== undefined)) {
      const before = pre.ownerText;
      const after = post.ownerText;
      const oc: NonNullable<ElementProbe["ownerControl"]> = { changed: before !== after };
      if (post.ownerLabel ?? pre.ownerLabel) oc.label = post.ownerLabel ?? pre.ownerLabel;
      if (before !== undefined) oc.displayTextBefore = before;
      if (after !== undefined) oc.displayTextAfter = after;
      out.ownerControl = oc;
    }
    if (post.container) {
      const cont: NonNullable<ElementProbe["container"]> = {
        kind: post.container.kind,
        ...(post.container.rowKey ? { rowKey: post.container.rowKey } : {}),
        ...(post.container.rowText !== undefined ? { rowText: post.container.rowText } : {}),
      };
      if (pre?.container) {
        cont.changed = pre.container.rowText !== post.container.rowText;
      }
      out.container = cont;
    }
    return out;
  } catch {
    return { ref, stillAttached: false };
  }
}

/**
 * In-page script used by `preProbe` and the post-action half of `probe`.
 * Walks up the target element's ancestor chain looking for:
 *   - The nearest owning **form control** (combobox / listbox / radiogroup /
 *     labelled `data-test*` wrapper) — `ownerText` is its `innerText`.
 *   - The nearest repeated **container** (`role=row`/`listitem`/`article`,
 *     or `<tr>`/`<li>` tags) — `container.rowText` is its `innerText`.
 *
 * Capped at 6 ancestor steps and 200 chars per text field. Returns an empty
 * object when nothing matches.
 *
 * Defined as a plain function (not an arrow) so Playwright can stringify it
 * across the CDP boundary cleanly. `el: any` because we run in DOM context
 * where TS's DOM lib isn't loaded; the runtime check is what matters.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const probeAncestorsScript = function probeAncestors(el: any): PreProbeData {
  if (!el || typeof el !== "object") return {};
  const OWNER_ROLES = new Set(["combobox", "listbox", "radiogroup", "group", "menu", "tablist"]);
  const ROW_ROLES = new Set(["row", "listitem", "article"]);
  const ROW_TAGS = new Set(["tr", "li"]);
  const out: PreProbeData = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = el.parentElement;
  for (let i = 0; i < 6 && cur && cur.tagName !== "BODY" && cur.tagName !== "HTML"; i++) {
    const role: string | null = cur.getAttribute ? cur.getAttribute("role") : null;
    const ds = cur.dataset || {};
    const hasTestAttr = !!(ds.testid || ds.test || ds.cy || ds.qa);
    const ariaLabel: string | null = cur.getAttribute ? cur.getAttribute("aria-label") : null;

    if (!out.ownerText) {
      const isFieldOwner = (role && OWNER_ROLES.has(role)) || (hasTestAttr && (role || ariaLabel));
      if (isFieldOwner) {
        const txt = ((cur.innerText || "") as string).trim();
        if (txt) out.ownerText = txt.length > 200 ? txt.slice(0, 199) + "…" : txt;
        if (ariaLabel) out.ownerLabel = ariaLabel;
      }
    }

    if (!out.container) {
      const tag = cur.tagName ? (cur.tagName as string).toLowerCase() : "";
      if ((role && ROW_ROLES.has(role)) || ROW_TAGS.has(tag)) {
        const kind = (role && ROW_ROLES.has(role)) ? role : tag;
        const rowText = ((cur.innerText || "") as string).trim().replace(/\s+/g, " ");
        const capped = rowText.length > 200 ? rowText.slice(0, 199) + "…" : rowText;
        // rowKey = first non-empty text node within the container.
        let rowKey: string | undefined;
        const firstText = (cur.innerText || "").trim().split("\n").find((s: string) => s.trim().length > 0);
        if (firstText) {
          const t = firstText.trim();
          rowKey = t.length > 80 ? t.slice(0, 79) + "…" : t;
        }
        const containerOut: { kind: string; rowKey?: string; rowText?: string } = { kind };
        if (rowKey) containerOut.rowKey = rowKey;
        if (capped) containerOut.rowText = capped;
        out.container = containerOut;
      }
    }

    if (out.ownerText && out.container) break;
    cur = cur.parentElement;
  }
  return out;
};

/** Coordinate-action evidence helper: read `document.elementFromPoint` at (x,y)
 *  with role/text/ancestor context. Returns null when nothing's there.
 *  Uses `any` for the in-page DOM side — TS's DOM lib isn't loaded here. */
async function captureHit(page: Page, x: number, y: number): Promise<HitPoint | null> {
  return page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ x, y }: { x: number; y: number }): HitPoint | null => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc: any = (globalThis as any).document;
      if (!doc) return null;
      const el = doc.elementFromPoint(x, y);
      if (!el) return null;
      const tag: string = (el.tagName || "").toLowerCase();
      const role: string | undefined = el.getAttribute ? el.getAttribute("role") || undefined : undefined;
      const text = ((el.textContent || "") as string).trim().replace(/\s+/g, " ").slice(0, 120);
      const parent = el.parentElement;
      const ancestorText = parent
        ? ((parent.innerText || "") as string).trim().replace(/\s+/g, " ").slice(0, 200)
        : undefined;
      const out: HitPoint = { tag };
      if (role) out.role = role;
      if (text) out.text = text;
      if (ancestorText) out.ancestorText = ancestorText;
      return out;
    },
    { x, y },
  ).catch(() => null);
}

/** Best-effort identity for the active element so we can report whether focus
 *  shifted during a coord action. Returns a stable-ish key (tag + id + role +
 *  testid + first text). */
async function captureFocusedRef(page: Page): Promise<string | null> {
  return page.evaluate((): string | null => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc: any = (globalThis as any).document;
    if (!doc) return null;
    const a = doc.activeElement;
    if (!a) return null;
    const id: string = a.id || "";
    const role: string = a.getAttribute ? (a.getAttribute("role") || "") : "";
    const testid: string = a.getAttribute
      ? (a.getAttribute("data-testid") || a.getAttribute("data-test") || a.getAttribute("data-cy") || "")
      : "";
    const tag: string = (a.tagName || "").toLowerCase();
    const txt = ((a.textContent || "") as string).trim().slice(0, 60);
    return `${tag}#${id}@${role}[${testid}]:${txt}`;
  }).catch(() => null);
}
