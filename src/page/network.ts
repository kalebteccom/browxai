// CDP network tap for an "action window" — open before dispatch, close after
// network-idle-ish quiet. Filters out the high-noise/low-signal resource types by
// default (images, fonts, stylesheets, media, beacons); they're still counted in
// the summary's `byType.other` bucket if you want the totals back.

import type { CDPSession } from "playwright-core";
import { patternisePath } from "../util/url-sanitizer.js";
import type { SecretRegistry } from "../util/secrets.js";
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

export class NetworkTap {
  private requests = new Map<
    string,
    { method: string; url: string; type: string; startedAt: number }
  >();
  private finished: NetworkEntry[] = [];
  private mutationPromises: Array<Promise<MutationEntry | null>> = [];
  private listeners: Array<() => void> = [];
  private enabled = false;

  /** Optional per-session secrets registry. When non-null, every URL +
   *  response-shape key that leaves through `close()` is run through the
   *  egress masking layer in addition to the URL sanitiser. */
  constructor(
    private cdp: CDPSession,
    private secrets: SecretRegistry | null = null,
  ) {}

  async open(): Promise<void> {
    if (!this.enabled) {
      await this.cdp.send("Network.enable");
      this.enabled = true;
    }
    this.requests.clear();
    this.finished = [];
    this.mutationPromises = [];

    const onRequest = (e: {
      requestId: string;
      request: { method: string; url: string };
      type?: string;
    }) => {
      this.requests.set(e.requestId, {
        method: e.request.method,
        url: e.request.url,
        type: e.type ?? "Other",
        startedAt: Date.now(),
      });
    };
    const onResponse = (e: { requestId: string; response: { status: number } }) => {
      const r = this.requests.get(e.requestId);
      if (!r) return;
      const ms = Date.now() - r.startedAt;
      this.finished.push({
        method: r.method,
        url: r.url,
        status: e.response.status,
        type: r.type,
        ms,
      });
      // write-shaped + 2xx → kick off a bounded body probe for `mutations`.
      // Captured request fields are snapshotted into the closure since the entry
      // gets deleted below.
      if (MUTATION_METHODS.has(r.method) && e.response.status >= 200 && e.response.status < 300) {
        this.mutationPromises.push(
          probeMutation(this.cdp, e.requestId, {
            method: r.method,
            url: r.url,
            status: e.response.status,
            durationMs: ms,
          }),
        );
      }
      this.requests.delete(e.requestId);
    };
    const onFailed = (e: { requestId: string }) => {
      const r = this.requests.get(e.requestId);
      if (!r) return;
      this.finished.push({
        method: r.method,
        url: r.url,
        type: r.type,
        failed: true,
        ms: Date.now() - r.startedAt,
      });
      this.requests.delete(e.requestId);
    };

    this.cdp.on("Network.requestWillBeSent", onRequest);
    this.cdp.on("Network.responseReceived", onResponse);
    this.cdp.on("Network.loadingFailed", onFailed);
    this.listeners = [
      () => this.cdp.off("Network.requestWillBeSent", onRequest),
      () => this.cdp.off("Network.responseReceived", onResponse),
      () => this.cdp.off("Network.loadingFailed", onFailed),
    ];
  }

  /**
   * Stop listening and produce a `{ summary, requests, mutations }` snapshot of
   * the window. `requests` only includes the "interesting" entries (non-noise,
   * non-beacon). Noise still counts toward `summary.byType.other`. `mutations`
   * is awaited from the response-body probes kicked off during the window.
   */
  async close(): Promise<{
    summary: NetworkSummary;
    requests: NetworkEntry[];
    mutations: MutationEntry[];
  }> {
    for (const off of this.listeners) off();
    this.listeners = [];
    // The summary/interesting fold is the shared `foldInteresting` rule (RFC 0004
    // P3 / D4) — noise/beacon entries collapse into `summary.byType.other` and stay
    // out of `requests`, failures count toward `summary.failed`, and surviving
    // entries are URL-masked at egress. The ring keeps the raw url so beacon
    // detection / url-substring filtering still see the real value; masking
    // composes with the URL sanitiser (regex on URL shape vs literal value scan).
    const { summary, requests: interesting } = foldInteresting(this.finished, this.secrets);
    const mutationsRaw = (await Promise.all(this.mutationPromises)).filter(
      (m): m is MutationEntry => m !== null,
    );
    // mask mutation URLs + responseShape keys at egress. A response-key name
    // (`sessionToken`, `apiSecret`) typically won't literally equal a
    // registered value, but the key list is still string data — applying the
    // egress layer here keeps the rule "every egress sink masks" absolute.
    const mutations: MutationEntry[] = mutationsRaw.map((m) => {
      const out: MutationEntry = {
        ...m,
        urlPattern: this.secrets ? this.secrets.applyMaskInText(m.urlPattern) : m.urlPattern,
      };
      if (m.responseShape && this.secrets) {
        out.responseShape = m.responseShape.map((k) => this.secrets!.applyMaskInText(k));
      }
      return out;
    });
    return { summary, requests: interesting, mutations };
  }
}

// ---------------------------------------------------------------------------
// WebSocket / Server-Sent-Events frame capture lives in `network-ws.ts` (the
// `WsFrame` shape + `sanitizeFrame` egress sanitiser are shared with the
// off-Chromium WS ring); re-exported here so callers use the one barrel.
export type { WsFrame } from "./network-ws.js";
export { sanitizeFrame, WsBuffer } from "./network-ws.js";

/**
 * fetch a response body by CDP request id. Gated behind the off-by-
 * default `network-body` capability — full bodies can carry PII / tokens.
 * Bounded (`maxBytes`, default 256 KB). Best-effort: the renderer discards
 * bodies fairly quickly, so this can legitimately fail with "not available".
 */
export async function fetchResponseBody(
  cdp: CDPSession,
  requestId: string,
  maxBytes = 256_000,
  secrets: SecretRegistry | null = null,
): Promise<{
  ok: boolean;
  body?: string;
  base64Encoded?: boolean;
  truncated?: boolean;
  error?: string;
}> {
  try {
    const { body, base64Encoded } = await cdp.send("Network.getResponseBody", { requestId });
    const sliced = body.length > maxBytes ? body.slice(0, maxBytes) : body;
    const truncated = body.length > maxBytes;
    // egress masking. Base64 bodies pass through unchanged — the literal
    // real-value scan would never match an encoded form, and the agent's
    // contract for base64 is "decode then re-mask on your side." Document
    // this caveat in docs/tool-reference.md.
    const out = !base64Encoded && secrets ? secrets.applyMaskInText(sliced) : sliced;
    return { ok: true, body: out, base64Encoded, ...(truncated ? { truncated: true } : {}) };
  } catch (e) {
    return {
      ok: false,
      error:
        (e instanceof Error ? e.message : String(e)) +
        " — response bodies are short-lived; fetch right after the request, and note bodies aren't retained across navigations.",
    };
  }
}

/**
 * Best-effort mutation-detail probe. Fetches the response body via
 * `Network.getResponseBody`, extracts only the *top-level keys* of the parsed
 * JSON. Returns null on any failure (body discarded, non-JSON, parse error,
 * over-size body) so the caller can simply filter nulls out.
 *
 * Exported for unit tests of the urlPattern / responseShape helpers via
 * `patterniseUrl` / `extractTopLevelKeys`.
 */
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

async function probeMutation(
  cdp: CDPSession,
  requestId: string,
  detail: MutationDetail,
): Promise<MutationEntry | null> {
  try {
    const { body, base64Encoded } = await cdp.send("Network.getResponseBody", { requestId });
    if (base64Encoded) return mutationWithoutShape(detail);
    if (body.length > MAX_BODY_BYTES_TO_PARSE) return mutationWithoutShape(detail);
    const trimmed = body.trim();
    if (!trimmed) return mutationWithoutShape(detail);
    if (trimmed[0] !== "{" && trimmed[0] !== "[") return mutationWithoutShape(detail);
    const parsed: unknown = JSON.parse(trimmed);
    return mutationWithShape(detail, extractTopLevelKeys(parsed));
  } catch {
    // Body unavailable (already discarded), CDP error, or JSON parse failure.
    // Skip the entry — we'd rather omit than emit something misleading.
    return null;
  }
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
export function mutationWithShape(detail: MutationDetail, responseShape: string[] | null): MutationEntry {
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

/**
 * Session-wide ring buffer of network requests. Same shape as NetworkTap but
 * always-on for the lifetime of the session — exposed via the `network_read`
 * MCP tool. Per-action attribution still lives in `ActionResult.network`;
 * this is the "what happened recently across the session" surface.
 */
export class NetworkBuffer {
  private requests = new Map<
    string,
    { method: string; url: string; type: string; startedAt: number }
  >();
  private ring: NetworkEntry[] = [];
  /** requestId → entry pointer for the entries currently in `ring`. Lets
   *  `Network.loadingFinished` stamp `bytes` onto the corresponding entry
   *  without a linear scan. Pruned in `push` when an entry is evicted. */
  private byReqId = new Map<string, NetworkEntry>();
  private enabled = false;
  private secrets: SecretRegistry | null = null;

  constructor(
    // CDP is the network-tap substrate today; a later change will port it onto
    // Playwright's request/response events so non-CDP engines are supported.
    // On an engine without CDP (Firefox) the buffer
    // is constructed but never attaches — `recent`/`since` reads return empty
    // until the substrate port lands, rather than throwing at session creation.
    private cdp: CDPSession | undefined,
    private cap = 500,
  ) {}

  setSecrets(secrets: SecretRegistry): void {
    this.secrets = secrets;
  }

  async attach(): Promise<void> {
    if (this.enabled || !this.cdp) return;
    await this.cdp.send("Network.enable");
    this.enabled = true;
    this.cdp.on(
      "Network.requestWillBeSent",
      (e: { requestId: string; request: { method: string; url: string }; type?: string }) => {
        this.requests.set(e.requestId, {
          method: e.request.method,
          url: e.request.url,
          type: e.type ?? "Other",
          startedAt: Date.now(),
        });
      },
    );
    this.cdp.on(
      "Network.responseReceived",
      (e: { requestId: string; response: { status: number; mimeType?: string } }) => {
        const r = this.requests.get(e.requestId);
        if (!r) return;
        const entry: NetworkEntry = {
          method: r.method,
          url: r.url,
          status: e.response.status,
          type: r.type,
          ms: Date.now() - r.startedAt,
          requestId: e.requestId,
        };
        if (e.response.mimeType) entry.mimeType = e.response.mimeType;
        this.push(entry);
        // Index the just-pushed entry by requestId so a subsequent
        // `Network.loadingFinished` can stamp the encoded byte size on it
        // without a linear scan. Cleared on eviction (see `push`).
        this.byReqId.set(e.requestId, entry);
        this.requests.delete(e.requestId);
      },
    );
    this.cdp.on(
      "Network.loadingFinished",
      (e: { requestId: string; encodedDataLength?: number }) => {
        const entry = this.byReqId.get(e.requestId);
        if (!entry) return;
        if (typeof e.encodedDataLength === "number" && e.encodedDataLength >= 0) {
          entry.bytes = e.encodedDataLength;
        }
      },
    );
    this.cdp.on("Network.loadingFailed", (e: { requestId: string }) => {
      const r = this.requests.get(e.requestId);
      if (!r) return;
      this.push({
        method: r.method,
        url: r.url,
        type: r.type,
        failed: true,
        ms: Date.now() - r.startedAt,
        requestId: e.requestId,
      });
      this.requests.delete(e.requestId);
    });
  }

  private push(entry: NetworkEntry): void {
    this.ring.push(entry);
    if (this.ring.length > this.cap) {
      const evicted = this.ring.shift();
      if (evicted?.requestId) this.byReqId.delete(evicted.requestId);
    }
  }

  /** Raw, read-only snapshot of the ring — every entry, no noise/beacon
   *  folding, no egress masking. The masked / bucketed shape used by the
   *  `network_read` tool stays unchanged (see `recent`). This view is for
   *  consumers that need the full set as captured (e.g. `asset_export`
   *  iterating to pick image/font/media responses out of the ring). */
  iter(): readonly NetworkEntry[] {
    return this.ring;
  }

  /** Most-recent N entries; noise + beacons are folded into the `other` bucket of the summary. */
  recent(limit = 50): { summary: NetworkSummary; requests: NetworkEntry[] } {
    // Routed through the shared `foldInteresting` rule (RFC 0004 P3 / D4) — the
    // CDP `NetworkBuffer.recent()` now produces the byte-identical shape the
    // Playwright buffer already did, instead of a fourth inlined copy of the fold.
    return foldInteresting(this.ring.slice(-limit), this.secrets);
  }
}

// ===========================================================================
// Off-Chromium (Playwright-events) network/WebSocket capture lives in a sibling
// module to keep this file under the size budget; re-exported here so callers
// import the whole network surface from the one `./network.js` barrel, unchanged.
export {
  PlaywrightNetworkTap,
  PlaywrightNetworkBuffer,
  PlaywrightWsBuffer,
} from "./network-playwright.js";
