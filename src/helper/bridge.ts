// Server-side `__browx` bridge. Wires the in-page script + the `__browx_send`
// CDP binding, queues signals, and exposes `awaitSignal(name, timeout)` that
// resolves on the next matching `__browx.signal()` / `proceed()` / `abort()` /
// `done()` call from the page.
//
// Phase-1 scope:
//   ✓ signal queue + awaitSignal (the site-docs `manual-capture` use case is
//     `awaitHuman({kind:"acknowledge"})` → human calls `__browx.proceed()` →
//     server unblocks).
//   ✓ DOM-attribute-polling fallback for environments where `exposeBinding`
//     gets clobbered (BYOB multi-attach — Playwright #34359).
//   ✗ Shadow-DOM banner UI; `confirm` / `choose` / `input` / `pick_element`
//     kinds — Phase-1.5 polish.

import type { BrowserContext, Page } from "playwright-core";
import { BROWX_PAGE_SCRIPT } from "./browx-page.js";
import { log } from "../util/logging.js";

export interface BrowxSignal {
  name: string;
  data: unknown;
  ts: number;
  /** URL of the page that emitted it (best-effort). */
  url?: string;
}

interface Waiter {
  name?: string;
  resolve: (sig: BrowxSignal) => void;
  reject: (err: Error) => void;
  timeout?: NodeJS.Timeout;
}

export class BrowxBridge {
  private signals: BrowxSignal[] = [];
  private waiters: Waiter[] = [];
  private pollers = new Map<Page, NodeJS.Timeout>();
  private bindingOk = false;
  /** track attached contexts so detach() can install in-page opt-out
   *  markers and known-disconnect handlers can stop nagging the user with
   *  "function not exposed" console noise after our session ends. */
  private contexts: BrowserContext[] = [];
  /** once true, our exposeBinding handler quietly drops incoming
   *  payloads and the page script's `send()` is told (via `__browx_no_binding`)
   *  to skip the binding and use the DOM-attribute path. */
  private detached = false;

  constructor(private cap: number = 200) {}

  async attach(context: BrowserContext): Promise<void> {
    this.contexts.push(context);
    try {
      await context.exposeBinding("__browx_send", (source, payload: string) => {
        if (this.detached) return; // quiet drop after detach.
        try {
          const o = JSON.parse(payload) as { kind: string; name: string; data: unknown };
          if (o.kind === "signal")
            this.onSignal({ name: o.name, data: o.data, ts: Date.now(), url: source.page?.url() });
        } catch (e) {
          log.warn("browx-bridge: bad payload", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      });
      this.bindingOk = true;
    } catch (e) {
      log.warn("browx-bridge: exposeBinding failed; will use DOM-attribute polling only", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    await context.addInitScript({ content: BROWX_PAGE_SCRIPT });
    // Re-inject into pages that already exist.
    for (const page of context.pages()) {
      await page.evaluate(BROWX_PAGE_SCRIPT).catch(() => undefined);
      this.startPolling(page);
    }
    context.on("page", (page) => {
      page.evaluate(BROWX_PAGE_SCRIPT).catch(() => undefined);
      this.startPolling(page);
    });
  }

  /** Stop all pollers, reject outstanding waiters, and flip the
   *  in-page `__browx_no_binding` flag so any subsequent `__browx.signal()`
   *  / `.confirm()` etc. from the page goes through the DOM-attribute path
   *  instead of the now-detached `__browx_send` exposeBinding glue —
   *  silencing the "Function `__browx_send` is not exposed" console errors
   *  that the shared-CDP verification run flagged. */
  async detach(): Promise<void> {
    this.detached = true;
    for (const t of this.pollers.values()) clearInterval(t);
    this.pollers.clear();
    for (const w of this.waiters) {
      if (w.timeout) clearTimeout(w.timeout);
      w.reject(new Error("bridge detached"));
    }
    this.waiters = [];
    const setOptOut = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = (globalThis as any).window;
      if (w) w.__browx_no_binding = true;
    };
    for (const ctx of this.contexts) {
      try {
        for (const page of ctx.pages()) {
          page.evaluate(setOptOut).catch(() => undefined);
        }
      } catch {
        /* context already torn down */
      }
    }
    this.contexts = [];
  }

  /** test introspection — true once detach() has fired. */
  isDetached(): boolean {
    return this.detached;
  }

  /**
   * Wait for the next signal matching `name` (or any signal if `name` is omitted).
   * `timeoutMs > 0` rejects with a timeout error; `0` waits indefinitely.
   */
  awaitSignal(name?: string, timeoutMs = 0): Promise<BrowxSignal> {
    // Already-queued signal? (rare — usually we install the waiter before the
    // human acts, but acknowledge-mode might pre-fire if the human is fast.)
    if (name) {
      const idx = this.signals.findIndex((s) => s.name === name);
      if (idx >= 0) return Promise.resolve(this.signals.splice(idx, 1)[0]!);
    } else if (this.signals.length) {
      return Promise.resolve(this.signals.shift()!);
    }
    return new Promise<BrowxSignal>((resolve, reject) => {
      const w: Waiter = { name, resolve, reject };
      if (timeoutMs > 0) {
        w.timeout = setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error(`awaitHuman timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.waiters.push(w);
    });
  }

  private onSignal(sig: BrowxSignal): void {
    log.info("browx-bridge: signal", { name: sig.name, url: sig.url });
    // Match the *first* waiter wanting this name (FIFO). If none, queue.
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i]!;
      if (!w.name || w.name === sig.name) {
        this.waiters.splice(i, 1);
        if (w.timeout) clearTimeout(w.timeout);
        w.resolve(sig);
        return;
      }
    }
    this.signals.push(sig);
    if (this.signals.length > this.cap) this.signals.shift();
  }

  /**
   * DOM-attribute fallback: every ~250ms, read `documentElement.dataset.browxSignal`,
   * and if it differs from the last seen value, dispatch + clear. Lets the in-page
   * helper still talk to us when the CDP binding is clobbered.
   */
  private startPolling(page: Page): void {
    if (this.pollers.has(page)) return;
    let lastSeen: string | null = null;
    const tick = async () => {
      try {
        const raw = await page.evaluate(() => {
          // Runs in page context; cast through unknown to keep ts happy server-side.
          const doc = (
            globalThis as unknown as {
              document?: {
                documentElement: {
                  getAttribute: (n: string) => string | null;
                  removeAttribute: (n: string) => void;
                };
              };
            }
          ).document;
          if (!doc) return null;
          const v = doc.documentElement.getAttribute("data-browx-signal");
          if (v) doc.documentElement.removeAttribute("data-browx-signal");
          return v;
        });
        if (raw && raw !== lastSeen) {
          lastSeen = raw;
          const o = JSON.parse(raw) as { kind: string; name: string; data: unknown; ts: number };
          if (o.kind === "signal")
            this.onSignal({ name: o.name, data: o.data, ts: o.ts, url: page.url() });
        }
      } catch {
        // Page may have closed / navigated mid-poll.
      }
    };
    const t = setInterval(tick, 250);
    this.pollers.set(page, t);
    page.on("close", () => {
      const it = this.pollers.get(page);
      if (it) {
        clearInterval(it);
        this.pollers.delete(page);
      }
    });
  }

  /** True if the CDP binding installed cleanly. (Polling fallback runs either way.) */
  bindingHealthy(): boolean {
    return this.bindingOk;
  }
}
