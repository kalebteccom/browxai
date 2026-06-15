// Post-action element probing — `preProbe` / `probe` capture the DOM state of
// the targeted element (and its owning control / repeated container) before and
// after an action, plus the coord-action evidence helpers `captureHit` /
// `captureFocusedRef`. Split out of actions.ts so that file stays under the size
// budget; behavior-identical to the prior inline form.
//
// These functions are stringified and executed in the browser, where TS's DOM
// lib is intentionally NOT in scope (tsconfig `lib: ["ES2022"]`). Rather than
// fall back to `any`, the precise structural shape each in-page script touches is
// described and `unknown` runtime values are narrowed into it via real
// `typeof`/`in` guards. Behaviour is unchanged — these types are erased.

import type { Locator, Page } from "playwright-core";
import type { ElementProbe, HitPoint } from "./actionresult.js";
import type { ActionTarget } from "./locator.js";

/** Minimal structural view of `document` as used by the in-page scripts. */
interface DocumentLike {
  readonly activeElement?: FocusableEl | null;
  elementFromPoint: (x: number, y: number) => HitEl | null;
}

/** Minimal structural view of `window`/`globalThis` as used by the scripts. */
interface WindowLike {
  readonly document?: DocumentLike;
}

/** Element shape read by `captureHit` (document.elementFromPoint result). */
interface HitEl {
  readonly tagName?: string;
  getAttribute?: (k: string) => string | null;
  readonly textContent?: string | null;
  readonly parentElement?: { readonly innerText?: string } | null;
}

/** Element shape read by `captureFocusedRef` (document.activeElement). */
interface FocusableEl {
  readonly id?: string;
  getAttribute?: (k: string) => string | null;
  readonly tagName?: string;
  readonly textContent?: string | null;
}

/** Ancestor element shape walked by `probeAncestorsScript`. */
interface AncestorEl {
  readonly parentElement?: AncestorEl | null;
  readonly tagName?: string;
  getAttribute?: (k: string) => string | null;
  readonly dataset?: Record<string, string | undefined>;
  readonly innerText?: string;
}

export interface PreProbeData {
  ownerLabel?: string;
  ownerText?: string;
  container?: { kind: string; rowKey?: string; rowText?: string };
}

// Post-action probe runs MULTIPLE `loc.evaluate()` calls — each defaults to
// Playwright's 30s timeout. On busy SPAs where re-renders re-attach the element
// handle constantly, a probe evaluate can hang far longer than makes sense for a
// read-only check. Bound each evaluate to PROBE_EVAL_MS so a stuck probe returns
// partial data instead of consuming the whole action deadline.
const PROBE_EVAL_MS = 1500;

/** In-page: post-action checkbox/radio checked state (or "mixed"). */
const checkedScript = (el: {
  tagName?: string;
  type?: string;
  checked?: boolean;
  indeterminate?: boolean;
}): boolean | "mixed" | undefined => {
  const tag = el.tagName?.toLowerCase();
  const type = el.type?.toLowerCase();
  if (tag !== "input" || (type !== "checkbox" && type !== "radio")) return undefined;
  if (el.indeterminate) return "mixed" as const;
  return el.checked === true;
};

/** In-page: visible-wrapper text for controls that render state outside
 *  `input.value` (chip selects, combobox displays, badge pickers). Walks up to 4
 *  ancestors for a labelled node (role attr or `data-testid|test|cy|qa`); falls
 *  back to the immediate parent's innerText. Capped at 200 chars. */
const displayTextScript = (el: unknown): string | null => {
  const DOC_BODY_TAG = "BODY";
  type ElLike = {
    parentElement: unknown;
    tagName?: string;
    getAttribute?: (k: string) => string | null;
    dataset?: Record<string, string | undefined>;
    innerText?: string;
  };
  const isElement = (n: unknown): n is ElLike => !!n && typeof n === "object";
  const isLabelled = (e: ElLike): boolean => {
    const role = e.getAttribute?.("role") || null;
    const ds = e.dataset || {};
    return !!(role || ds.testid || ds.test || ds.cy || ds.qa);
  };
  const cappedText = (e: ElLike): string | null => {
    const t = (e.innerText || "").trim();
    return t ? t.slice(0, 200) : null;
  };
  let cur: ElLike | null = isElement(el) ? el : null;
  for (let i = 0; i < 4 && cur; i++) {
    const next = cur.parentElement;
    if (!isElement(next) || next.tagName === DOC_BODY_TAG) break;
    cur = next;
    if (isLabelled(cur)) return cappedText(cur);
  }
  if (isElement(el) && isElement(el.parentElement)) return cappedText(el.parentElement);
  return null;
};

/**
 * Capture the pre-action state of the owning control and the enclosing repeated
 * container, so the post-action probe can emit `changed` flags without the
 * caller re-snapshotting. Exported for unit tests; runs at the DOM level.
 */
export async function preProbe(loc: Locator): Promise<PreProbeData> {
  // Same 1.5s bound as `probe` — see PROBE_EVAL_MS rationale.
  try {
    const count = await loc.count();
    if (count === 0) return {};
    return await loc.evaluate(probeAncestorsScript, undefined, { timeout: 1500 }).catch(() => ({}));
  } catch {
    return {};
  }
}

/** Read the post-action value (input.value / contenteditable text / null). */
async function readProbeValue(loc: Locator): Promise<string | null> {
  const inputValue = await loc.inputValue({ timeout: PROBE_EVAL_MS }).catch(() => undefined);
  if (inputValue !== undefined) return inputValue;
  return loc
    .evaluate(
      (el: { isContentEditable?: boolean; textContent?: string | null }) =>
        el.isContentEditable ? (el.textContent ?? "") : null,
      undefined,
      { timeout: PROBE_EVAL_MS },
    )
    .catch(() => null);
}

/** Fold the post-action owner/container ancestor state into the probe, composing
 *  `changed` deltas against the pre-action snapshot when one was supplied. */
function applyAncestorState(out: ElementProbe, pre: PreProbeData | undefined, post: PreProbeData): void {
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
    if (pre?.container) cont.changed = pre.container.rowText !== post.container.rowText;
    out.container = cont;
  }
}

/**
 * Always read post-action DOM state so callers can confirm a write landed
 * without a follow-up `snapshot`/`screenshot` round-trip. We deliberately do not
 * echo back `valueRequested` as `value` — the probe reports what the DOM actually
 * holds, not what the caller asked for. Exported for unit tests.
 */
export async function probe(
  loc: Locator,
  target: ActionTarget,
  valueRequested?: string,
  pre?: PreProbeData,
): Promise<ElementProbe> {
  const ref = target.ref;
  try {
    const count = await loc.count();
    if (count === 0) return { ref, stillAttached: false };
    const focused = await loc
      .evaluate(
        (el: { ownerDocument?: { activeElement?: unknown } }) =>
          el === el.ownerDocument?.activeElement,
        undefined,
        { timeout: PROBE_EVAL_MS },
      )
      .catch(() => false);
    const value = await readProbeValue(loc);
    const checked = await loc.evaluate(checkedScript, undefined, { timeout: PROBE_EVAL_MS }).catch(() => undefined);
    const displayText = await loc
      .evaluate(displayTextScript, undefined, { timeout: PROBE_EVAL_MS })
      .catch(() => null);
    const out: ElementProbe = { ref, stillAttached: true, focused, value: value ?? null };
    if (checked !== undefined) out.checked = checked;
    if (valueRequested !== undefined) out.valueRequested = valueRequested;
    if (displayText !== null) out.displayText = displayText;

    // post-action owner/container state. Always read; compose deltas against
    // `pre` when supplied. Same in-page script as preProbe, so directly comparable.
    const post: PreProbeData = await loc
      .evaluate(probeAncestorsScript, undefined, { timeout: PROBE_EVAL_MS })
      .catch((): PreProbeData => ({}));
    applyAncestorState(out, pre, post);
    return out;
  } catch {
    return { ref, stillAttached: false };
  }
}

const OWNER_ROLES = new Set(["combobox", "listbox", "radiogroup", "group", "menu", "tablist"]);
const ROW_ROLES = new Set(["row", "listitem", "article"]);
const ROW_TAGS = new Set(["tr", "li"]);

/**
 * In-page script used by `preProbe` and the post-action half of `probe`. Walks up
 * the target's ancestor chain for the nearest owning form control (combobox /
 * listbox / radiogroup / labelled `data-test*` wrapper) and the nearest repeated
 * container (`role=row`/`listitem`/`article`, or `<tr>`/`<li>`). Capped at 6
 * ancestor steps and 200 chars per text field. Returns {} when nothing matches.
 *
 * Defined as a plain function (not an arrow) so Playwright can stringify it
 * across the CDP boundary cleanly. `el` is typed `unknown` and narrowed to the
 * precise structural `AncestorEl` shape — the leading runtime check makes the
 * narrowing sound. The per-concern matchers are nested so the whole thing stays
 * one self-contained serializable literal.
 */
const probeAncestorsScript = function probeAncestors(el: unknown): PreProbeData {
  if (!el || typeof el !== "object") return {};

  function attr(cur: AncestorEl, name: string): string | null {
    return cur.getAttribute ? cur.getAttribute(name) : null;
  }
  function isFieldOwner(cur: AncestorEl, role: string | null, ariaLabel: string | null): boolean {
    const ds = cur.dataset || {};
    const hasTestAttr = !!(ds.testid || ds.test || ds.cy || ds.qa);
    if (role && OWNER_ROLES.has(role)) return true;
    return hasTestAttr && !!(role || ariaLabel);
  }
  function matchOwner(cur: AncestorEl): { ownerText?: string; ownerLabel?: string } | null {
    const role = attr(cur, "role");
    const ariaLabel = attr(cur, "aria-label");
    if (!isFieldOwner(cur, role, ariaLabel)) return null;
    const txt = (cur.innerText || "").trim();
    const res: { ownerText?: string; ownerLabel?: string } = {};
    if (txt) res.ownerText = txt.length > 200 ? txt.slice(0, 199) + "…" : txt;
    if (ariaLabel) res.ownerLabel = ariaLabel;
    return res;
  }

  function matchContainer(cur: AncestorEl): PreProbeData["container"] | null {
    const role: string | null = cur.getAttribute ? cur.getAttribute("role") : null;
    const tag = cur.tagName ? cur.tagName.toLowerCase() : "";
    if (!((role && ROW_ROLES.has(role)) || ROW_TAGS.has(tag))) return null;
    const kind = role && ROW_ROLES.has(role) ? role : tag;
    const rowText = (cur.innerText || "").trim().replace(/\s+/g, " ");
    const capped = rowText.length > 200 ? rowText.slice(0, 199) + "…" : rowText;
    const firstText = (cur.innerText || "")
      .trim()
      .split("\n")
      .find((s: string) => s.trim().length > 0);
    const out: { kind: string; rowKey?: string; rowText?: string } = { kind };
    if (firstText) {
      const t = firstText.trim();
      out.rowKey = t.length > 80 ? t.slice(0, 79) + "…" : t;
    }
    if (capped) out.rowText = capped;
    return out;
  }

  const out: PreProbeData = {};
  let cur: AncestorEl | null | undefined = (el as AncestorEl).parentElement;
  for (let i = 0; i < 6 && cur && cur.tagName !== "BODY" && cur.tagName !== "HTML"; i++) {
    if (!out.ownerText) {
      const owner = matchOwner(cur);
      if (owner) {
        if (owner.ownerText) out.ownerText = owner.ownerText;
        if (owner.ownerLabel) out.ownerLabel = owner.ownerLabel;
      }
    }
    if (!out.container) {
      const container = matchContainer(cur);
      if (container) out.container = container;
    }
    if (out.ownerText && out.container) break;
    cur = cur.parentElement;
  }
  return out;
};

/** Coordinate-action evidence helper: read `document.elementFromPoint` at (x,y)
 *  with role/text/ancestor context. Returns null when nothing's there. */
export async function captureHit(page: Page, x: number, y: number): Promise<HitPoint | null> {
  return page
    .evaluate(
      ({ x, y }: { x: number; y: number }): HitPoint | null => {
        const g: unknown = globalThis;
        const doc = (g as WindowLike).document;
        if (!doc) return null;
        const el = doc.elementFromPoint(x, y);
        if (!el) return null;
        const tag: string = (el.tagName || "").toLowerCase();
        const role: string | undefined = el.getAttribute
          ? el.getAttribute("role") || undefined
          : undefined;
        const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
        const parent = el.parentElement;
        const ancestorText = parent
          ? (parent.innerText || "").trim().replace(/\s+/g, " ").slice(0, 200)
          : undefined;
        const out: HitPoint = { tag };
        if (role) out.role = role;
        if (text) out.text = text;
        if (ancestorText) out.ancestorText = ancestorText;
        return out;
      },
      { x, y },
    )
    .catch(() => null);
}

/** Best-effort identity for the active element so we can report whether focus
 *  shifted during a coord action. Returns a stable-ish key (tag + id + role +
 *  testid + first text). */
export async function captureFocusedRef(page: Page): Promise<string | null> {
  return page
    .evaluate((): string | null => {
      const g: unknown = globalThis;
      const doc = (g as WindowLike).document;
      if (!doc) return null;
      const a = doc.activeElement;
      if (!a) return null;
      const id: string = a.id || "";
      const role: string = a.getAttribute ? a.getAttribute("role") || "" : "";
      const testid: string = a.getAttribute
        ? a.getAttribute("data-testid") ||
          a.getAttribute("data-test") ||
          a.getAttribute("data-cy") ||
          ""
        : "";
      const tag: string = (a.tagName || "").toLowerCase();
      const txt = (a.textContent || "").trim().slice(0, 60);
      return `${tag}#${id}@${role}[${testid}]:${txt}`;
    })
    .catch(() => null);
}
