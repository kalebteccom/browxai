// CDP network tap for an "action window" — open before dispatch, close after
// network-idle-ish quiet. Filters out the high-noise/low-signal resource types by
// default (images, fonts, stylesheets, media, beacons); they're still counted in
// the summary's `byType.other` bucket if you want the totals back.
//
// The CDP-bound adapter half of the network slice: these classes/functions read
// Chromium's `Network.*` domain directly. The engine-blind domain shapes + folds
// they emit (NetworkEntry/NetworkSummary/MutationEntry, `foldInteresting`, the
// url-pattern / response-shape helpers) live in the `network-types.ts` leaf, so
// the off-Chromium Playwright twin produces byte-identical egress without a cycle.

import type { CDPSession } from "playwright-core";
import { invariant } from "../util/invariant.js";
import type { SecretRegistry } from "../util/secrets.js";
import {
  type MutationDetail,
  type MutationEntry,
  type NetworkEntry,
  type NetworkSummary,
  extractTopLevelKeys,
  foldInteresting,
  mutationWithoutShape,
  mutationWithShape,
  MAX_BODY_BYTES_TO_PARSE,
  MUTATION_METHODS,
} from "./network-types.js";

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
  ) {
    // L7/L8: the ring cap is the bound that keeps the buffer from growing without
    // limit (the audit's bounded-resource inventory pins it at 500). A
    // non-positive cap would break `push`'s eviction (the ring could never retain
    // an entry, or `shift()` would underflow), so the bound MUST be positive. The
    // default is 500 and the only caller passes nothing, so this holds; the
    // invariant makes the bound's positivity an asserted contract, not an
    // assumption.
    invariant(this.cap > 0, `NetworkBuffer ring cap must be positive, got ${this.cap}`);
  }

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
    // L7: the ring is bounded — one push evicts at most one entry, so the length
    // is `<= cap` after every push. This is the bounded-buffer property the
    // network surface depends on; asserting it post-eviction makes "the ring
    // never exceeds its cap" a tested invariant rather than a comment.
    invariant(
      this.ring.length <= this.cap,
      `NetworkBuffer ring exceeded cap (${this.ring.length} > ${this.cap})`,
    );
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
