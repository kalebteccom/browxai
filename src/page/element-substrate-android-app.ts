// NativeElementSubstrate — resolution, measurement and reading of ONE element on
// a native session, and the place RFC 0008 §3's central promise is kept.
//
// RE-RESOLVE, NEVER REPLAY. `bounds` and `probe` each read a FRESH view
// hierarchy and re-run the token's recipe against it. The token carries the
// recipe and holds nothing — no node handle, no cached rectangle — so a ref that
// now matches nothing is reported as matching nothing, and a ref whose element
// moved is found where it moved to. The failure mode this closes is the one the
// owner's trial found: a stale ref silently resolving to whatever now occupies
// its old rectangle, and the tool reporting a successful tap on the wrong thing.
//
// AMBIGUITY REFUSES. RFC 0009's amendment (2026-09-16) records that web preserves
// a silent first-match pick for compatibility and that a native engine, having no
// legacy, refuses. So a query matching two nodes returns a refusal naming the ref
// and the count, and nothing is tapped.
//
// Dependency direction (architecture doctrine §1): tool handler → ElementSubstrate
// (the port in `element-substrate-types.ts`) → this implementation → NativeScreen
// → adb. Names no Playwright type.

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
import type { NativeRefRecipe } from "./native-hierarchy.js";
import { ACTION_MAX_AGE_MS, type NativeScreen, type NativeScreenView } from "./native-screen.js";
import {
  matchNativeQuery,
  parseNativeQuery,
  resolveRecipe,
  type NativeMatch,
} from "./native-query.js";
import type { RefRegistry } from "./refs.js";

function refusal(
  reason: ElementRefusal["reason"],
  error: string,
  hint: string,
  ref?: string,
): ElementRefusal {
  return { kind: "refusal", reason, error, hint, ...(ref ? { ref } : {}) };
}

/** The refusal an ambiguous query gets. Named as its own function because the
 *  message is the product here: an agent that acted on the first of three
 *  matches would have no way to learn it did. */
function ambiguous(what: string, n: number, ref?: string): ElementRefusal {
  return refusal(
    "unaddressable-target",
    `${what} matched ${n} elements on the current screen`,
    "A native action never picks one of several matches: tapping the wrong element would be " +
      "reported as a successful tap and would poison the session evidence. Narrow the query — " +
      'add a `testID` to the element in the app, or use `role=<role>[name="<label>"]` — then ' +
      "re-run `snapshot` to mint a ref for the element you meant.",
    ref,
  );
}

export class NativeElementSubstrate implements ElementSubstrate {
  readonly engine: string;

  constructor(
    private readonly screen: NativeScreen,
    private readonly refs: RefRegistry,
    engine = "android-app",
  ) {
    this.engine = engine;
  }

  /** Validate the query and mint a recipe token. Touches no device: the match
   *  count is a `probe` concern, so a caller that only needs a handle pays for no
   *  dump. Mirrors the Playwright adapter, which also resolves without a round
   *  trip. */
  async resolve(query: ElementQuery, scope?: ElementScope): Promise<ElementResolution> {
    if (query.kind === "ref") {
      if (!this.refs.has(query.ref)) {
        return refusal(
          "no-such-element",
          `ref "${query.ref}" is not in this session's registry`,
          "Run `snapshot` or `find` to mint refs for the current screen, then use one of those.",
          query.ref,
        );
      }
      if (!this.refs.locatorOf(query.ref)) {
        return refusal(
          "no-such-element",
          `ref "${query.ref}" carries no resolution recipe`,
          "The ref predates this engine's snapshot. Re-run `snapshot`.",
          query.ref,
        );
      }
    }
    return { kind: "element", el: { __brand: "element", query, ...(scope ? { scope } : {}) } };
  }

  /** Viewport-space bounds, from a FRESH hierarchy read. This is the geometry a
   *  tap uses, and it is measured in the same call that dispatches. */
  async bounds(el: ElementToken): Promise<ElementBoundsResult> {
    const found = await this.locate(el.query);
    if ("kind" in found && found.kind === "refusal") return found;
    const match = found as NativeMatch;
    return { kind: "bounds", rect: match.recipe.bounds };
  }

  /** The batched read. One hierarchy dump answers every field, which is what the
   *  port's discriminated request exists for — on a native target a second round
   *  trip is a second ~400ms dump, so asking once matters more here than on web. */
  async probe(el: ElementToken, want: ElementProbeRequest): Promise<ElementProbeResult> {
    const view = await this.screen.read(this.refs, { maxAgeMs: ACTION_MAX_AGE_MS, prune: false });
    const matches = this.matchesIn(view, el.query);
    if ("kind" in matches && matches.kind === "refusal") return matches;
    const list = matches as NativeMatch[];
    const reading: ElementReading = { kind: "reading" };
    const out = reading as { -readonly [K in keyof ElementReading]: ElementReading[K] };
    if (want.matches) out.matches = list.length;
    const only = list.length === 1 ? list[0] : undefined;
    if (!only) {
      // Every non-count field is a question about ONE element. Answering them
      // from an arbitrary member of an ambiguous set is the mistap in report
      // form, so they are left absent with the reason recorded.
      if (this.wantsElementFields(want)) {
        out.failures = { element: `the query matched ${list.length} elements` };
      }
      return out;
    }
    this.fill(out, only, want);
    return out;
  }

  /** How many nodes the query matches. The one read that is honest about a count
   *  other than one, because the count IS the answer. */
  async count(query: ElementQuery): Promise<ElementCountResult> {
    const view = await this.screen.read(this.refs, { maxAgeMs: ACTION_MAX_AGE_MS, prune: false });
    const matches = this.matchesIn(view, query);
    if ("kind" in matches && matches.kind === "refusal") {
      // A count of zero is a real answer to `verify_count`, not a refusal —
      // "no element matches" is exactly what the tool asked about. Only a query
      // this engine cannot express at all refuses.
      const r = matches;
      return r.reason === "stale-element" || r.reason === "unaddressable-target"
        ? { kind: "count", n: 0 }
        : r;
    }
    return { kind: "count", n: (matches as NativeMatch[]).length };
  }

  private wantsElementFields(want: ElementProbeRequest): boolean {
    return Boolean(
      want.visible ??
      want.enabled ??
      want.text ??
      want.value ??
      want.attribute ??
      want.notVisibleReason,
    );
  }

  /** Read the requested fields off one matched node. Everything a native probe
   *  can answer is already in the hierarchy dump, so this costs no further IO. */
  private fill(
    out: { -readonly [K in keyof ElementReading]: ElementReading[K] },
    match: NativeMatch,
    want: ElementProbeRequest,
  ): void {
    if (want.visible ?? want.notVisibleReason) fillVisibility(out, match, want);
    if (want.enabled) out.enabled = match.node.disabled !== true;
    if (want.text) out.text = match.node.text ?? match.node.name ?? null;
    // A native view has no `value` attribute distinct from its text; an EditText
    // reports what it holds as `text`. Reporting that as the value is the honest
    // mapping, and a password field's text never reaches the tree at all.
    if (want.value) out.value = match.node.role === "textbox" ? (match.node.text ?? "") : null;
    if (want.attribute) out.attribute = nativeAttribute(match, want.attribute);
  }

  /** Resolve a query to EXACTLY ONE match against a fresh view, or refuse. */
  private async locate(query: ElementQuery): Promise<NativeMatch | ElementRefusal> {
    const view = await this.screen.read(this.refs, { maxAgeMs: ACTION_MAX_AGE_MS, prune: false });
    const matches = this.matchesIn(view, query);
    if ("kind" in matches && matches.kind === "refusal") return matches;
    const list = matches as NativeMatch[];
    if (list.length === 1) return list[0]!;
    if (list.length === 0) return this.missing(query);
    return ambiguous(describe(query), list.length, query.kind === "ref" ? query.ref : undefined);
  }

  private missing(query: ElementQuery): ElementRefusal {
    return refusal(
      "stale-element",
      `${describe(query)} matched no element on the current screen`,
      query.kind === "ref"
        ? "The ref is registered and the screen no longer holds it — the app navigated, or the " +
            "element was removed. Re-run `snapshot` to see the current screen."
        : "Nothing on the current screen matches. Run `snapshot` to see what is there, or " +
            "`find` to search by label.",
      query.kind === "ref" ? query.ref : undefined,
    );
  }

  /** All matches for a query in a given view. */
  private matchesIn(view: NativeScreenView, query: ElementQuery): NativeMatch[] | ElementRefusal {
    if (query.kind === "ref") {
      const recipe = this.recipeFor(query.ref, view);
      if (!recipe) {
        return refusal(
          "no-such-element",
          `ref "${query.ref}" is not in this session's registry`,
          "Run `snapshot` or `find` to mint refs for the current screen.",
          query.ref,
        );
      }
      return resolveRecipe(view, recipe);
    }
    const raw = query.kind === "selector" ? query.selector : query.expression;
    return matchNativeQuery(view, parseNativeQuery(raw));
  }

  /** The recipe a ref was minted with. The live view is consulted first — a ref
   *  the CURRENT screen also carries is the common case and its recipe is exact —
   *  and the registry is the fallback for a ref minted against an earlier screen,
   *  which is precisely the case re-resolution exists to handle. */
  private recipeFor(ref: string, view: NativeScreenView): NativeRefRecipe | undefined {
    const live = view.recipes.get(ref);
    if (live) return live;
    const stored = this.refs.locatorOf(ref);
    if (!stored) return undefined;
    return {
      role: stored.role,
      name: stored.name,
      testId: stored.testId,
      testIdAttr: stored.testIdAttr,
      path: stored.nativePath ?? "",
      frameId: stored.frameId,
      bounds: null,
    };
  }
}

/** Visibility on a native tree is geometry: a view in the hierarchy with a
 *  rendered box is on screen. There is no `display:none` to distinguish, because
 *  a view that is not laid out reports no bounds at all. */
function fillVisibility(
  out: { -readonly [K in keyof ElementReading]: ElementReading[K] },
  match: NativeMatch,
  want: ElementProbeRequest,
): void {
  const rect = match.recipe.bounds;
  const visible = Boolean(rect && rect.width > 0 && rect.height > 0);
  if (want.visible) out.visible = visible;
  if (want.notVisibleReason && !visible) {
    out.notVisibleReason = rect
      ? `the element has a zero-sized box (${rect.width}x${rect.height})`
      : "the element reported no bounds, so it is not laid out";
  }
}

/** The attribute names a UiAutomator node answers to, each mapped to the reader
 *  that produces it. A table rather than a switch so adding one is a row.
 *  Anything not here returns `null` — the port's "the attribute is absent" —
 *  because a native view has a FIXED attribute set, so `href` has a real answer
 *  of "no" rather than being a question this engine cannot take. */
const NATIVE_ATTRIBUTES: Readonly<Record<string, (n: NativeMatch["node"]) => string | null>> = {
  testid: (n) => n.testId ?? null,
  "resource-id": (n) => n.testId ?? null,
  "content-desc": (n) => n.name ?? null,
  label: (n) => n.name ?? null,
  text: (n) => n.text ?? null,
  class: (n) => n.tag ?? null,
  tag: (n) => n.tag ?? null,
  role: (n) => n.role,
  enabled: (n) => (n.disabled === true ? "false" : "true"),
  checked: (n) => (n.checked === undefined ? null : String(n.checked)),
};

function nativeAttribute(match: NativeMatch, name: string): string | null {
  return NATIVE_ATTRIBUTES[name.toLowerCase()]?.(match.node) ?? null;
}

function describe(query: ElementQuery): string {
  if (query.kind === "ref") return `ref "${query.ref}"`;
  if (query.kind === "selector") return `selector "${query.selector}"`;
  return `query "${query.expression}"`;
}
