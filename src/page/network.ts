// CDP network tap for an "action window" — open before dispatch, close after
// network-idle-ish quiet. Filters out the high-noise/low-signal resource types by
// default (images, fonts, stylesheets, media, beacons); they're still counted in
// the summary's `byType.other` bucket if you want the totals back.

import type { CDPSession } from "playwright-core";

export interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
  type: string;
  ms?: number;
  failed?: boolean;
}

export interface NetworkSummary {
  total: number;
  byType: Record<string, number>;
  failed: number;
}

const NOISE_TYPES = new Set(["Image", "Font", "Stylesheet", "Media", "Manifest"]);
const BEACON_HINTS = ["beacon", "/collect", "analytics", "gtag", "doubleclick", "pixel"];

function isBeacon(url: string): boolean {
  const lower = url.toLowerCase();
  return BEACON_HINTS.some((h) => lower.includes(h));
}

export class NetworkTap {
  private requests = new Map<string, { method: string; url: string; type: string; startedAt: number }>();
  private finished: NetworkEntry[] = [];
  private listeners: Array<() => void> = [];
  private enabled = false;

  constructor(private cdp: CDPSession) {}

  async open(): Promise<void> {
    if (!this.enabled) {
      await this.cdp.send("Network.enable");
      this.enabled = true;
    }
    this.requests.clear();
    this.finished = [];

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
      this.finished.push({
        method: r.method,
        url: r.url,
        status: e.response.status,
        type: r.type,
        ms: Date.now() - r.startedAt,
      });
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
   * Stop listening and produce a `{ summary, requests }` snapshot of the window.
   * `requests` only includes the "interesting" entries (non-noise, non-beacon).
   * Noise still counts toward `summary.byType.other`.
   */
  close(): { summary: NetworkSummary; requests: NetworkEntry[] } {
    for (const off of this.listeners) off();
    this.listeners = [];
    const summary: NetworkSummary = { total: this.finished.length, byType: {}, failed: 0 };
    const interesting: NetworkEntry[] = [];
    for (const e of this.finished) {
      let bucket = e.type;
      if (NOISE_TYPES.has(e.type) || isBeacon(e.url)) bucket = "other";
      summary.byType[bucket] = (summary.byType[bucket] ?? 0) + 1;
      if (e.failed) summary.failed += 1;
      if (bucket !== "other") interesting.push(e);
    }
    return { summary, requests: interesting };
  }
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

  constructor(private cdp: CDPSession, private cap = 500) {}

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
      this.push({ method: r.method, url: r.url, status: e.response.status, type: r.type, ms: Date.now() - r.startedAt });
      this.requests.delete(e.requestId);
    });
    this.cdp.on("Network.loadingFailed", (e: { requestId: string }) => {
      const r = this.requests.get(e.requestId);
      if (!r) return;
      this.push({ method: r.method, url: r.url, type: r.type, failed: true, ms: Date.now() - r.startedAt });
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
      if (bucket !== "other") interesting.push(e);
    }
    return { summary, requests: interesting };
  }
}
