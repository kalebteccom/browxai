// Web Workers + Service Workers visibility — capability `read` for listing
// and reading messages; `action` for sending messages and registering fetch
// interceptors. Sibling of `ws-interactive.ts` on the worker channel.
//
//   • `workers_list({type})`             — enumerate live workers (Web + SW).
//   • `worker_message_send({workerId, message})` — `postMessage` to a worker.
//   • `worker_messages_read({workerId?})` — drain the FROM-worker ring.
//   • `sw_intercept_fetch({pattern, response})` — fulfil a SW-handled fetch.
//
// Two completely different transport stories under one façade, split into two
// siblings along that exact seam:
//
//   • `workers-page.ts` — the page-side Web-Worker wrapper (`__browxWorkers`
//     installed via `Page.addInitScript`; CDP can't `postMessage` a worker we
//     didn't construct, so the IPC + message ring live in-page).
//   • `workers-sw.ts`   — the CDP ServiceWorker attach + Fetch-intercept path
//     (SWs are independent CDP targets `addInitScript` can't reach).
//
// This file keeps the shared DOMAIN types (re-exported from `workers-types.ts`)
// and a thin `WorkersRegistry` façade that owns one channel of each kind and
// routes each primitive to the half that owns it. Both primitives lazily
// install their channel on first call, so a session that never uses workers
// pays zero overhead.

import type { CDPSession, Page } from "playwright-core";
import { WORKERS_PAGE_SCRIPT, WorkersPageChannel } from "./workers-page.js";
import { WorkersSwChannel } from "./workers-sw.js";
import type {
  WorkerFilter,
  WorkerListing,
  WorkerMessage,
  SwFetchInterceptSpec,
} from "./workers-types.js";

export { WORKERS_PAGE_SCRIPT };
export type { SwAttachment } from "./workers-sw.js";
export type {
  WorkerType,
  WorkerFilter,
  WorkerListing,
  WorkerMessage,
  SwFetchInterceptSpec,
} from "./workers-types.js";

// ---------------------------------------------------------------------------
// Per-session façade. Composes the page-side Web-Worker channel and the
// CDP-side Service-Worker channel; each tool primitive dispatches by the
// `ww-*` / `sw-*` id prefix to the channel that owns the transport.

export class WorkersRegistry {
  private page = new WorkersPageChannel();
  private sw = new WorkersSwChannel();

  /** SW attachments keyed by CDP sessionId — surfaced for the SW listing path
   *  and for tests that seed attachments directly. */
  get swAttached() {
    return this.sw.swAttached;
  }
  /** Server-side ring of FROM-SW messages — surfaced for the drain path and
   *  for tests asserting payload trimming. */
  get swMessages(): WorkerMessage[] {
    return this.sw.swMessages;
  }

  /** Install the page-side `Worker` wrapper. Idempotent. Called eagerly at
   *  session creation (under capability `read`) so workers opened by the
   *  initial document are seen — same posture as `WsInteractiveRegistry`. */
  async installPageWrapper(page: Page): Promise<void> {
    await this.page.installPageWrapper(page);
  }

  /** Enable the CDP ServiceWorker domain on the session's top-level CDP and
   *  wire `Target.setAutoAttach` so newly-registered SWs auto-attach as child
   *  sessions. Idempotent. */
  async installSwListener(cdp: CDPSession): Promise<void> {
    await this.sw.installSwListener(cdp);
  }

  // -------------------------------------------------------------------------
  // Tool surface.

  async list(page: Page, cdp: CDPSession, filter: WorkerFilter = "all"): Promise<WorkerListing[]> {
    await this.installPageWrapper(page);
    await this.installSwListener(cdp);
    const out: WorkerListing[] = [];
    if (filter === "all" || filter === "web") {
      out.push(...(await this.page.list(page)));
    }
    if (filter === "all" || filter === "service") {
      out.push(...this.sw.list());
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
      return this.page.post(page, args.workerId, args.message);
    }
    if (args.workerId.startsWith("sw-")) {
      return this.sw.sendMessage(cdp, args);
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
      out.push(...(await this.page.drain(page, args.workerId)));
    }
    // Service Worker messages — drain from the server-side ring.
    if (!args.workerId || args.workerId.startsWith("sw-")) {
      out.push(...this.sw.drainMessages(args.workerId));
    }
    return out;
  }

  async addFetchIntercept(
    cdp: CDPSession,
    spec: SwFetchInterceptSpec,
  ): Promise<{ key: string; active: string[] }> {
    return this.sw.addFetchIntercept(cdp, spec);
  }

  async removeFetchIntercept(
    cdp: CDPSession,
    sel: { pattern?: string },
  ): Promise<{ removed: string[]; active: string[] }> {
    return this.sw.removeFetchIntercept(cdp, sel);
  }

  listFetchIntercepts(): string[] {
    return this.sw.listFetchIntercepts();
  }

  /** Append a FROM-SW message to the server-side ring. Currently unused by
   *  the production path (the SW side message-relay is left as a future
   *  follow-up — see report); kept for symmetry + future use. */
  recordSwMessage(workerId: string, data: string): void {
    this.sw.recordSwMessage(workerId, data);
  }

  /** Release all CDP listeners. Called from the session teardown. */
  dispose(): void {
    this.sw.dispose();
  }
}
