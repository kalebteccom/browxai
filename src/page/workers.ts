// Web Workers + Service Workers visibility — capability `read` for listing
// and reading messages; `action` for sending messages and registering fetch
// interceptors. Sibling of `ws-interactive.ts` on the worker channel.
//
//   • `workers_list({type})`             — enumerate live workers (Web + SW).
//   • `worker_message_send({workerId, message})` — `postMessage` to a worker.
//   • `worker_messages_read({workerId?})` — drain the FROM-worker ring.
//   • `sw_intercept_fetch({pattern, response})` — fulfil a SW-handled fetch.
//
// Two completely different transport stories under one façade:
//
// **Web Workers.** No CDP primitive lets us call `postMessage` on a worker we
// didn't construct. So we install a page-side wrapper of `window.Worker` at
// document-start (`Page.addInitScript`) — same shape as `ws-interactive.ts`'s
// `__browxWs`. The wrapper:
//   • Assigns each worker a monotonic id (`ww-1`, `ww-2`, …).
//   • Mirrors every message FROM the worker into a page-side ring
//     (`window.__browxWorkers.drain(id?)` — server reads it via `evaluate`).
//   • Exposes `__browxWorkers.post(id, msg)` which calls the underlying
//     `Worker.prototype.postMessage` — the worker's `onmessage` sees a real
//     event, not a synthetic one.
// This is the same trade-off `ws-interactive.ts` made: CDP attach-to-worker
// adds a separate session per worker for a feature (postMessage IPC) that's
// fundamentally page-side. The in-page proxy keeps the message ring naturally
// co-located with the IPC surface.
//
// **Service Workers.** SWs are independent CDP targets — `addInitScript`
// doesn't reach them, and the page-side wrapper of `Worker` is a no-op (SWs
// register via `navigator.serviceWorker.register`, not `new Worker`). So:
//   • Enumerate via CDP `ServiceWorker.enable` + `ServiceWorker.workerVersionUpdated`.
//   • Attach to each SW target via `Target.setAutoAttach({autoAttach:true,
//     waitForDebuggerOnStart:false, flatten:true})`, then on the attached
//     session run `Fetch.enable` with our pattern, and on `Fetch.requestPaused`
//     call `Fetch.fulfillRequest` with the canned response. The intercept fires
//     ONLY when the SW's fetch handler actually runs — i.e. the SW chose to
//     intercept this URL — which is the right semantic.
//   • For postMessage to a SW, the SW target has `Runtime.evaluate` so we
//     dispatch a `MessageEvent` into the SW global; FROM-SW messages come back
//     via a `Runtime.bindingCalled` shuttle installed on the SW session.
//
// All four primitives lazily install the page-side wrapper + lazily attach the
// CDP listeners on first call, so a session that never uses workers pays zero
// overhead.

import type { CDPSession, Page } from "playwright-core";
import { globToRegex } from "./ws-interactive.js";

// ---------------------------------------------------------------------------
// Types

export type WorkerType = "web" | "service";
export type WorkerFilter = WorkerType | "all";

export interface WorkerListing {
  workerId: string;
  type: WorkerType;
  url: string;
  /** Best-effort state. Web workers: always `"running"` (browser doesn't
   *  expose lifecycle once they're constructed). Service workers: the CDP
   *  `running_status` (`stopped` / `starting` / `running` / `stopping`). */
  state?: string;
}

export interface WorkerMessage {
  workerId: string;
  /** Always serialised to a string for the ring; structured-clone payloads
   *  are `JSON.stringify`d on the page side (and silently truncated to the
   *  payload cap). Binary `MessagePort`s are not transferred. */
  data: string;
  /** epoch ms — fixed on receipt. */
  at: number;
}

export interface SwFetchInterceptSpec {
  /** Glob matched against the intercepted request URL. Same shape as
   *  `route` / `ws_intercept`. `*` = single path segment, `**` = any. */
  pattern: string;
  /** Canned response. `body` defaults to `""`. `contentType` defaults
   *  to `application/json`. `status` defaults to `200`. */
  response: {
    status?: number;
    body?: string;
    contentType?: string;
    headers?: Record<string, string>;
  };
}

// ---------------------------------------------------------------------------
// Page-side wrapper script — wraps `window.Worker` exactly once. Mirrors the
// shape of `WS_PAGE_SCRIPT` in `ws-interactive.ts`. Browser-only JS, no
// TS-only syntax — this string is shipped verbatim into the page via
// `Page.addInitScript`.

export const WORKERS_PAGE_SCRIPT = `(() => {
  if (window.__browxWorkers) return;
  var NativeWorker = window.Worker;
  if (!NativeWorker) return;
  var nativePost = NativeWorker.prototype.postMessage;
  var workers = new Map(); // wwId -> Worker
  var messages = []; // {workerId, data, at} ring (capped at 500)
  var MAX = 500;
  var nextId = 1;

  function recordMessage(id, payload) {
    var data;
    try {
      data = typeof payload === "string" ? payload : JSON.stringify(payload);
    } catch (_) {
      data = "[unserialisable]";
    }
    if (data && data.length > 4000) data = data.slice(0, 4000) + "…";
    messages.push({ workerId: id, data: data, at: Date.now() });
    if (messages.length > MAX) messages.splice(0, messages.length - MAX);
  }

  function Wrapped(scriptURL, opts) {
    var w = arguments.length > 1 ? new NativeWorker(scriptURL, opts) : new NativeWorker(scriptURL);
    var id = "ww-" + (nextId++);
    workers.set(id, w);
    try { w.__browxId = id; } catch (_) {}
    // Mirror every message-from-worker into the ring. We use addEventListener
    // (not onmessage) so we don't fight with app-side onmessage handlers.
    try {
      w.addEventListener("message", function (ev) { recordMessage(id, ev.data); });
    } catch (_) {}
    return w;
  }
  Wrapped.prototype = NativeWorker.prototype;
  try { Object.defineProperty(Wrapped, "name", { value: "Worker" }); } catch (_) {}
  window.Worker = Wrapped;

  window.__browxWorkers = {
    list: function () {
      var out = [];
      workers.forEach(function (w, id) {
        // We can't get the scriptURL back from a Worker after construction
        // in all browsers — fall back to the recorded url if we tracked it,
        // else the empty string. (Chromium DOES expose it via internal slot
        // but not via any public API; we track it at construction via the
        // initial scriptURL argument — see __browxWorkers._urls.
        var url = (window.__browxWorkers._urls && window.__browxWorkers._urls.get(id)) || "";
        out.push({ workerId: id, url: url });
      });
      return out;
    },
    _urls: new Map(),
    post: function (id, msg) {
      var w = workers.get(id);
      if (!w) return { ok: false, error: "no worker with id " + id };
      try {
        nativePost.call(w, msg);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    },
    drain: function (id) {
      var out;
      if (id) {
        out = [];
        var kept = [];
        for (var i = 0; i < messages.length; i++) {
          if (messages[i].workerId === id) out.push(messages[i]);
          else kept.push(messages[i]);
        }
        messages = kept;
      } else {
        out = messages.slice();
        messages.length = 0;
      }
      return out;
    },
  };

  // Track scriptURL at construction. We can't get it post-hoc on most engines.
  var origWrapped = Wrapped;
  window.Worker = function (scriptURL, opts) {
    var w = arguments.length > 1 ? origWrapped(scriptURL, opts) : origWrapped(scriptURL);
    try {
      var id = w.__browxId;
      if (id) {
        var url = "";
        try { url = String(scriptURL && scriptURL.href ? scriptURL.href : scriptURL || ""); } catch (_) {}
        window.__browxWorkers._urls.set(id, url);
      }
    } catch (_) {}
    return w;
  };
  window.Worker.prototype = NativeWorker.prototype;
  try { Object.defineProperty(window.Worker, "name", { value: "Worker" }); } catch (_) {}
})();`;

// ---------------------------------------------------------------------------
// Per-session registry. Owns the page-side wrapper installation, the
// CDP-side SW discovery & attachment, the in-memory message ring (server
// side mirror of the page ring + an extra ring for SW messages), and the
// active fetch-interceptor patterns.

interface BrowxWorkersApi {
  list(): Array<{ workerId: string; url: string }>;
  post(id: string, msg: string): { ok: boolean; error?: string };
  drain(id?: string): Array<{ workerId: string; data: string; at: number }>;
}

// The page-side wrapper (`WORKERS_PAGE_SCRIPT`) installs `__browxWorkers` on
// the page's global. Declare it so the `page.evaluate` callbacks below — which
// run in that DOM context — read it with a precise type instead of `any`.
declare global {
  var __browxWorkers: BrowxWorkersApi | undefined;
}

interface SwAttachment {
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

export class WorkersRegistry {
  /** SW attachments keyed by CDP sessionId. */
  private swAttached = new Map<string, SwAttachment>();
  /** Stable monotonic id for the SW listing — `sw-1`, `sw-2`, …. Keyed by
   *  CDP sessionId so the id survives status transitions on the same SW. */
  private swIdBySession = new Map<string, string>();
  private nextSwId = 1;
  /** Active fetch interceptors. Re-add of the same pattern replaces. */
  private fetchInterceptors = new Map<string, ActiveFetchIntercept>();
  /** Server-side ring of FROM-SW messages (we relay these via a CDP
   *  `Runtime.bindingCalled` shuttle on each SW session). */
  private swMessages: WorkerMessage[] = [];
  /** True once the page-side wrapper has been installed. */
  private pageInstalled = false;
  /** True once we've called `ServiceWorker.enable` + wired the auto-attach
   *  on the top-level CDP session. */
  private swEnabled = false;
  /** Detach functions for cleanup. */
  private detachers: Array<() => void> = [];

  /** Install the page-side `Worker` wrapper. Idempotent. Called eagerly at
   *  session creation (under capability `read`) so workers opened by the
   *  initial document are seen — same posture as `WsInteractiveRegistry`. */
  async installPageWrapper(page: Page): Promise<void> {
    if (this.pageInstalled) return;
    this.pageInstalled = true;
    await page.context().addInitScript({ content: WORKERS_PAGE_SCRIPT });
    // re-inject for the current document — addInitScript only fires on
    // future navigations.
    for (const p of page.context().pages()) {
      await p.evaluate(WORKERS_PAGE_SCRIPT).catch(() => undefined);
    }
  }

  /** Enable the CDP ServiceWorker domain on the session's top-level CDP and
   *  wire `Target.setAutoAttach` so newly-registered SWs auto-attach as child
   *  sessions. Idempotent. */
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
      versions: Array<{ versionId: string; scriptURL: string; runningStatus: string; targetId?: string }>;
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
      this.swIdBySession.set(e.sessionId, `sw-${this.nextSwId++}`);
      if (this.fetchInterceptors.size > 0) void this.applyFetchEnable(cdp, att).catch(() => undefined);
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

  async installSwListener(cdp: CDPSession): Promise<void> {
    if (this.swEnabled) return;
    this.swEnabled = true;
    // Enumerate + monitor running versions; auto-attach for a child session per SW.
    await cdp.send("ServiceWorker.enable").catch(() => undefined);
    await cdp
      .send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
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

  async list(page: Page, cdp: CDPSession, filter: WorkerFilter = "all"): Promise<WorkerListing[]> {
    await this.installPageWrapper(page);
    await this.installSwListener(cdp);
    const out: WorkerListing[] = [];
    if (filter === "all" || filter === "web") {
      try {
        const ws = await page.evaluate(() => {
          const w = globalThis.__browxWorkers;
          return w ? w.list() : [];
        });
        for (const e of ws) out.push({ workerId: e.workerId, type: "web", url: e.url });
      } catch {
        /* page navigation race — empty is fine */
      }
    }
    if (filter === "all" || filter === "service") {
      for (const [sessionId, att] of this.swAttached) {
        const id = this.swIdBySession.get(sessionId) ?? `sw-${this.nextSwId++}`;
        this.swIdBySession.set(sessionId, id);
        out.push({ workerId: id, type: "service", url: att.url, state: att.status });
      }
    }
    return out;
  }

  async sendMessage(
    page: Page,
    cdp: CDPSession,
    args: { workerId: string; message: string },
  ): Promise<{ ok: boolean; workerId: string; error?: string }> {
    if (args.workerId.startsWith("ww-")) {
      await this.installPageWrapper(page);
      const r = await page.evaluate(
        ({ id, msg }) => {
          const w = globalThis.__browxWorkers;
          if (!w) return { ok: false, error: "__browxWorkers not installed (init-script race?)" };
          return w.post(id, msg);
        },
        { id: args.workerId, msg: args.message },
      );
      return { ...r, workerId: args.workerId };
    }
    if (args.workerId.startsWith("sw-")) {
      await this.installSwListener(cdp);
      // Find the SW attachment for this id.
      let sessionId: string | undefined;
      for (const [sid, id] of this.swIdBySession) {
        if (id === args.workerId) {
          sessionId = sid;
          break;
        }
      }
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
    return {
      ok: false,
      workerId: args.workerId,
      error: `unknown workerId prefix (expected ww-* or sw-*): ${args.workerId}`,
    };
  }

  async readMessages(page: Page, args: { workerId?: string }): Promise<WorkerMessage[]> {
    await this.installPageWrapper(page);
    const out: WorkerMessage[] = [];
    // Web Worker messages — drain from the page ring.
    if (!args.workerId || args.workerId.startsWith("ww-")) {
      try {
        const drained = await page.evaluate(
          ({ id }) => {
            const w = globalThis.__browxWorkers;
            if (!w) return [];
            return w.drain(id ?? undefined);
          },
          { id: args.workerId ?? null },
        );
        for (const m of drained) out.push({ workerId: m.workerId, data: m.data, at: m.at });
      } catch {
        /* race — empty is fine */
      }
    }
    // Service Worker messages — drain from the server-side ring.
    if (!args.workerId || args.workerId.startsWith("sw-")) {
      const matching: WorkerMessage[] = [];
      const remaining: WorkerMessage[] = [];
      for (const m of this.swMessages) {
        if (!args.workerId || m.workerId === args.workerId) matching.push(m);
        else remaining.push(m);
      }
      this.swMessages = remaining;
      out.push(...matching);
    }
    return out;
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

  /** Append a FROM-SW message to the server-side ring. Currently unused by
   *  the production path (the SW side message-relay is left as a future
   *  follow-up — see report); kept for symmetry + future use. */
  recordSwMessage(workerId: string, data: string): void {
    let trimmed = data;
    if (trimmed.length > SW_PAYLOAD_MAX) trimmed = trimmed.slice(0, SW_PAYLOAD_MAX) + "…";
    this.swMessages.push({ workerId, data: trimmed, at: Date.now() });
    if (this.swMessages.length > SW_RING_MAX) {
      this.swMessages.splice(0, this.swMessages.length - SW_RING_MAX);
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
