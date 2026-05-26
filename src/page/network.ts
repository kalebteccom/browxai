// CDP network tap for an "action window" — open before dispatch, close after
// network-idle-ish quiet. Filters out the high-noise/low-signal resource types by
// default (images, fonts, stylesheets, media, beacons); they're still counted in
// the summary's `byType.other` bucket if you want the totals back.

import type { CDPSession } from "playwright-core";
import { sanitizeUrl, sanitizeUrlsInText, patternisePath } from "../util/url-sanitizer.js";
import type { SecretRegistry } from "../util/secrets.js";

/** Apply the W-O1 URL sanitiser then the per-session secrets-masking layer.
 *  Order matters: secrets-masking is literal substring; the URL sanitiser
 *  may already have stripped a credentialled query, but a real-value that
 *  landed in the path is still caught by the literal scan after. */
function maskedUrl(url: string, secrets: SecretRegistry | null): string {
  const u = sanitizeUrl(url);
  return secrets ? secrets.applyMaskInText(u) : u;
}
function maskedText(text: string, secrets: SecretRegistry | null): string {
  const t = sanitizeUrlsInText(text);
  return secrets ? secrets.applyMaskInText(t) : t;
}

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
}

export interface NetworkSummary {
  total: number;
  byType: Record<string, number>;
  failed: number;
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

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_RESPONSE_SHAPE_KEYS = 20;
const MAX_BODY_BYTES_TO_PARSE = 256_000; // skip parsing huge bodies; ~256KB JSON ceiling

const NOISE_TYPES = new Set(["Image", "Font", "Stylesheet", "Media", "Manifest"]);
const BEACON_HINTS = ["beacon", "/collect", "analytics", "gtag", "doubleclick", "pixel"];

function isBeacon(url: string): boolean {
  const lower = url.toLowerCase();
  return BEACON_HINTS.some((h) => lower.includes(h));
}

export class NetworkTap {
  private requests = new Map<string, { method: string; url: string; type: string; startedAt: number }>();
  private finished: NetworkEntry[] = [];
  private mutationPromises: Array<Promise<MutationEntry | null>> = [];
  private listeners: Array<() => void> = [];
  private enabled = false;

  /** Optional per-session secrets registry. When non-null, every URL +
   *  response-shape key that leaves through `close()` is run through the
   *  egress masking layer in addition to the W-O1 URL sanitiser. */
  constructor(private cdp: CDPSession, private secrets: SecretRegistry | null = null) {}

  async open(): Promise<void> {
    if (!this.enabled) {
      await this.cdp.send("Network.enable");
      this.enabled = true;
    }
    this.requests.clear();
    this.finished = [];
    this.mutationPromises = [];

    const onRequest = (e: { requestId: string; request: { method: string; url: string }; type?: string }) => {
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
          probeMutation(this.cdp, e.requestId, r.method, r.url, e.response.status, ms),
        );
      }
      this.requests.delete(e.requestId);
    };
    const onFailed = (e: { requestId: string }) => {
      const r = this.requests.get(e.requestId);
      if (!r) return;
      this.finished.push({ method: r.method, url: r.url, type: r.type, failed: true, ms: Date.now() - r.startedAt });
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
  async close(): Promise<{ summary: NetworkSummary; requests: NetworkEntry[]; mutations: MutationEntry[] }> {
    for (const off of this.listeners) off();
    this.listeners = [];
    const summary: NetworkSummary = { total: this.finished.length, byType: {}, failed: 0 };
    const interesting: NetworkEntry[] = [];
    for (const e of this.finished) {
      let bucket = e.type;
      if (NOISE_TYPES.has(e.type) || isBeacon(e.url)) bucket = "other";
      summary.byType[bucket] = (summary.byType[bucket] ?? 0) + 1;
      if (e.failed) summary.failed += 1;
      // sanitize at the egress boundary only — the ring keeps the raw url so
      // beacon detection / url-substring filtering still see the real value.
      // The secrets-masking layer composes with the URL sanitiser (no fight:
      // sanitiser is regex on URL shape; masking is literal real-value scan).
      if (bucket !== "other") interesting.push({ ...e, url: maskedUrl(e.url, this.secrets) });
    }
    const mutationsRaw = (await Promise.all(this.mutationPromises)).filter((m): m is MutationEntry => m !== null);
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
// WebSocket / Server-Sent-Events frame capture.
//
// `network_read` / `ActionResult.network` only see HTTP. Realtime correctness
// (chat, multiplayer, collaborative editing, live dashboards) is only
// observable at the frame level. `WsBuffer` is the session-wide analogue of
// `NetworkBuffer`: a bounded ring of recent WS/SSE frames, payloads truncated.

export interface WsFrame {
  /** WS/SSE endpoint URL (best-effort — empty if the create event was missed). */
  url: string;
  dir: "sent" | "recv";
  kind: "ws" | "sse";
  /** WS opcode (1=text, 2=binary, 8=close, 9=ping, 10=pong). Absent for SSE. */
  opcode?: number;
  /** SSE event name when present (`eventName` from CDP). */
  event?: string;
  /** Payload, truncated to `maxPayload` chars. */
  payload: string;
  truncated?: boolean;
  ts: number;
}

/** Egress sanitizer for a WS/SSE frame: redact the endpoint url, any url
 *  substrings inside the payload (a stream payload can echo a credentialled
 *  URL too), and any registered-secret real-values that landed in the
 *  payload (chat / multiplayer / live-dashboard broadcasts routinely echo
 *  the auth blob the client sent). Returns a copy — the ring keeps raw
 *  frames for url filtering. */
function sanitizeFrame(f: WsFrame, secrets: SecretRegistry | null): WsFrame {
  return {
    ...f,
    url: maskedUrl(f.url, secrets),
    payload: maskedText(f.payload, secrets),
  };
}

export class WsBuffer {
  private urls = new Map<string, string>(); // requestId → endpoint url
  private ring: WsFrame[] = [];
  private enabled = false;
  /** Optional per-session secrets registry; egress masking is applied on
   *  every `recent` / `since` read. */
  private secrets: SecretRegistry | null = null;

  constructor(private cdp: CDPSession, private cap = 500, private maxPayload = 2000) {}

  setSecrets(secrets: SecretRegistry): void {
    this.secrets = secrets;
  }

  private trunc(s: string): { payload: string; truncated?: boolean } {
    if (s.length <= this.maxPayload) return { payload: s };
    return { payload: s.slice(0, this.maxPayload), truncated: true };
  }

  private push(f: WsFrame): void {
    this.ring.push(f);
    if (this.ring.length > this.cap) this.ring.shift();
  }

  async attach(): Promise<void> {
    if (this.enabled) return;
    await this.cdp.send("Network.enable").catch(() => undefined); // idempotent w/ NetworkBuffer
    this.enabled = true;
    this.cdp.on("Network.webSocketCreated", (e: { requestId: string; url: string }) => {
      this.urls.set(e.requestId, e.url);
    });
    this.cdp.on(
      "Network.requestWillBeSent",
      (e: { requestId: string; request: { url: string }; type?: string }) => {
        if (e.type === "EventSource") this.urls.set(e.requestId, e.request.url);
      },
    );
    const onFrame = (dir: "sent" | "recv") =>
      (e: { requestId: string; timestamp?: number; response: { opcode: number; payloadData: string } }) => {
        this.push({
          url: this.urls.get(e.requestId) ?? "",
          dir,
          kind: "ws",
          opcode: e.response.opcode,
          ...this.trunc(e.response.payloadData ?? ""),
          ts: Date.now(),
        });
      };
    this.cdp.on("Network.webSocketFrameSent", onFrame("sent"));
    this.cdp.on("Network.webSocketFrameReceived", onFrame("recv"));
    this.cdp.on(
      "Network.eventSourceMessageReceived",
      (e: { requestId: string; eventName?: string; data: string }) => {
        this.push({
          url: this.urls.get(e.requestId) ?? "",
          dir: "recv",
          kind: "sse",
          event: e.eventName || undefined,
          ...this.trunc(e.data ?? ""),
          ts: Date.now(),
        });
      },
    );
  }

  /** Most-recent N frames, optionally filtered by a url substring. */
  recent(limit = 50, urlPattern?: string): { total: number; frames: WsFrame[] } {
    let frames = this.ring;
    // filter on the raw url, then sanitize the endpoint on the way out.
    if (urlPattern) frames = frames.filter((f) => f.url.includes(urlPattern));
    return { total: frames.length, frames: frames.slice(-limit).map((f) => sanitizeFrame(f, this.secrets)) };
  }

  /** Frames since a timestamp — for the per-action `ActionResult` slice. */
  since(ts: number, cap = 25): WsFrame[] {
    return this.ring.filter((f) => f.ts >= ts).slice(-cap).map((f) => sanitizeFrame(f, this.secrets));
  }
}

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
): Promise<{ ok: boolean; body?: string; base64Encoded?: boolean; truncated?: boolean; error?: string }> {
  try {
    const { body, base64Encoded } = (await cdp.send("Network.getResponseBody", { requestId })) as {
      body: string;
      base64Encoded: boolean;
    };
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
async function probeMutation(
  cdp: CDPSession,
  requestId: string,
  method: string,
  url: string,
  status: number,
  durationMs: number,
): Promise<MutationEntry | null> {
  try {
    const { body, base64Encoded } = (await cdp.send("Network.getResponseBody", { requestId })) as {
      body: string;
      base64Encoded: boolean;
    };
    if (base64Encoded) return mutationWithoutShape(method, url, status, durationMs);
    if (body.length > MAX_BODY_BYTES_TO_PARSE) return mutationWithoutShape(method, url, status, durationMs);
    const trimmed = body.trim();
    if (!trimmed) return mutationWithoutShape(method, url, status, durationMs);
    if (trimmed[0] !== "{" && trimmed[0] !== "[") return mutationWithoutShape(method, url, status, durationMs);
    const parsed = JSON.parse(trimmed);
    const responseShape = extractTopLevelKeys(parsed);
    const entry: MutationEntry = {
      method,
      urlPattern: patterniseUrl(url),
      status,
      ok: true,
      durationMs,
    };
    if (responseShape && responseShape.length > 0) entry.responseShape = responseShape;
    return entry;
  } catch {
    // Body unavailable (already discarded), CDP error, or JSON parse failure.
    // Skip the entry — we'd rather omit than emit something misleading.
    return null;
  }
}

function mutationWithoutShape(method: string, url: string, status: number, durationMs: number): MutationEntry {
  return { method, urlPattern: patterniseUrl(url), status, ok: true, durationMs };
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
    return Object.keys(parsed as Record<string, unknown>).slice(0, MAX_RESPONSE_SHAPE_KEYS);
  }
  if (Array.isArray(parsed) && parsed.length > 0 && parsed[0] && typeof parsed[0] === "object" && !Array.isArray(parsed[0])) {
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
  private requests = new Map<string, { method: string; url: string; type: string; startedAt: number }>();
  private ring: NetworkEntry[] = [];
  private enabled = false;
  private secrets: SecretRegistry | null = null;

  constructor(private cdp: CDPSession, private cap = 500) {}

  setSecrets(secrets: SecretRegistry): void {
    this.secrets = secrets;
  }

  async attach(): Promise<void> {
    if (this.enabled) return;
    await this.cdp.send("Network.enable");
    this.enabled = true;
    this.cdp.on("Network.requestWillBeSent", (e: { requestId: string; request: { method: string; url: string }; type?: string }) => {
      this.requests.set(e.requestId, {
        method: e.request.method,
        url: e.request.url,
        type: e.type ?? "Other",
        startedAt: Date.now(),
      });
    });
    this.cdp.on("Network.responseReceived", (e: { requestId: string; response: { status: number } }) => {
      const r = this.requests.get(e.requestId);
      if (!r) return;
      this.push({ method: r.method, url: r.url, status: e.response.status, type: r.type, ms: Date.now() - r.startedAt, requestId: e.requestId });
      this.requests.delete(e.requestId);
    });
    this.cdp.on("Network.loadingFailed", (e: { requestId: string }) => {
      const r = this.requests.get(e.requestId);
      if (!r) return;
      this.push({ method: r.method, url: r.url, type: r.type, failed: true, ms: Date.now() - r.startedAt, requestId: e.requestId });
      this.requests.delete(e.requestId);
    });
  }

  private push(entry: NetworkEntry): void {
    this.ring.push(entry);
    if (this.ring.length > this.cap) this.ring.shift();
  }

  /** Most-recent N entries; noise + beacons are folded into the `other` bucket of the summary. */
  recent(limit = 50): { summary: NetworkSummary; requests: NetworkEntry[] } {
    const slice = this.ring.slice(-limit);
    const summary: NetworkSummary = { total: slice.length, byType: {}, failed: 0 };
    const interesting: NetworkEntry[] = [];
    for (const e of slice) {
      let bucket = e.type;
      if (NOISE_TYPES.has(e.type) || isBeacon(e.url)) bucket = "other";
      summary.byType[bucket] = (summary.byType[bucket] ?? 0) + 1;
      if (e.failed) summary.failed += 1;
      if (bucket !== "other") interesting.push({ ...e, url: maskedUrl(e.url, this.secrets) });
    }
    return { summary, requests: interesting };
  }
}
