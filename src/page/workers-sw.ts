// Service Workers transport — the CDP-side half of the Workers façade.
//
// SWs are independent CDP targets — `addInitScript` doesn't reach them, and
// the page-side wrapper of `Worker` is a no-op (SWs register via
// `navigator.serviceWorker.register`, not `new Worker`). So:
//   • Enumerate via CDP `ServiceWorker.enable` + `ServiceWorker.workerVersionUpdated`.
//   • Attach to each SW target via `Target.setAutoAttach({autoAttach:true,
//     waitForDebuggerOnStart:false, flatten:true})`, then on the attached
//     session run `Fetch.enable` with our pattern, and on `Fetch.requestPaused`
//     call `Fetch.fulfillRequest` with the canned response. The intercept fires
//     ONLY when the SW's fetch handler actually runs — i.e. the SW chose to
//     intercept this URL — which is the right semantic.
//   • For postMessage to a SW, the SW target has `Runtime.evaluate` so we
//     dispatch a `MessageEvent` into the SW global. FROM-SW messages are the
//     ones the SW posts to its clients; the page-side script
//     (`workers-page.ts`) records them from `navigator.serviceWorker`, and
//     `ingestPageMessages` moves them into the ring here.
//
// `WorkersSwChannel` owns the SW attachment map, the stable `sw-*` id index,
// the active fetch-interceptor patterns, the server-side FROM-SW ring, and the
// CDP listener detachers. The façade installs the listeners lazily on first
// call, so a session that never uses SWs pays zero CDP overhead.

import type { CDPSession } from "playwright-core";
import { globToRegex } from "./ws-interactive.js";
import type { SwFetchInterceptSpec, WorkerListing, WorkerMessage } from "./workers-types.js";

export interface SwAttachment {
  /** CDP `targetId` from `Target.attachedToTarget`. */
  targetId: string;
  /** CDP `sessionId` for the attached SW. */
  sessionId: string;
  /** Last-known scriptURL of the SW (from `ServiceWorker.workerVersionUpdated`). */
  url: string;
  /** Last-known running status (`stopped` / `starting` / `running` / `stopping`). */
  status: string;
  /** Fetch.enable applied on this SW session yet? */
  fetchEnabled: boolean;
}

interface ActiveFetchIntercept {
  pattern: string;
  regex: RegExp;
  response: SwFetchInterceptSpec["response"];
}

const SW_RING_MAX = 500;
const SW_PAYLOAD_MAX = 4000;
const SW_URL_MAX = 64;

export class WorkersSwChannel {
  /** SW attachments keyed by CDP sessionId. */
  swAttached = new Map<string, SwAttachment>();
  /** Stable monotonic id for the SW listing — `sw-1`, `sw-2`, …. Keyed by
   *  CDP sessionId so the id survives status transitions on the same SW. */
  private swIdBySession = new Map<string, string>();
  /** The same ids keyed by SW script URL. A message the page received from a SW
   *  names only that URL, and an attachment of the same URL reuses the id, so
   *  `worker_messages_read` and `workers_list` agree on which SW is `sw-N`. */
  private swIdByUrl = new Map<string, string>();
  private nextSwId = 1;
  /** Active fetch interceptors. Re-add of the same pattern replaces. */
  private fetchInterceptors = new Map<string, ActiveFetchIntercept>();
  /** Server-side ring of FROM-SW messages, filled from the page-side ring
   *  (`navigator.serviceWorker` `message` events) on each read. */
  swMessages: WorkerMessage[] = [];
  /** True once we've called `ServiceWorker.enable` + wired the auto-attach
   *  on the top-level CDP session. */
  private swEnabled = false;
  /** Detach functions for cleanup. */
  private detachers: Array<() => void> = [];

  /** Register a CDP event handler + push its detacher onto `this.detachers`.
   *  The event name is dynamic here, so the strongly-typed per-event `on`/`off`
   *  overloads are bridged through a single untyped seam. */
  private onCdp(cdp: CDPSession, event: string, handler: (e: unknown) => void): void {
    const c = cdp as unknown as {
      on: (event: string, handler: (e: unknown) => void) => void;
      off: (event: string, handler: (e: unknown) => void) => void;
    };
    c.on(event, handler);
    this.detachers.push(() => c.off(event, handler));
  }

  /** `ServiceWorker.workerVersionUpdated` — refresh url/status on the matching
   *  attachment(s). */
  private registerVersionUpdated(cdp: CDPSession): void {
    type WorkerVersionUpdated = {
      versions: Array<{
        versionId: string;
        scriptURL: string;
        runningStatus: string;
        targetId?: string;
      }>;
    };
    this.onCdp(cdp, "ServiceWorker.workerVersionUpdated", (raw) => {
      const e = raw as WorkerVersionUpdated;
      for (const v of e.versions ?? []) {
        if (!v.targetId) continue;
        for (const att of this.swAttached.values()) {
          if (att.targetId === v.targetId) {
            att.url = v.scriptURL || att.url;
            att.status = v.runningStatus || att.status;
          }
        }
      }
    });
  }

  /** `Target.attachedToTarget` / `detachedFromTarget` — track the SW attachment
   *  map, arming any already-armed fetch interceptors on a new SW. */
  private registerAttachDetach(cdp: CDPSession): void {
    type AttachedToTarget = {
      sessionId: string;
      targetInfo: { type: string; targetId: string; url: string };
    };
    this.onCdp(cdp, "Target.attachedToTarget", (raw) => {
      const e = raw as AttachedToTarget;
      if (e.targetInfo.type !== "service_worker") return;
      const att: SwAttachment = {
        targetId: e.targetInfo.targetId,
        sessionId: e.sessionId,
        url: e.targetInfo.url,
        status: "running",
        fetchEnabled: false,
      };
      this.swAttached.set(e.sessionId, att);
      this.idForSession(e.sessionId, att.url);
      if (this.fetchInterceptors.size > 0)
        void this.applyFetchEnable(cdp, att).catch(() => undefined);
    });
    this.onCdp(cdp, "Target.detachedFromTarget", (raw) => {
      const { sessionId } = raw as { sessionId: string };
      this.swAttached.delete(sessionId);
      this.swIdBySession.delete(sessionId);
    });
  }

  /** `Fetch.requestPaused` (TOP session; flatten routes child events up by
   *  `sessionId`) — fulfill against a matching interceptor, else continue. */
  private registerRequestPaused(cdp: CDPSession): void {
    type RequestPaused = {
      requestId: string;
      request: { url: string; method: string };
      sessionId?: string;
    };
    this.onCdp(cdp, "Fetch.requestPaused", (raw) => {
      void this.handleRequestPaused(cdp, raw as RequestPaused);
    });
  }

  private async handleRequestPaused(
    cdp: CDPSession,
    e: { requestId: string; request: { url: string; method: string }; sessionId?: string },
  ): Promise<void> {
    let hit: ActiveFetchIntercept | undefined;
    for (const ic of this.fetchInterceptors.values()) {
      if (ic.regex.test(e.request.url)) {
        hit = ic;
        break;
      }
    }
    if (!hit) {
      await cdp
        .send("Fetch.continueRequest", {
          requestId: e.requestId,
          ...(e.sessionId ? { sessionId: e.sessionId } : {}),
        })
        .catch(() => undefined);
      return;
    }
    const r = hit.response;
    const headers = [
      { name: "content-type", value: r.contentType ?? "application/json" },
      ...Object.entries(r.headers ?? {}).map(([name, value]) => ({ name, value })),
    ];
    await cdp
      .send("Fetch.fulfillRequest", {
        requestId: e.requestId,
        responseCode: r.status ?? 200,
        responseHeaders: headers,
        body: Buffer.from(r.body ?? "", "utf-8").toString("base64"),
        ...(e.sessionId ? { sessionId: e.sessionId } : {}),
      })
      .catch(() => undefined);
  }

  /** Enable the CDP ServiceWorker domain on the session's top-level CDP and
   *  wire `Target.setAutoAttach` so newly-registered SWs auto-attach as child
   *  sessions. Idempotent. */
  async installSwListener(cdp: CDPSession): Promise<void> {
    if (this.swEnabled) return;
    this.swEnabled = true;
    // Enumerate + monitor running versions; auto-attach for a child session per SW.
    await cdp.send("ServiceWorker.enable").catch(() => undefined);
    await cdp
      .send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      .catch(() => undefined);
    this.registerVersionUpdated(cdp);
    this.registerAttachDetach(cdp);
    this.registerRequestPaused(cdp);
  }

  private async applyFetchEnable(cdp: CDPSession, att: SwAttachment): Promise<void> {
    if (att.fetchEnabled) return;
    // CDP send routed to the child session: in flatten mode, the standard
    // CDPSession.send doesn't directly target a child session — but for our
    // workers use case Playwright doesn't expose per-child sessions through
    // the public surface. We rely on the parent CDP and the auto-attach
    // routing the Fetch events up with `sessionId` set.
    // We enable Fetch on the parent so all child Fetch events route up.
    await cdp
      .send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      })
      .catch(() => undefined);
    att.fetchEnabled = true;
  }

  // -------------------------------------------------------------------------
  // Tool surface.

  /** Stable `sw-N` id for a SW script URL. */
  private idForUrl(url: string): string {
    let id = this.swIdByUrl.get(url);
    if (!id) {
      id = `sw-${this.nextSwId++}`;
      this.swIdByUrl.set(url, id);
    }
    return id;
  }

  private idForSession(sessionId: string, url: string): string {
    let id = this.swIdBySession.get(sessionId);
    if (!id) {
      id = this.idForUrl(url);
      this.swIdBySession.set(sessionId, id);
    }
    return id;
  }

  /** Listings for the currently-attached SWs (the `sw-*` family). */
  list(): WorkerListing[] {
    const out: WorkerListing[] = [];
    for (const [sessionId, att] of this.swAttached) {
      const id = this.idForSession(sessionId, att.url);
      out.push({ workerId: id, type: "service", url: att.url, state: att.status });
    }
    return out;
  }

  /** Dispatch a `MessageEvent` into the matching SW global via `Runtime.evaluate`. */
  async sendMessage(
    cdp: CDPSession,
    args: { workerId: string; message: string },
  ): Promise<{ ok: boolean; workerId: string; error?: string }> {
    await this.installSwListener(cdp);
    // Find the SW attachment for this id.
    const sessionId = [...this.swIdBySession].find(([, id]) => id === args.workerId)?.[0];
    if (!sessionId)
      return {
        ok: false,
        workerId: args.workerId,
        error: `no service worker with id ${args.workerId}`,
      };
    // Dispatch a MessageEvent into the SW global by running JS in the SW
    // context. Playwright doesn't surface child-session sends as a public
    // API; we use the parent CDP's Runtime.evaluate routed via the
    // sessionId field (flatten mode).
    const payload = JSON.stringify(args.message);
    const sendOpts: { expression: string; returnByValue: boolean } = {
      expression: `self.dispatchEvent(new MessageEvent('message', { data: ${payload} })); true;`,
      returnByValue: true,
    };
    try {
      // `sessionId` is a flatten-mode routing field absent from the generated
      // `evaluateParameters` type; spread it the same way the Fetch handlers
      // above do so the literal isn't excess-property-checked.
      await cdp.send("Runtime.evaluate", { ...sendOpts, ...(sessionId ? { sessionId } : {}) });
      return { ok: true, workerId: args.workerId };
    } catch (err) {
      return {
        ok: false,
        workerId: args.workerId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Drain the server-side FROM-SW ring (optionally filtered to one `sw-*` id). */
  drainMessages(workerId?: string): WorkerMessage[] {
    const matching: WorkerMessage[] = [];
    const remaining: WorkerMessage[] = [];
    for (const m of this.swMessages) {
      if (!workerId || m.workerId === workerId) matching.push(m);
      else remaining.push(m);
    }
    this.swMessages = remaining;
    return matching;
  }

  async addFetchIntercept(
    cdp: CDPSession,
    spec: SwFetchInterceptSpec,
  ): Promise<{ key: string; active: string[] }> {
    await this.installSwListener(cdp);
    const key = spec.pattern;
    this.fetchInterceptors.set(key, {
      pattern: key,
      regex: globToRegex(key),
      response: spec.response,
    });
    // Enable Fetch on every currently-attached SW (and on the parent — we
    // need the parent Fetch.enable so child Fetch events route up).
    await cdp
      .send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      })
      .catch(() => undefined);
    for (const att of this.swAttached.values()) {
      await this.applyFetchEnable(cdp, att).catch(() => undefined);
    }
    return { key, active: this.listFetchIntercepts() };
  }

  async removeFetchIntercept(
    cdp: CDPSession,
    sel: { pattern?: string },
  ): Promise<{ removed: string[]; active: string[] }> {
    await this.installSwListener(cdp);
    let removed: string[];
    if (sel.pattern === undefined) {
      removed = [...this.fetchInterceptors.keys()];
      this.fetchInterceptors.clear();
    } else if (this.fetchInterceptors.has(sel.pattern)) {
      removed = [sel.pattern];
      this.fetchInterceptors.delete(sel.pattern);
    } else {
      removed = [];
    }
    if (this.fetchInterceptors.size === 0) {
      // Disable Fetch so we don't pause every request for no reason.
      await cdp.send("Fetch.disable").catch(() => undefined);
      for (const att of this.swAttached.values()) att.fetchEnabled = false;
    }
    return { removed, active: this.listFetchIntercepts() };
  }

  listFetchIntercepts(): string[] {
    return [...this.fetchInterceptors.keys()];
  }

  /** Append a FROM-SW message to the server-side ring. */
  recordSwMessage(workerId: string, data: string, at: number = Date.now()): void {
    let trimmed = data;
    if (trimmed.length > SW_PAYLOAD_MAX) trimmed = trimmed.slice(0, SW_PAYLOAD_MAX) + "…";
    this.swMessages.push({ workerId, data: trimmed, at });
    if (this.swMessages.length > SW_RING_MAX) {
      this.swMessages.splice(0, this.swMessages.length - SW_RING_MAX);
    }
  }

  /** Take the messages the page-side ring drained (`{url, data, at}` per
   *  message) into the server ring, under the `sw-N` id of the posting SW's
   *  script URL. The page owns that ring and can return anything, so the input
   *  is untyped: only the last `SW_RING_MAX` well-formed entries are kept, and
   *  every field is coerced and bounded. */
  ingestPageMessages(drained: unknown): void {
    if (!Array.isArray(drained)) return;
    for (const m of drained.slice(-SW_RING_MAX)) {
      if (typeof m !== "object" || m === null) continue;
      const { url, data, at } = m as { url?: unknown; data?: unknown; at?: unknown };
      const scriptUrl = typeof url === "string" ? url.slice(0, 2048) : "";
      // A page can name any URL it likes; past SW_URL_MAX distinct ones the
      // unknown URLs are dropped so the id index stays bounded.
      if (!this.swIdByUrl.has(scriptUrl) && this.swIdByUrl.size >= SW_URL_MAX) continue;
      this.recordSwMessage(
        this.idForUrl(scriptUrl),
        typeof data === "string" ? data : "",
        typeof at === "number" && Number.isFinite(at) ? at : Date.now(),
      );
    }
  }

  /** Release all CDP listeners. Called from the session teardown. */
  dispose(): void {
    for (const off of this.detachers) {
      try {
        off();
      } catch {
        /* tolerate */
      }
    }
    this.detachers = [];
  }
}
