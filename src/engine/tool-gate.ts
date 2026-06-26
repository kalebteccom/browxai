// The ENGINE-dimension tool gate. It composes with the
// per-tool capability system in util/capabilities.ts (which answers "is this
// tool's CAPABILITY in the active set?") by answering a second, orthogonal
// question: "can the ENGINE backing this session run this tool at all?"
//
// The classification covers the ~19 CDP-hard tools plus the tools whose
// Playwright Firefox lane has no live equivalent. All of them need the raw-CDP
// escape hatch. On an engine that declares `deep: false` (Firefox — measured:
// `newCDPSession` throws) they structured-refuse with a hint naming the engine,
// exactly like the
// `pdf_save`-on-BYOB and `extensions`-on-incognito refusals already shipped —
// not by letting `requireCdp` throw an opaque error mid-call.
//
// Three tools the critic re-resolved per the spec facts, reflected in
// the per-engine reason map below:
//   - pdf_save        → `browsingContext.print` exists, but Playwright's
//                       `page.pdf()` throws off-Chromium (measured: "PDF
//                       generation is only supported for Headless Chromium").
//                       Gated on Firefox with a Firefox-specific hint — it does
//                       NOT crash the session.
//   - network_emulate → spec'd over BiDi (`emulation.setNetworkConditions`) but
//                       UNIMPLEMENTED in this Playwright/Juggler build → gated,
//                       reason "refuse-pending".
//   - set_user_agent  → BiDi `emulation.setUserAgentOverride` is spec'd, but the
//                       Playwright Juggler lane has NO live UA setter (measured:
//                       `context.setUserAgent` / `page.setUserAgent` are
//                       undefined) and the current impl uses CDP
//                       `Network.setUserAgentOverride` → gated on Firefox, with a
//                       hint pointing at context-creation UA + the BiDi lane.

import type { EngineKind } from "./types.js";
import { capabilitiesFor } from "./capabilities.js";
import { engineCapabilities } from "./capability-registry.js";

const DEEP_TOOLS_SET = new Set<string>();

/** Record that a tool needs the raw-CDP (`deep`) escape hatch, from its colocated
 *  `host.register({ deep: true })` metadata (RFC 0004 P2). The only writer of the
 *  derived `DEEP_TOOLS` set. Idempotent. */
export function declareDeepTool(tool: string): void {
  DEEP_TOOLS_SET.add(tool);
}

/** Lazy-collection seam (RFC 0004 P2), mirroring `installToolMetadataCollector`
 *  in capabilities.ts: the tools layer installs a collector that runs the
 *  registration metadata once and populates this set. `tool-gate.ts` (engine
 *  layer) cannot import the tools layer, so the dependency is inverted here. */
let deepToolsCollector: (() => void) | undefined;
let deepToolsLoaded = false;
/** True while the collector is mid-run — a re-entrant `DEEP_TOOLS` read during
 *  collection tolerates the partial set without tripping the fail-safe. */
let deepToolsCollecting = false;
export function installDeepToolsCollector(collect: () => void): void {
  deepToolsCollector = collect;
  deepToolsLoaded = false;
}
function ensureDeepToolsLoaded(): void {
  if (deepToolsLoaded || deepToolsCollector === undefined) return;
  deepToolsLoaded = true;
  deepToolsCollecting = true;
  try {
    deepToolsCollector();
  } finally {
    deepToolsCollecting = false;
  }
}

/**
 * D1 fail-safe (RFC 0004 P2, SECURITY-CRITICAL): the ENGINE gate must NEVER fail
 * OPEN. `assertEngineSupports` reads `DEEP_TOOLS.has(tool)` — an empty,
 * unbootstrapped set makes EVERY deep tool look cross-browser, so
 * `assertEngineSupports("perf_start", "firefox")` returns null (un-gated) when
 * the tools-layer bootstrap never ran. Rather than silently un-gate, throw a
 * structured error. The guaranteed bootstrap (`tool-metadata.ts`, reached by
 * every real entry point) keeps this from firing in production; this is the
 * backstop. Suppressed only during collection (the collector's own read sees a
 * partial set legitimately).
 */
function assertEngineGateBootstrapped(): void {
  if (DEEP_TOOLS_SET.size > 0 || deepToolsCollecting) return;
  throw new Error(
    "browxai engine gate read before the tool-metadata bootstrap ran: the derived " +
      "DEEP_TOOLS set is empty and no collector was installed. Refusing to fail OPEN " +
      "(which would let every CDP-deep tool run on a non-deep engine). Import the package " +
      'entry ("browxai") or call createServer before reading the engine gate. (RFC 0004 P2 / D1.)',
  );
}

/** Tools that require the raw-CDP (`deep`) escape hatch and therefore cannot run
 *  on an engine that declares `deep: false`. DERIVED (RFC 0004 P2 / D2) from each
 *  tool's `host.register({ deep: true })` metadata; any access drives the lazy
 *  collection. A `Proxy` over the live `Set` so membership, `.size`, and
 *  iteration all see the derived contents (and the `ReadonlySet<string>` type is
 *  inferred from the target, not hand-rolled). */
/** The membership / size / iteration surfaces an external consumer reads to
 *  answer "is this an engine-gated tool?". A read of one of these on an empty
 *  unbootstrapped set is the fail-open hazard, so they run the D1 fail-safe;
 *  internal/other property reads (Symbol.toStringTag, etc.) pass through. */
const DEEP_TOOLS_GATE_READS = new Set<PropertyKey>([
  "has",
  "size",
  "keys",
  "values",
  "entries",
  "forEach",
  Symbol.iterator,
]);
export const DEEP_TOOLS: ReadonlySet<string> = new Proxy(DEEP_TOOLS_SET, {
  get(target, prop) {
    ensureDeepToolsLoaded();
    if (DEEP_TOOLS_GATE_READS.has(prop)) assertEngineGateBootstrapped();
    // Read off the real Set (not via the Proxy receiver): `size` and the iterator
    // methods touch internal slots and throw on an incompatible receiver, and the
    // methods must keep `this` bound to the backing Set.
    const value = (target as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof value === "function"
      ? (value as (...a: unknown[]) => unknown).bind(target)
      : value;
  },
});

// The pre-P2 hand-maintained `DEEP_TOOLS` list (the per-tool rationale: which CDP
// surface each gates, the three critic-re-resolved tools) used to live here as a
// verbatim comment appendix. It was pruned once the derived `DEEP_TOOLS` set above
// became the single source of truth — membership now derives from each
// `host.register({ deep: true })` call, and the per-tool WHY lives at each tool's
// registration site (RFC 0004 P2 / D2).

/** Per-tool reason fragment appended to the refusal hint. Most tools share the
 *  generic "needs raw CDP" reason; the three the critic re-resolved carry a
 *  more specific note so the agent knows the per-engine path (or its absence). */
const TOOL_REASON: Readonly<Record<string, string>> = {
  network_emulate:
    "Link-condition throttling is spec'd over WebDriver BiDi " +
    "(`emulation.setNetworkConditions`) but not yet implemented in this Playwright build " +
    "— refuse-pending. Route-level `delayMs` approximations still work cross-engine.",
  set_user_agent:
    "Playwright has no live user-agent setter off Chromium (the current path uses " +
    "CDP `Network.setUserAgentOverride`). Bake the UA at session creation instead: " +
    '`open_session({ device: { userAgent: "…" } })`. Live BiDi UA override ' +
    "(`emulation.setUserAgentOverride`) arrives with the stock-Firefox BiDi lane.",
  pdf_save:
    "Playwright `page.pdf()` is Headless-Chromium-only and throws on Firefox " +
    "(`browsingContext.print` over BiDi is the eventual path). Open a chromium session to print.",
  set_locale:
    "Live locale override uses CDP `Emulation.setLocaleOverride`. Bake it at session " +
    "creation (`open_session({ locale })`) or use a chromium session for mid-session override.",
  set_timezone:
    "Live timezone override uses CDP `Emulation.setTimezoneOverride`. Bake it at session " +
    "creation (`open_session({ timezone })`) or use a chromium session for mid-session override.",
};

const GENERIC_REASON =
  "This tool needs the raw-CDP escape hatch (perf / coverage / heap / CPU+network " +
  "throttle / SW interception / virtual clock / extensions / CDP input dispatch), which " +
  "exists only on chromium. These tools are gated, not ported, per engine.";

/** The structured refusal envelope an engine-gated tool returns. Mirrors
 *  `assertPdfSupported`'s `{error, hint} | null` shape so handlers splice it in
 *  the same way. */
export interface EngineRefusal {
  error: string;
  hint: string;
}

/** Returns a structured refusal when `tool` cannot run on `engine`, else null.
 *  Null is the fast path on chromium (the only engine with `deep`) and on every
 *  cross-browser tool regardless of engine — a single Set lookup + a capability
 *  read, no allocation on the supported path. */
export function assertEngineSupports(tool: string, engine: EngineKind): EngineRefusal | null {
  // D1 fail-safe FIRST: a `DEEP_TOOLS.has` on an empty unbootstrapped set returns
  // false for every tool, so the early `return null` below would un-gate the
  // whole engine matrix. Assert the gate is bootstrapped before trusting the
  // membership read. (`DEEP_TOOLS.has` drives the lazy collection.)
  ensureDeepToolsLoaded();
  assertEngineGateBootstrapped();
  if (!DEEP_TOOLS.has(tool)) return null;
  // Prefer the EngineRegistry's capability record (RFC 0004 P1) — it is the source
  // of truth post-D1 and is what gates an engine registered ONLY at runtime (e.g.
  // the synthetic contract-test engine, whose `deep:false` is declared at
  // registration, not in the central `capabilitiesFor` table). Fall back to the
  // central declaration for any engine queried before its registration runs.
  const caps = engineCapabilities(engine) ?? capabilitiesFor(engine);
  // An engine with the deep escape hatch (chromium) runs everything; an engine
  // whose declaration hasn't landed yet is left to the launch path to reject.
  if (!caps || caps.deep) return null;
  const reason = TOOL_REASON[tool] ?? GENERIC_REASON;
  return {
    error: `tool "${tool}" is not supported on the "${engine}" engine`,
    hint:
      `${reason} ` +
      `Re-run on a chromium session (browserType:"chromium", the default), or check the ` +
      `per-engine capability matrix in docs/ai-context/architecture/engine-adapters.md.`,
  };
}
