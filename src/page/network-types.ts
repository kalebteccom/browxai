// Engine-blind network domain — the shapes and pure helpers the network slice
// is built on, with no CDP/Playwright binding. The CDP tap (`network-cdp.ts`)
// and the Playwright-events twin (`network-playwright.ts`) both import this leaf
// so their egress shapes are byte-identical; this file is the one place the
// summary fold, the resourceType reconciliation, the url-pattern, and the
// response-shape extraction rules live.

import type { SecretRegistry } from "../util/secrets.js";
import { patternisePath } from "../util/url-sanitizer.js";
import { maskedUrl } from "./network-mask.js";
import type { WsFrame } from "./network-ws.js";

export interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
  type: string;
  ms?: number;
  failed?: boolean;
  /** CDP request id — the handle `network_body` resolves. Short-lived:
   *  the renderer discards bodies fairly quickly, so fetch soon after. */
  requestId?: string;
  /** Best-effort response `Content-Type` from CDP `Network.responseReceived`
   *  (`response.mimeType`). Absent on failed requests, attached pre-response,
   *  or non-HTTP transports. Captured for downstream filtering / asset export;
   *  NOT emitted on the `network_read` egress (which only surfaces the type
   *  bucket). */
  mimeType?: string;
  /** Best-effort encoded byte size from CDP `Network.loadingFinished`
   *  (`encodedDataLength`). Absent on requests that haven't finished or where
   *  the loadingFinished event hasn't landed yet. Captured for downstream
   *  filtering / asset export. */
  bytes?: number;
}

export interface NetworkSummary {
  total: number;
  byType: Record<string, number>;
  failed: number;
}

/** The session-wide HTTP ring surface the tools above the engine seam consume
 *  (network_read, asset_export, session_metrics). Both the CDP `NetworkBuffer`
 *  and the Playwright `PlaywrightNetworkBuffer` satisfy it, so the NetworkSubstrate
 *  exposes this engine-blind shape rather than a concrete class. */
export interface SessionNetworkRing {
  setSecrets(secrets: SecretRegistry): void;
  iter(): readonly NetworkEntry[];
  recent(limit?: number): { summary: NetworkSummary; requests: NetworkEntry[] };
}

/** The session-wide WS/SSE ring surface the tools above the engine seam consume
 *  (ws_read; the action window's `wsFrames` slice). Both `WsBuffer` and
 *  `PlaywrightWsBuffer` satisfy it. */
export interface SessionWsRing {
  setSecrets(secrets: SecretRegistry): void;
  recent(limit?: number, urlPattern?: string): { total: number; frames: WsFrame[] };
  since(ts: number, cap?: number): WsFrame[];
}

/** bounded summary of a write-shaped request whose response landed in the
 *  action window. `responseShape` is the *top-level keys* of the parsed JSON
 *  response — no values, no nested keys. `urlPattern` strips the query string
 *  and replaces id-shaped path segments (numeric / UUID / hex) with `:id`. */
export interface MutationEntry {
  method: string;
  urlPattern: string;
  status: number;
  ok: boolean;
  /** Top-level object keys of the JSON response (or first-element keys for an
   *  array response). Capped at 20 entries. Absent for non-JSON bodies. */
  responseShape?: string[];
  durationMs?: number;
}

export const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_RESPONSE_SHAPE_KEYS = 20;
export const MAX_BODY_BYTES_TO_PARSE = 256_000; // skip parsing huge bodies; ~256KB JSON ceiling

const NOISE_TYPES = new Set(["Image", "Font", "Stylesheet", "Media", "Manifest"]);
const BEACON_HINTS = ["beacon", "/collect", "analytics", "gtag", "doubleclick", "pixel"];

function isBeacon(url: string): boolean {
  const lower = url.toLowerCase();
  return BEACON_HINTS.some((h) => lower.includes(h));
}

/** Map Playwright's `request.resourceType()` (lowercase, a slightly coarser
 *  taxonomy) onto the CDP-capitalised type names the CDP tap emits, so the
 *  noise-fold (`NOISE_TYPES`) + `byType` summary buckets are identical in shape
 *  across engines. The resourceType nuance to be aware of: a few
 *  CDP types (`Ping`, `CSPViolationReport`, `Preflight`, …) have no Playwright
 *  equivalent and fold into `Other`; `xhr`/`fetch` both map to their CDP forms.
 *  This is the only place engine resourceType skew is reconciled. */
const PW_RESOURCE_TYPE: Readonly<Record<string, string>> = {
  document: "Document",
  stylesheet: "Stylesheet",
  image: "Image",
  media: "Media",
  font: "Font",
  script: "Script",
  texttrack: "TextTrack",
  xhr: "XHR",
  fetch: "Fetch",
  eventsource: "EventSource",
  websocket: "WebSocket",
  manifest: "Manifest",
  other: "Other",
};
/** Exported for unit tests of the cross-engine resourceType reconciliation. */
export function cdpTypeFromPlaywright(resourceType: string): string {
  return PW_RESOURCE_TYPE[resourceType] ?? "Other";
}

/** Fold a finished-entry list into the `{summary, requests}` the network_read /
 *  action-tap egress emits: noise/beacon entries collapse into `summary.byType
 *  .other` (and stay out of `requests`), failures count toward `summary.failed`,
 *  and the surviving "interesting" entries have their URL masked at egress. This
 *  is the EXACT logic the CDP `NetworkTap.close()` / `NetworkBuffer.recent()`
 *  loops run inline; extracted so the Playwright-event buffers/tap produce a
 *  byte-identical shape without duplicating the rule. */
export function foldInteresting(
  entries: readonly NetworkEntry[],
  secrets: SecretRegistry | null,
): { summary: NetworkSummary; requests: NetworkEntry[] } {
  const summary: NetworkSummary = { total: entries.length, byType: {}, failed: 0 };
  const interesting: NetworkEntry[] = [];
  for (const e of entries) {
    let bucket = e.type;
    if (NOISE_TYPES.has(e.type) || isBeacon(e.url)) bucket = "other";
    summary.byType[bucket] = (summary.byType[bucket] ?? 0) + 1;
    if (e.failed) summary.failed += 1;
    if (bucket !== "other") interesting.push({ ...e, url: maskedUrl(e.url, secrets) });
  }
  return { summary, requests: interesting };
}

/** The request/response detail describing one mutation, threaded as a single
 *  group so the probe signatures stay within the param budget (the CDP and
 *  Playwright probes both carry the same four fields alongside their transport
 *  handle). */
export interface MutationDetail {
  method: string;
  url: string;
  status: number;
  durationMs: number;
}

export function mutationWithoutShape(detail: MutationDetail): MutationEntry {
  return {
    method: detail.method,
    urlPattern: patterniseUrl(detail.url),
    status: detail.status,
    ok: true,
    durationMs: detail.durationMs,
  };
}

/** Build a mutation entry, attaching the response shape only when non-empty —
 *  the success path shared by the CDP and Playwright probes. */
export function mutationWithShape(
  detail: MutationDetail,
  responseShape: string[] | null,
): MutationEntry {
  const entry = mutationWithoutShape(detail);
  if (responseShape && responseShape.length > 0) entry.responseShape = responseShape;
  return entry;
}

/**
 * Strip the query string and replace id-shaped path segments with `:id`. Keeps
 * the route stable across requests for the same logical endpoint without
 * leaking the specific record id in the result.
 *
 * Exported for unit tests.
 */
export function patterniseUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  return `${u.origin}${patternisePath(u.pathname)}`;
}

/**
 * Extract the top-level keys of a parsed JSON body. For an object, returns
 * `Object.keys()`. For an array of objects, returns the first element's keys
 * (prefixed with `[].` to signal array shape). Returns null otherwise.
 *
 * Capped at MAX_RESPONSE_SHAPE_KEYS entries. Exported for unit tests.
 */
export function extractTopLevelKeys(parsed: unknown): string[] | null {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return Object.keys(parsed).slice(0, MAX_RESPONSE_SHAPE_KEYS);
  }
  if (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed[0] &&
    typeof parsed[0] === "object" &&
    !Array.isArray(parsed[0])
  ) {
    return Object.keys(parsed[0] as Record<string, unknown>)
      .slice(0, MAX_RESPONSE_SHAPE_KEYS)
      .map((k) => `[].${k}`);
  }
  return null;
}
