// Off-Chromium network/WebSocket capture — the Playwright-events twin of the
// CDP classes in `network.ts`.
//
// Firefox/WebKit have no CDP `Network.*` domain (Firefox removed CDP in v141),
// so the network slice rides Playwright's cross-browser context events instead:
//   - `context.on('request')`        → a pending request (mirrors requestWillBeSent)
//   - `context.on('response')`       → status arrived (mirrors responseReceived)
//   - `context.on('requestfailed')`  → load error  (mirrors loadingFailed)
//   - `context.on('requestfinished')`→ encoded byte size (mirrors loadingFinished)
//   - `page.on('websocket')` + `ws.on('framesent'|'framereceived')` → WS frames
//
// These classes produce byte-identical egress shapes to the CDP ones (the same
// NetworkEntry / NetworkSummary / MutationEntry / WsFrame, the same noise-fold via
// `foldInteresting`, the same secrets masking), so every consumer above the seam
// is engine-blind. Playwright `Request` objects have no protocol id, so a
// monotonic synthetic id is minted per request and used as the `requestId` handle
// `network_body` resolves. Re-exported through `./network.js` so callers import
// the whole network surface from the one barrel, unchanged.

import type { BrowserContext, Page, Request, Response, WebSocket } from "playwright-core";
import type { SecretRegistry } from "../util/secrets.js";
import {
  type MutationDetail,
  type MutationEntry,
  type NetworkEntry,
  type NetworkSummary,
  cdpTypeFromPlaywright,
  extractTopLevelKeys,
  foldInteresting,
  mutationWithoutShape,
  mutationWithShape,
  MAX_BODY_BYTES_TO_PARSE,
  MUTATION_METHODS,
} from "./network.js";
import { type WsFrame, sanitizeFrame } from "./network-ws.js";

let pwRequestSeq = 0;
function nextPwRequestId(): string {
  return `pw-${(pwRequestSeq = (pwRequestSeq + 1) % Number.MAX_SAFE_INTEGER)}`;
}

/** A compressed body is read decoded, so its transfer size understates what
 *  `response.body()` allocates. A body with a `content-encoding` is read only when
 *  its transfer size is under `max / COMPRESSED_READ_DIVISOR`. */
const COMPRESSED_READ_DIVISOR = 8;

/** Whether a response body may be read into memory. Playwright's `response.body()`
 *  has no streaming form, so the size has to be known before the call: the
 *  transfer size once the request finished, else the `content-length` header.
 *  A body over `max` bytes, or of unknown size, is not read. */
export function bodyReadDecision(
  headers: Readonly<Record<string, string>>,
  max: number,
  finishedBytes?: number,
): { read: true } | { read: false; size?: number } {
  const declared =
    headers["content-length"] === undefined ? NaN : Number(headers["content-length"]);
  const size = finishedBytes ?? (Number.isFinite(declared) && declared >= 0 ? declared : undefined);
  if (size === undefined) return { read: false };
  const encoding = headers["content-encoding"]?.trim().toLowerCase();
  const limit =
    encoding && encoding !== "identity" ? Math.floor(max / COMPRESSED_READ_DIVISOR) : max;
  return size <= limit ? { read: true } : { read: false, size };
}

/** Best-effort mutation-detail probe over a Playwright `Response` (the off-
 *  Chromium analogue of `probeMutation`). Reads the body via `response.body()`
 *  (cross-browser) when its declared size is within `MAX_BODY_BYTES_TO_PARSE`,
 *  extracts only the top-level JSON keys. Returns null on any failure so the
 *  caller filters nulls out, identical to the CDP probe. */
async function probeMutationPlaywright(
  response: Response,
  detail: MutationDetail,
): Promise<MutationEntry | null> {
  try {
    if (!bodyReadDecision(response.headers(), MAX_BODY_BYTES_TO_PARSE).read) {
      return mutationWithoutShape(detail);
    }
    const buf = await response.body();
    if (buf.length > MAX_BODY_BYTES_TO_PARSE) return mutationWithoutShape(detail);
    const trimmed = buf.toString("utf-8").trim();
    if (!trimmed) return mutationWithoutShape(detail);
    if (trimmed[0] !== "{" && trimmed[0] !== "[") return mutationWithoutShape(detail);
    const parsed: unknown = JSON.parse(trimmed);
    return mutationWithShape(detail, extractTopLevelKeys(parsed));
  } catch {
    return null;
  }
}

/** Action-window network tap on Playwright context events — the off-Chromium
 *  twin of `NetworkTap`. Same lifecycle (`open()` before dispatch, `close()`
 *  after settle) and same `{summary, requests, mutations}` return shape. */
export class PlaywrightNetworkTap {
  private pending = new Map<
    Request,
    { method: string; url: string; type: string; startedAt: number }
  >();
  private finished: NetworkEntry[] = [];
  private mutationPromises: Array<Promise<MutationEntry | null>> = [];
  private listeners: Array<() => void> = [];

  constructor(
    private context: BrowserContext,
    private secrets: SecretRegistry | null = null,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async open(): Promise<void> {
    this.pending.clear();
    this.finished = [];
    this.mutationPromises = [];

    const onRequest = (req: Request) => {
      this.pending.set(req, {
        method: req.method(),
        url: req.url(),
        type: cdpTypeFromPlaywright(req.resourceType()),
        startedAt: Date.now(),
      });
    };
    const onResponse = (res: Response) => {
      const req = res.request();
      const r = this.pending.get(req);
      if (!r) return;
      const ms = Date.now() - r.startedAt;
      const status = res.status();
      this.finished.push({ method: r.method, url: r.url, status, type: r.type, ms });
      if (MUTATION_METHODS.has(r.method) && status >= 200 && status < 300) {
        this.mutationPromises.push(
          probeMutationPlaywright(res, { method: r.method, url: r.url, status, durationMs: ms }),
        );
      }
      this.pending.delete(req);
    };
    const onFailed = (req: Request) => {
      const r = this.pending.get(req);
      if (!r) return;
      this.finished.push({
        method: r.method,
        url: r.url,
        type: r.type,
        failed: true,
        ms: Date.now() - r.startedAt,
      });
      this.pending.delete(req);
    };

    this.context.on("request", onRequest);
    this.context.on("response", onResponse);
    this.context.on("requestfailed", onFailed);
    this.listeners = [
      () => this.context.off("request", onRequest),
      () => this.context.off("response", onResponse),
      () => this.context.off("requestfailed", onFailed),
    ];
  }

  async close(): Promise<{
    summary: NetworkSummary;
    requests: NetworkEntry[];
    mutations: MutationEntry[];
  }> {
    for (const off of this.listeners) off();
    this.listeners = [];
    const { summary, requests } = foldInteresting(this.finished, this.secrets);
    const mutationsRaw = (await Promise.all(this.mutationPromises)).filter(
      (m): m is MutationEntry => m !== null,
    );
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
    return { summary, requests, mutations };
  }
}

/** Session-wide network ring on Playwright context events — the off-Chromium
 *  twin of `NetworkBuffer`. Same ring + `recent()` / `iter()` shape; additionally
 *  captures response bodies at response time into a bounded LRU so `network_body`
 *  can resolve a `requestId` after the fact (there is no off-Chromium analogue of
 *  CDP `Network.getResponseBody`'s lazy fetch). */
export class PlaywrightNetworkBuffer {
  private ring: NetworkEntry[] = [];
  private ids = new WeakMap<Request, string>();
  /** recent responses keyed by synthetic request id, bounded LRU. A body is read
   *  from one only when `network_body` asks for it, so nothing is read into memory
   *  while the `network-body` capability is off. */
  private responses = new Map<string, Response>();
  private enabled = false;
  private secrets: SecretRegistry | null = null;

  constructor(
    private context: BrowserContext,
    private cap = 500,
    /** how many recent responses to keep reachable for `network_body`. Bounded so
     *  the buffer doesn't grow unbounded (the doctrine: bound the buffer).
     *  Default 50 — the agent fetches a body right after the request. */
    private bodyCap = 50,
    private maxBodyBytes = 256_000,
  ) {}

  setSecrets(secrets: SecretRegistry): void {
    this.secrets = secrets;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async attach(): Promise<void> {
    if (this.enabled) return;
    this.enabled = true;
    this.context.on("request", (req: Request) => {
      this.ids.set(req, nextPwRequestId());
    });
    this.context.on("response", (res: Response) => {
      const req = res.request();
      const id = this.ids.get(req) ?? nextPwRequestId();
      const entry: NetworkEntry = {
        method: req.method(),
        url: req.url(),
        status: res.status(),
        type: cdpTypeFromPlaywright(req.resourceType()),
        ms: 0,
        requestId: id,
      };
      const mime = res.headers()["content-type"];
      if (mime) entry.mimeType = mime;
      this.push(entry);
      // keep the response reachable for `network_body` (bounded). The body is
      // read when asked for, never here.
      this.remember(id, res);
    });
    this.context.on("requestfinished", (req: Request) => {
      const id = this.ids.get(req);
      if (!id) return;
      const entry = this.ring.find((e) => e.requestId === id);
      if (!entry) return;
      void req
        .sizes()
        .then((s) => {
          if (typeof s.responseBodySize === "number" && s.responseBodySize >= 0)
            entry.bytes = s.responseBodySize;
        })
        .catch(() => undefined);
    });
    this.context.on("requestfailed", (req: Request) => {
      const id = this.ids.get(req) ?? nextPwRequestId();
      this.push({
        method: req.method(),
        url: req.url(),
        type: cdpTypeFromPlaywright(req.resourceType()),
        failed: true,
        ms: 0,
        requestId: id,
      });
    });
  }

  private remember(id: string, res: Response): void {
    this.responses.set(id, res);
    // LRU eviction — keep the most recent `bodyCap` responses.
    if (this.responses.size > this.bodyCap) {
      const oldest = this.responses.keys().next().value;
      if (oldest !== undefined) this.responses.delete(oldest);
    }
  }

  private push(entry: NetworkEntry): void {
    this.ring.push(entry);
    if (this.ring.length > this.cap) this.ring.shift();
  }

  /** Raw, read-only snapshot of the ring (asset_export iterates this). */
  iter(): readonly NetworkEntry[] {
    return this.ring;
  }

  /** Most-recent N entries; noise + beacons folded into `other`. */
  recent(limit = 50): { summary: NetworkSummary; requests: NetworkEntry[] } {
    return foldInteresting(this.ring.slice(-limit), this.secrets);
  }

  /** Resolve a `requestId` to its body. The body is read now, and only when its
   *  declared size is within `maxBodyBytes` (see `bodyReadDecision`); a larger or
   *  unsized body is not read and the result says so. Emit as utf-8 unless the
   *  bytes aren't valid text, in which case base64 (matching the CDP
   *  `Network.getResponseBody` base64Encoded contract). Secrets masking is applied
   *  to text bodies (base64 passes through, same as the CDP path). */
  async fetchBody(
    requestId: string,
    secrets: SecretRegistry | null,
  ): Promise<{
    ok: boolean;
    body?: string;
    base64Encoded?: boolean;
    truncated?: boolean;
    error?: string;
  }> {
    const res = this.responses.get(requestId);
    if (!res) {
      return {
        ok: false,
        error:
          `response body not available for "${requestId}" — off Chromium, bodies are read from a ` +
          `bounded recent window of responses (no after-the-fact protocol fetch like CDP ` +
          `Network.getResponseBody). Read the body right after the request, before ${this.bodyCap} newer ` +
          `responses evict it; bodies aren't retained across navigations.`,
      };
    }
    const finishedBytes = this.ring.find((e) => e.requestId === requestId)?.bytes;
    const decision = bodyReadDecision(res.headers(), this.maxBodyBytes, finishedBytes);
    if (!decision.read) {
      return {
        ok: false,
        truncated: true,
        error:
          decision.size !== undefined
            ? `response body is ${decision.size} bytes, over the ${this.maxBodyBytes}-byte cap; it was not read.`
            : "response body size is not known yet (no content-length, and the request has not finished); it was not read. Retry once the request has finished.",
      };
    }
    let buf: Buffer;
    try {
      buf = await res.body();
    } catch {
      return {
        ok: false,
        error: `response body not available for "${requestId}" — the browser no longer holds it (a redirect, or a navigation since).`,
      };
    }
    // The declared size bounds the read. A decoded body can still run past the cap.
    const truncated = buf.length > this.maxBodyBytes;
    const stored = truncated ? buf.subarray(0, this.maxBodyBytes) : buf;
    // Decide text-vs-base64: a body that round-trips through utf-8 cleanly is
    // text; otherwise base64 (the agent decodes + re-masks on its side).
    const utf8 = stored.toString("utf-8");
    const isText = Buffer.from(utf8, "utf-8").equals(stored);
    if (isText) {
      const out = secrets ? secrets.applyMaskInText(utf8) : utf8;
      return {
        ok: true,
        body: out,
        base64Encoded: false,
        ...(truncated ? { truncated: true } : {}),
      };
    }
    return {
      ok: true,
      body: stored.toString("base64"),
      base64Encoded: true,
      ...(truncated ? { truncated: true } : {}),
    };
  }
}

/** Session-wide WebSocket/SSE ring on Playwright events — the off-Chromium twin
 *  of `WsBuffer`. `page.on('websocket')` + `ws.on('framesent'|'framereceived')`
 *  are cross-browser. Server-Sent-Events are not exposed as a discrete Playwright
 *  event (they arrive as a long-lived `eventsource` response, not WS frames), so
 *  the SSE half degrades off Chromium — documented in the per-engine matrix. */
export class PlaywrightWsBuffer {
  private ring: WsFrame[] = [];
  private enabled = false;
  private secrets: SecretRegistry | null = null;

  constructor(
    private page: Page,
    private cap = 500,
    private maxPayload = 2000,
  ) {}

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

  // eslint-disable-next-line @typescript-eslint/require-await
  async attach(): Promise<void> {
    if (this.enabled) return;
    this.enabled = true;
    this.page.on("websocket", (ws: WebSocket) => {
      const url = ws.url();
      // Playwright surfaces text frames as strings and binary frames as Buffers.
      // We only stringify; binary payloads become their utf-8 lossy form (the CDP
      // path likewise carries `payloadData` as the protocol delivered it). Opcode
      // 1 (text) / 2 (binary) is inferred from the payload runtime type.
      ws.on("framesent", (data: { payload: string | Buffer }) =>
        this.push(this.frame(url, "sent", data.payload)),
      );
      ws.on("framereceived", (data: { payload: string | Buffer }) =>
        this.push(this.frame(url, "recv", data.payload)),
      );
    });
  }

  private frame(url: string, dir: "sent" | "recv", payload: string | Buffer): WsFrame {
    const isText = typeof payload === "string";
    const text = isText ? payload : payload.toString("utf-8");
    return {
      url,
      dir,
      kind: "ws",
      opcode: isText ? 1 : 2,
      ...this.trunc(text),
      ts: Date.now(),
    };
  }

  /** Most-recent N frames, optionally filtered by a url substring. */
  recent(limit = 50, urlPattern?: string): { total: number; frames: WsFrame[] } {
    let frames = this.ring;
    if (urlPattern) frames = frames.filter((f) => f.url.includes(urlPattern));
    return {
      total: frames.length,
      frames: frames.slice(-limit).map((f) => sanitizeFrame(f, this.secrets)),
    };
  }

  /** Frames since a timestamp — for the per-action `ActionResult` slice. */
  since(ts: number, cap = 25): WsFrame[] {
    return this.ring
      .filter((f) => f.ts >= ts)
      .slice(-cap)
      .map((f) => sanitizeFrame(f, this.secrets));
  }
}
