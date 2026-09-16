// The ElementSubstrate port — resolution, measurement and reading of ONE element,
// for the tools that need a handle rather than a snapshot node.
//
// `locatorFor(page, refs, target)` (`locator.ts`) is the resolution chokepoint for
// the `verify_*` family, gesture geometry, element-scoped capture and `find`'s
// per-candidate probes. Every one of those returns a live Playwright `Locator` and
// chains `.count()` / `.isVisible()` / `.boundingBox()` / `.evaluate()` on it, so
// the whole cluster is Playwright-only by construction. Safari resolves elements
// over WebDriver Classic element ids; the native engines RFC 0008 adds resolve a
// testID against a hierarchy query. So resolution belongs on a port. (RFC 0009 P2.)
//
// NOTHING IS HELD. `ElementToken` is a re-resolution RECIPE — the query and its
// scope, plain data — not a handle. An earlier RFC 0009 draft allowed the
// Playwright token to BE the `Locator`, cached per call; that fallback is
// withdrawn (RFC 0009 §ElementSubstrate, amendment 2026-09-16) because a cached
// handle is what RFC 0008 §3 forbids: every action must re-resolve its ref to a
// live element before dispatch. browxai's `[ref=eN]` is already a content hash
// plus a stored locator recipe re-run at action time, holding nothing, and this
// port keeps that property: `bounds` and `probe` re-run the recipe. Re-running is
// free — building a `Locator` is a synchronous constructor, not IO.
//
// AMBIGUITY IS NOT REFUSED ON WEB, DELIBERATELY. The RFC's `resolve` doc says zero
// or many matches is a refusal. That is not what ships: `locatorFromInputs`
// resolves every tier through `.first()`, so an ambiguous ref silently acts on the
// first match. Turning that into a refusal changes what a shipped tool does to a
// page, and a refactor is the wrong vehicle (RFC 0009 amendment 2026-09-16). The
// port expresses both outcomes — `matches` is on the reading and `stale-element`
// is a refusal reason — and the Playwright adapter preserves today's behaviour
// exactly. A native engine, with no legacy to preserve, refuses. See
// `element-substrate.test.ts`, which pins the web side so a later phase cannot
// flip it by accident.
//
// Dependency direction (architecture doctrine §1): tool handler → ElementSubstrate
// (this port) → implementation → Playwright Locator | WebDriver element id. Every
// declaration below is plain data, so the `ports-name-no-vendor-type`
// dependency-cruiser rule holds reachably.

/** A viewport-space box. Structurally identical to `bbox.ts`'s `VisibleRect`,
 *  declared here because `bbox.ts` names `Page`/`Frame` and a port may not reach
 *  playwright-core even transitively. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What to resolve. Three shapes, because the codebase genuinely has three and
 *  collapsing them would change behaviour:
 *
 *  - `ref` — a `[ref=eN]` from snapshot/find. The registry holds the recipe.
 *  - `selector` — the agent-facing target vocabulary, interpreted by the
 *    engine's own target parser (on web, `parseSelectorHint`: `[attr="v"]`,
 *    `role=x[name="y"]`, else a raw locator string), optionally scoped to a
 *    prior ref's subtree.
 *  - `expression` — the engine's NATIVE query language, passed through verbatim.
 *    `find` measures its candidates with this, because the string it is about to
 *    hand the agent as `selectorHint` must be measured as the engine will read
 *    it. On web that is a Playwright selector; on WebDriver a CSS selector; on a
 *    native engine a testID path.
 *
 *  `selector` and `expression` can carry the same string and resolve differently
 *  — `role=a[name="past"]` is an EXACT name match through the selector engine and
 *  a substring match through `getByRole`. That divergence predates this port and
 *  is preserved, not fixed. */
export type ElementQuery =
  | { readonly kind: "ref"; readonly ref: string }
  | { readonly kind: "selector"; readonly selector: string; readonly contextRef?: string }
  | { readonly kind: "expression"; readonly expression: string };

/** Which document the query is rooted in. Absent = the session's main target.
 *  Web: a child frame, by the stable id `frames_list` mints. Native (RFC 0008): a
 *  webview or a secondary window. */
export interface ElementScope {
  readonly frameId: string;
}

/** Why a resolution or a read could not produce an answer.
 *
 *  The `no-such-element` / `stale-element` split is W3C WebDriver's, and it is
 *  carried here because an agent does different things in each case: re-find, or
 *  re-snapshot. browxai already emitted both — "ref no longer in the snapshot"
 *  (`source:"browxai"`, the registry never had it) and "missing (locator matched 0
 *  nodes)" (`source:"app"`, the registry has it and the page does not) — but the
 *  distinction lived in two hand-written strings in `verify-element.ts` and was
 *  not machine-readable. Naming it here makes it one fact both engines report. */
export type ElementRefusalReason =
  /** The reference was never minted, or is no longer in this session's registry. */
  | "no-such-element"
  /** The reference is registered and its recipe now matches nothing. */
  | "stale-element"
  /** The query cannot be turned into a request this engine can make. */
  | "unaddressable-target"
  /** The query was well-formed and the read itself failed. */
  | "probe-failed"
  /** This engine backs no element port at all. */
  | "engine-unsupported";

/** The structured refusal every member shares — the same `{error, hint}` envelope
 *  the other substrates return, so "the engine cannot" stays one shape however it
 *  was reached, and is never mistaken for "the answer is no". */
export interface ElementRefusal {
  readonly kind: "refusal";
  readonly reason: ElementRefusalReason;
  readonly error: string;
  readonly hint?: string;
  /** The ref the query named, when it named one. */
  readonly ref?: string;
}

/** An opaque, substrate-minted token for one resolved element. It carries the
 *  RECIPE, never a handle: re-running it is the contract, and a caller that holds
 *  one across calls gets a fresh resolution each time rather than a stale node. */
export interface ElementToken {
  readonly __brand: "element";
  readonly query: ElementQuery;
  readonly scope?: ElementScope;
}

/** What one `probe` call should read. Every field is opt-in so a caller pays for
 *  exactly the round trips it asked for: `find`'s actionability probe wants
 *  `{visible, enabled}` and no count, the `verify_*` family wants `{matches}` plus
 *  one reading. This is the batching the RFC's single `probe` member exists for —
 *  one call answers several questions. */
export interface ElementProbeRequest {
  /** How many nodes the query matches. */
  readonly matches?: boolean;
  readonly visible?: boolean;
  /** When the element is not visible, also say why. Costs a second round trip, so
   *  it is separate from `visible`. */
  readonly notVisibleReason?: boolean;
  readonly enabled?: boolean;
  readonly text?: boolean;
  readonly value?: boolean;
  /** Attribute name to read. */
  readonly attribute?: string;
  /** Cap for reads that would otherwise wait for actionability. `find` is a probe
   *  tool, not an action: a hint that matches nothing must fail fast. */
  readonly timeoutMs?: number;
}

/** What one `probe` call read. A field the request did not ask for is absent; a
 *  field the request asked for and the engine could not read is ALSO absent, with
 *  the reason under `failures`. The caller decides what an unread field means —
 *  `find` treats an unread actionability signal as "actionable" rather than
 *  manufacture a false negative, while `verify_visible` reports it as a check that
 *  could not run. Defaulting here would take that choice away from both. */
export interface ElementReading {
  readonly kind: "reading";
  readonly matches?: number;
  readonly visible?: boolean;
  readonly notVisibleReason?: string;
  readonly enabled?: boolean;
  /** `null` when the read failed or the element carries no text. */
  readonly text?: string | null;
  /** `null` when the element carries no `value`. */
  readonly value?: string | null;
  /** `null` when the attribute is absent. */
  readonly attribute?: string | null;
  /** Per-field read failures, keyed by the request field name. */
  readonly failures?: Readonly<Record<string, string>>;
}

export type ElementResolution =
  { readonly kind: "element"; readonly el: ElementToken } | ElementRefusal;
export type ElementProbeResult = ElementReading | ElementRefusal;
export type ElementBoundsResult =
  { readonly kind: "bounds"; readonly rect: Rect | null } | ElementRefusal;
export type ElementCountResult = { readonly kind: "count"; readonly n: number } | ElementRefusal;

/** Resolution and probing of one element. Four members; `probe` takes a
 *  discriminated request so a fifth read does not add a fifth member.
 *
 *  The session's `RefRegistry` is a CONSTRUCTOR dependency of each implementation,
 *  not a per-call argument — one substrate instance belongs to one session, and
 *  `CaptureSubstrate` already takes it the same way. Keeping it out of the
 *  signatures is also what lets this module import nothing at all. */
export interface ElementSubstrate {
  /** Engine tag — for diagnostics + the per-engine keystone matrix. */
  readonly engine: string;
  /** Turn a query into a token, or refuse naming the reason and the ref. Does NOT
   *  touch the page: it validates the query against the registry and mints the
   *  recipe, mirroring what `resolveOrFail` did before the port existed. The
   *  match count is a `probe` concern, so a caller that only needs a handle pays
   *  for no round trip. */
  resolve(query: ElementQuery, scope?: ElementScope): Promise<ElementResolution>;
  /** Viewport-space bounds, for gesture geometry, element-scoped capture and
   *  `find`'s bbox fallback. `rect: null` is "no rendered box", which is a real
   *  answer and not a refusal. */
  bounds(el: ElementToken, opts?: { timeoutMs?: number }): Promise<ElementBoundsResult>;
  /** The batched read: visibility, text, value, attribute, enabled-ness and the
   *  match count, in as few round trips as the engine can manage. */
  probe(el: ElementToken, want: ElementProbeRequest): Promise<ElementProbeResult>;
  /** How many nodes the query matches. `verify_count` and `find`'s hint
   *  disambiguation. */
  count(query: ElementQuery, scope?: ElementScope): Promise<ElementCountResult>;
}
