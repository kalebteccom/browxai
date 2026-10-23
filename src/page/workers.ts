// Web Workers + Service Workers visibility — capability `read` for listing
// and reading messages; `action` for sending messages and registering fetch
// interceptors. Sibling of `ws-interactive.ts` on the worker channel.
//
//   • `workers_list({type})`             — enumerate live workers (Web + SW).
//   • `worker_message_send({workerId, message})` — `postMessage` to a worker.
//   • `worker_messages_read({workerId?})` — drain the FROM-worker rings (Web
//     Workers, and Service Workers via `navigator.serviceWorker` messages).
//   • `sw_intercept_fetch({pattern, response})` — fulfil a SW-handled fetch.
//
// Two completely different transport stories under one façade, split into two
// siblings along that exact seam:
//
//   • `workers-page.ts` — the page-side Web-Worker wrapper (`__browxWorkers`
//     installed via `Page.addInitScript`; CDP can't `postMessage` a worker we
//     didn't construct, so the IPC + message ring live in-page).
//   • `workers-sw.ts`   — Service Workers: Playwright's `context.serviceWorkers()`
//     for listing and `postMessage`, and the CDP attach + Fetch-intercept path
//     (SWs are independent targets `addInitScript` can't reach).
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
  ServiceWorkerAccess,
  WorkerFilter,
  WorkerListing,
  WorkerMessage,
  SwFetchInterceptSpec,
} from "./workers-types.js";

export { WORKERS_PAGE_SCRIPT };
export type { SwAttachment } from "./workers-sw.js";
export type {
  WorkerType,
  ServiceWorkerAccess,
  WorkerFilter,
  WorkerListing,
  WorkerMessage,
  SwFetchInterceptSpec,
} from "./workers-types.js";

// ---------------------------------------------------------------------------
// Per-session façade. Composes the page-side Web-Worker channel and the
// Service-Worker channel; each tool primitive dispatches by the `ww-*` / `sw-*`
// id prefix to the channel that owns the transport.

/** The refusal text for a `sw-*` operation on an engine Playwright can't reach
 *  service workers on. */
function swRefusal(sw: ServiceWorkerAccess): string {
  return (
    `service workers are not reachable on the "${sw.engine}" engine: Playwright exposes them ` +
    "(context.serviceWorkers()) on Chromium-based engines only. Use a chromium session."
  );
}

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

  async list(
    page: Page,
    sw: ServiceWorkerAccess,
    filter: WorkerFilter = "all",
  ): Promise<WorkerListing[]> {
    // Only a `service` listing is refused: an `all` listing on an engine without
    // service workers still answers for the Web Workers it can see.
    if (filter === "service" && !sw.supported) throw new Error(swRefusal(sw));
    await this.installPageWrapper(page);
    const out: WorkerListing[] = [];
    if (filter === "all" || filter === "web") {
      out.push(...(await this.page.list(page)));
    }
    if ((filter === "all" || filter === "service") && sw.supported) {
      out.push(...this.sw.list(page.context()));
    }
    return out;
  }

  async sendMessage(
    page: Page,
    sw: ServiceWorkerAccess,
    args: { workerId: string; message: string },
  ): Promise<{ ok: boolean; workerId: string; error?: string }> {
    if (args.workerId.startsWith("ww-")) {
      await this.installPageWrapper(page);
      return this.page.post(page, args.workerId, args.message);
    }
    if (args.workerId.startsWith("sw-")) {
      if (!sw.supported) return { ok: false, workerId: args.workerId, error: swRefusal(sw) };
      return this.sw.sendMessage(page.context(), args);
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
    // Service Worker messages — move what the page received into the
    // server-side ring, then drain that.
    if (!args.workerId || args.workerId.startsWith("sw-")) {
      this.sw.ingestPageMessages(await this.page.drainSw(page));
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

  /** Release all CDP listeners. Called from the session teardown. */
  dispose(): void {
    this.sw.dispose();
  }
}
