// Web Workers transport — the page-side half of the Workers façade.
//
// No CDP primitive lets us call `postMessage` on a worker we didn't construct.
// So we install a page-side wrapper of `window.Worker` at document-start
// (`Page.addInitScript`) — same shape as `ws-interactive.ts`'s `__browxWs`.
// The wrapper:
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
// `WorkersPageChannel` owns the install-once latch and the `page.evaluate`
// bridges. It is engine-blind beyond the `Page` handle: all state lives on the
// page, so there is nothing to dispose here.

import type { Page } from "playwright-core";
import type { WorkerListing, WorkerMessage } from "./workers-types.js";

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
// Page-side API installed by `WORKERS_PAGE_SCRIPT` on the page's global.

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

// ---------------------------------------------------------------------------
// Per-session channel. Owns the page-side wrapper installation and the
// `page.evaluate` bridges for the `ww-*` worker family.

export class WorkersPageChannel {
  /** True once the page-side wrapper has been installed. */
  private installed = false;

  /** Install the page-side `Worker` wrapper. Idempotent. Called eagerly at
   *  session creation (under capability `read`) so workers opened by the
   *  initial document are seen — same posture as `WsInteractiveRegistry`. */
  async installPageWrapper(page: Page): Promise<void> {
    if (this.installed) return;
    this.installed = true;
    await page.context().addInitScript({ content: WORKERS_PAGE_SCRIPT });
    // re-inject for the current document — addInitScript only fires on
    // future navigations.
    for (const p of page.context().pages()) {
      await p.evaluate(WORKERS_PAGE_SCRIPT).catch(() => undefined);
    }
  }

  /** Enumerate the live Web Workers via the page-side `__browxWorkers.list()`. */
  async list(page: Page): Promise<WorkerListing[]> {
    const out: WorkerListing[] = [];
    try {
      const ws = await page.evaluate(() => {
        const w = globalThis.__browxWorkers;
        return w ? w.list() : [];
      });
      for (const e of ws) out.push({ workerId: e.workerId, type: "web", url: e.url });
    } catch {
      /* page navigation race — empty is fine */
    }
    return out;
  }

  /** `postMessage` to a `ww-*` worker via the page-side `__browxWorkers.post`. */
  async post(
    page: Page,
    workerId: string,
    message: string,
  ): Promise<{ ok: boolean; workerId: string; error?: string }> {
    const r = await page.evaluate(
      ({ id, msg }) => {
        const w = globalThis.__browxWorkers;
        if (!w) return { ok: false, error: "__browxWorkers not installed (init-script race?)" };
        return w.post(id, msg);
      },
      { id: workerId, msg: message },
    );
    return { ...r, workerId };
  }

  /** Drain the page-side ring of FROM-worker messages. */
  async drain(page: Page, workerId?: string): Promise<WorkerMessage[]> {
    const out: WorkerMessage[] = [];
    try {
      const drained = await page.evaluate(
        ({ id }) => {
          const w = globalThis.__browxWorkers;
          if (!w) return [];
          return w.drain(id ?? undefined);
        },
        { id: workerId ?? null },
      );
      for (const m of drained) out.push({ workerId: m.workerId, data: m.data, at: m.at });
    } catch {
      /* race — empty is fine */
    }
    return out;
  }
}
