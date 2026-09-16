/// <reference lib="dom" />
// PlaywrightElementSubstrate — the ElementSubstrate implementation for the
// Playwright engines (chromium / firefox / webkit / android).
//
// Every body here is the verbatim call the consumer used to make on a live
// `Locator`, moved behind the port with its error handling intact. That is the
// whole of the zero-behaviour-change claim, and it is why the per-read `.catch`
// shapes below look inconsistent: they ARE inconsistent today, and each
// inconsistency is load-bearing somewhere.
//
//   - `verify_text` did `innerText().catch(() => null) ?? ""`, so a failed read
//     reads as empty text. `verify_visible` did NOT catch `isVisible()`, so a
//     failed read becomes a `source:"browxai"` assertion-could-not-run. Those two
//     must stay different, so `text` reports `null` and `visible` reports its
//     failure under `failures`.
//   - `find`'s actionability probe caught `isEnabled` and `isVisible`
//     INDEPENDENTLY and defaulted each to `true`. Refusing the whole probe when
//     one of the pair fails would lose the other's signal, so the pair is read
//     with `Promise.all` and each failure is recorded separately.
//
// `async` is load-bearing on all four members. The injected `page` thunk is
// `() => requirePage(e.session)`, which on an attached (BYOB) session resolves to
// a bound page that THROWS once the user closes the tab. A method typed
// `Promise<T>` that is not `async` propagates that throw synchronously, past every
// caller's `.catch()`. The accessor is also evaluated FIRST in each method, before
// any query validation, so a dead target rejects rather than being reported as a
// malformed query. `substrate-adapter-async.test.ts` is the gate.
//
// Dependency direction (architecture doctrine §1): tool handler → ElementSubstrate
// (the port in `element-substrate-types.ts`) → this implementation → Playwright
// Locator. This file never imports back from the `element-substrate.js` barrel.

import type { Frame, Locator, Page } from "playwright-core";
import type { RefRegistry } from "./refs.js";
import { locatorFor } from "./locator.js";
import { MAIN_FRAME_ID, resolveFrameById, type FrameRegistry } from "./frames.js";
import type {
  ElementBoundsResult,
  ElementCountResult,
  ElementProbeRequest,
  ElementProbeResult,
  ElementQuery,
  ElementReading,
  ElementRefusal,
  ElementResolution,
  ElementScope,
  ElementSubstrate,
  ElementToken,
} from "./element-substrate-types.js";

type LocatorRoot = Page | Frame;

function refusal(
  reason: ElementRefusal["reason"],
  error: string,
  extra: { hint?: string; ref?: string } = {},
): ElementRefusal {
  return { kind: "refusal", reason, error, ...extra };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The ref a query names, for the refusal envelope. */
function refOf(q: ElementQuery): string | undefined {
  return q.kind === "ref" ? q.ref : undefined;
}

/** Page-side: why an element that reports `isVisible() === false` is not visible.
 *  A real function literal, not a stringified arrow — CDP cannot serialize a
 *  function VALUE across the boundary and the return would become `undefined`
 *  (the dom_export trap class). Verbatim from `verify-element.ts`. */
function notVisibleReasonFn(el: Element): string {
  const cs = window.getComputedStyle(el);
  if (cs.display === "none") return "hidden (display:none)";
  if (cs.visibility === "hidden") return "hidden (visibility:hidden)";
  if (Number(cs.opacity || "1") === 0) return "hidden (opacity:0)";
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return "hidden (zero-sized box)";
  return "off-screen or covered";
}

/** Page-side: the element's DOM-side value. Any element carrying a string `value`
 *  (input/textarea/select, but also output/button) reports it directly; a
 *  contenteditable host falls back to its rendered text. Verbatim from
 *  `verify-element.ts`. */
function valueFn(el: Element): string | null {
  const valued = el as Element & { value?: unknown };
  if (typeof valued.value === "string") return valued.value;
  if (el instanceof HTMLElement && el.isContentEditable) return el.innerText ?? "";
  return null;
}

export class PlaywrightElementSubstrate implements ElementSubstrate {
  readonly engine: string;
  constructor(
    private readonly page: () => Page,
    private readonly frames: FrameRegistry,
    private readonly refs: RefRegistry,
    engine = "chromium",
  ) {
    this.engine = engine;
  }

  /** The document a query resolves against. Evaluated before anything else in
   *  every member, so a gone accessor surfaces as a rejection.
   *
   *  A child frame is re-resolved per call rather than memoised: `resolveFrameById`
   *  walks a frame tree, which is small, and holding the `Frame` across calls
   *  would reintroduce exactly the cached-handle lifetime this port exists to
   *  avoid. The main-frame path (every call `find` makes today unless the caller
   *  passed `frame:`) short-circuits to `page.mainFrame()`'s owner with no walk. */
  private rootFor(scope?: ElementScope): LocatorRoot | null {
    const page = this.page();
    if (!scope || scope.frameId === MAIN_FRAME_ID) return page;
    return resolveFrameById(page, this.frames, scope.frameId);
  }

  /** The query as a Playwright locator COLLECTION. `ref` / `selector` route
   *  through `locatorFor`, which already narrows every tier to `.first()`;
   *  `expression` is handed to the locator engine verbatim and stays a collection,
   *  which is what makes `count` able to report more than one. */
  private collection(root: LocatorRoot, q: ElementQuery): Locator {
    if (q.kind === "expression") return root.locator(q.expression);
    if (q.kind === "ref") return locatorFor(root, this.refs, { ref: q.ref });
    return locatorFor(
      root,
      this.refs,
      q.contextRef !== undefined
        ? { selector: q.selector, contextRef: q.contextRef }
        : { selector: q.selector },
    );
  }

  /** The query as ONE element. Only `expression` needs narrowing; the other two
   *  are already `.first()` by the time `locatorFor` returns them. */
  private one(root: LocatorRoot, q: ElementQuery): Locator {
    const loc = this.collection(root, q);
    return q.kind === "expression" ? loc.first() : loc;
  }

  /** Resolve the root + rebuild the locator for a token, or say why not. Shared by
   *  `bounds` and `probe`, which both re-run the token's recipe. */
  private relocate(el: ElementToken): { loc: Locator } | ElementRefusal {
    const root = this.rootFor(el.scope);
    if (!root) {
      return refusal("unaddressable-target", `frame "${el.scope?.frameId}" is no longer attached`, {
        hint: "call frames_list() to see currently-attached frames",
      });
    }
    try {
      return { loc: this.one(root, el.query) };
    } catch (e) {
      return refusal("unaddressable-target", messageOf(e), { ref: refOf(el.query) });
    }
  }

  async resolve(query: ElementQuery, scope?: ElementScope): Promise<ElementResolution> {
    const root = this.rootFor(scope);
    if (!root) {
      return refusal("unaddressable-target", `frame "${scope?.frameId}" is no longer attached`, {
        hint: "call frames_list() to see currently-attached frames",
      });
    }
    // The registry check is the `no such element` half of WebDriver's split: this
    // session never minted that reference, or no longer holds it. It runs before
    // the locator build because `locatorFor` would throw the same fact as an
    // untyped message.
    if (query.kind === "ref" && !this.refs.has(query.ref)) {
      return refusal("no-such-element", `ref "${query.ref}" is not in the session's registry`, {
        hint: "call snapshot() or find() again — the page may have re-rendered",
        ref: query.ref,
      });
    }
    try {
      // Built and discarded: the token holds the RECIPE, not this locator. The
      // build is a synchronous constructor with no IO, so proving the query is
      // well-formed here costs nothing and turns a later throw into a refusal now.
      this.one(root, query);
    } catch (e) {
      return refusal("unaddressable-target", messageOf(e), { ref: refOf(query) });
    }
    return { kind: "element", el: { __brand: "element", query, ...(scope ? { scope } : {}) } };
  }

  async bounds(el: ElementToken, opts: { timeoutMs?: number } = {}): Promise<ElementBoundsResult> {
    const located = this.relocate(el);
    if ("kind" in located) return located;
    try {
      // No pre-count. `boundingBox()` auto-waits and throws on timeout, and that
      // throw is what `gestures.targetPoint` surfaces today; a cheap count-first
      // refusal would replace a 30-second timeout error with a fast one, which is
      // an improvement and a behaviour change.
      const box = await located.loc.boundingBox(
        opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {},
      );
      // A zero-sized box is REPORTED, not flattened to null. The three callers
      // disagree about what one means — `find` treats it as no box, `targetPoint`
      // as an unusable gesture target, `describeTarget` prints `0×0` — and each of
      // those was its own line at its own call site. Deciding here would silently
      // pick one of them for all three.
      if (!box) return { kind: "bounds", rect: null };
      return { kind: "bounds", rect: { x: box.x, y: box.y, width: box.width, height: box.height } };
    } catch (e) {
      return refusal("probe-failed", messageOf(e), { ref: refOf(el.query) });
    }
  }

  async probe(el: ElementToken, want: ElementProbeRequest): Promise<ElementProbeResult> {
    const located = this.relocate(el);
    if ("kind" in located) return located;
    const loc = located.loc;
    let matches: number | undefined;
    if (want.matches) {
      try {
        matches = await loc.count();
      } catch (e) {
        return refusal("probe-failed", messageOf(e), { ref: refOf(el.query) });
      }
      // The `stale element reference` half of the split: the reference resolves,
      // the page no longer holds a node for it.
      if (matches === 0) {
        return refusal("stale-element", "the query matched 0 nodes", { ref: refOf(el.query) });
      }
    }
    return readAll(loc, want, matches);
  }

  async count(query: ElementQuery, scope?: ElementScope): Promise<ElementCountResult> {
    const root = this.rootFor(scope);
    if (!root) {
      return refusal("unaddressable-target", `frame "${scope?.frameId}" is no longer attached`);
    }
    try {
      return { kind: "count", n: await this.collection(root, query).count() };
    } catch (e) {
      return refusal("probe-failed", messageOf(e), { ref: refOf(query) });
    }
  }
}

/** The mutable accumulator the per-read jobs write into. Split out of `readAll`
 *  so both functions stay inside the 70-line budget. */
interface ReadAcc {
  visible?: boolean;
  enabled?: boolean;
  text?: string | null;
  value?: string | null;
  attribute?: string | null;
}

/** Queue exactly the reads the request asked for. Each read catches
 *  INDEPENDENTLY, because the consumers disagree about what a failed read means
 *  and the port must not decide for them: `find` defaults a failed actionability
 *  signal to "actionable", `verify_visible` reports it as a check that could not
 *  run, and `verify_text` reads a failed `innerText` as empty text. */
function queueReads(
  loc: Locator,
  want: ElementProbeRequest,
  out: ReadAcc,
  failures: Record<string, string>,
): Array<Promise<void>> {
  const el = loc.first();
  const jobs: Array<Promise<void>> = [];
  if (want.visible) {
    jobs.push(
      el.isVisible().then(
        (v) => void (out.visible = v),
        (e: unknown) => void (failures.visible = messageOf(e)),
      ),
    );
  }
  if (want.enabled) {
    const opts = want.timeoutMs !== undefined ? { timeout: want.timeoutMs } : {};
    jobs.push(
      el.isEnabled(opts).then(
        (v) => void (out.enabled = v),
        (e: unknown) => void (failures.enabled = messageOf(e)),
      ),
    );
  }
  if (want.text) {
    jobs.push(
      el.innerText().then(
        (v) => void (out.text = v),
        () => void (out.text = null),
      ),
    );
  }
  if (want.value) {
    jobs.push(
      el.evaluate(valueFn as never).then(
        (v) => void (out.value = v as string | null),
        () => void (out.value = null),
      ),
    );
  }
  if (want.attribute !== undefined) {
    jobs.push(
      el.getAttribute(want.attribute).then(
        (v) => void (out.attribute = v),
        () => void (out.attribute = null),
      ),
    );
  }
  return jobs;
}

/** Run the queued reads together. `Promise.all` reproduces `find`'s parallel
 *  enabled/visible pair; a single-read caller pays for exactly one round trip, as
 *  it did before the port existed. */
async function readAll(
  loc: Locator,
  want: ElementProbeRequest,
  matches: number | undefined,
): Promise<ElementReading> {
  const failures: Record<string, string> = {};
  const out: ReadAcc = {};
  await Promise.all(queueReads(loc, want, out, failures));
  // Sequential and conditional: the second round trip only happens for an element
  // that actually reported not-visible, exactly as `probeNotVisibleReason` did.
  const notVisibleReason =
    want.notVisibleReason && out.visible === false ? await reasonFor(loc) : undefined;
  return {
    kind: "reading",
    ...(matches !== undefined ? { matches } : {}),
    ...out,
    ...(notVisibleReason !== undefined ? { notVisibleReason } : {}),
    ...(Object.keys(failures).length > 0 ? { failures } : {}),
  };
}

/** Verbatim from `verify-element.ts`'s `probeNotVisibleReason`, including the
 *  double guard: the page-side read can reject (caught by `.catch`) and the call
 *  itself can throw synchronously on a dead handle (caught by the try). */
async function reasonFor(loc: Locator): Promise<string> {
  try {
    return await loc
      .first()
      .evaluate(notVisibleReasonFn as never)
      .then((r) => r as string)
      .catch(() => "hidden");
  } catch {
    return "hidden";
  }
}
