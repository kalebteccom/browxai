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

/** Tools that require the raw-CDP (`deep`) escape hatch and therefore cannot run
 *  on an engine that declares `deep: false`. The set is the CDP-hard tools plus
 *  the live-CDP-mutation tools with no Playwright-Firefox fallback. Each maps to
 *  the per-engine reason surfaced in the refusal hint. */
export const DEEP_TOOLS: ReadonlySet<string> = new Set<string>([
  // perf / tracing (CDP `Tracing.*`) — Chrome trace-event format, engine-specific
  "perf_start",
  "perf_stop",
  "perf_insights",
  "perf_audit",
  "layout_thrash_trace",
  // coverage (CDP `Profiler.*` / `CSS.*RuleUsageTracking`) — V8/Blink-specific
  "coverage_start",
  "coverage_stop",
  // heap (CDP `HeapProfiler.*`) — V8 `.heapsnapshot` format
  "heap_snapshot",
  "heap_retainers",
  "memory_diff",
  // CPU throttle (CDP `Emulation.setCPUThrottlingRate`) — Blink-only
  "cpu_emulate",
  // network throttle — `emulation.setNetworkConditions` spec'd over BiDi but
  // not implemented in this Playwright build (reason: refuse-pending)
  "network_emulate",
  // Service-Worker fetch interception (CDP `Fetch.*` on the SW target)
  "sw_intercept_fetch",
  "sw_unintercept_fetch",
  // virtual time clock (CDP `Emulation.setVirtualTimePolicy`)
  "clock",
  // Chromium extension management (launch flags + CDP) — no Playwright Firefox API
  "extensions_install",
  "extensions_list",
  "extensions_reload",
  "extensions_trigger",
  "extensions_uninstall",
  // print to PDF — Playwright `page.pdf()` throws off Headless Chromium (measured)
  "pdf_save",
  // live locale / timezone / UA override (CDP `Emulation.*` / `Network.*`) —
  // Playwright bakes these at context creation; no live off-Chromium setter
  "set_locale",
  "set_timezone",
  "set_user_agent",
  // coordinate-space wheel + the touch/gesture family (CDP `Input.dispatch*`)
  "mouse_wheel",
  "touch_start",
  "touch_move",
  "touch_end",
  "gesture_pinch",
  "gesture_swipe",
  // closed-shadow piercing — CDP `DOM.getDocument({pierce:true})` is the only
  // automation-protocol path into closed shadow roots; no off-Chromium
  // equivalent (the one true feature-level loss). The open-shadow
  // half is portable, but the tool's headline (closed-shadow introspection) is
  // CDP-bound, so the whole tool gates off Chromium.
  "shadow_trees",
]);

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
  if (!DEEP_TOOLS.has(tool)) return null;
  const caps = capabilitiesFor(engine);
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
