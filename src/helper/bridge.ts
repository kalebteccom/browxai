// Server-side `__browx` bridge: the human channel that releases `await_human`,
// the confirm hooks, and every `ask-human` policy.
//
// Page content is untrusted, so a human answer must come from somewhere the
// page's scripts cannot reach. The bridge installs a CDP binding scoped to an
// isolated world named `browxai-<random>` on every page, evaluates the
// `__browx` helper in that world, and accepts a binding call only when CDP
// reports it came from one of that world's execution contexts. The random
// suffix matters: `Runtime.addBinding({executionContextName})` also lands in
// any other world with the same name, and a Chrome extension's content-script
// world is named after the extension. A context whose origin is an extension
// origin is refused as well. A human reaches the world from DevTools by picking
// the name printed in `humanHint()`. The page's main world gets a display-only
// stub (`BROWX_PAGE_STUB`).
//
// An engine without CDP (firefox, webkit, safari, the native engines) has no
// isolated world browxai can create, so it gets no human channel at all:
// `awaitSignal` refuses immediately and the callers fail closed. Nothing on
// those engines falls back to a page-reachable path.

import { randomBytes } from "node:crypto";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { BROWX_PAGE_STUB, HUMAN_WORLD, browxHumanScript } from "./browx-page.js";
import { log } from "../util/logging.js";

export { HUMAN_WORLD } from "./browx-page.js";

/** Error message prefix `awaitSignal` rejects with when the session has no
 *  human channel. Callers key refusals on it. */
export const NO_HUMAN_CHANNEL = "no-human-channel";

export interface BrowxSignal {
  name: string;
  data: unknown;
  /** The prompt ticket the human passed, if any. */
  ticket?: string | null;
  ts: number;
  /** URL of the page that emitted it (best-effort). */
  url?: string;
}

interface Waiter {
  name?: string;
  /** When set, only a signal carrying this ticket answers the waiter. */
  ticket?: string;
  resolve: (sig: BrowxSignal) => void;
  reject: (err: Error) => void;
  timeout?: NodeJS.Timeout;
}

interface PageChannel {
  cdp: CDPSession;
  /** Execution-context ids of `HUMAN_WORLD` on this page. A binding call from
   *  any other context is dropped. */
  worlds: Set<number>;
  /** One warning per page for calls from a foreign context, not one per call. */
  warnedForeign?: boolean;
}

interface BindingCalledEvent {
  name: string;
  payload: string;
  executionContextId: number;
}

interface ContextCreatedEvent {
  context: { id: number; name: string; origin?: string; auxData?: { type?: string } };
}

/** Origins that belong to browser extensions, never to a world browxai made. */
const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\//i;

export interface BrowxBridgeOptions {
  /** Fixed world name. Tests only: production worlds are random per bridge. */
  worldName?: string;
}

export class BrowxBridge {
  private waiters: Waiter[] = [];
  private channels = new Map<Page, PageChannel>();
  private detached = false;
  /** Random per bridge, so two bridges on one browser never read each other's
   *  calls, and a page cannot guess the name to probe for it. */
  private readonly binding = `__browx_human_${randomBytes(12).toString("hex")}`;
  /** The isolated world's name, unguessable per bridge. */
  readonly world: string;
  constructor(opts: BrowxBridgeOptions = {}) {
    this.world = opts.worldName ?? `${HUMAN_WORLD}-${randomBytes(6).toString("hex")}`;
  }

  /** The operator-facing instruction every human prompt carries. */
  humanHint(): string {
    return `in DevTools, pick the "${this.world}" console context (not "top")`;
  }

  /** A fresh prompt ticket. Print it with the prompt and pass it to
   *  `awaitSignal`; the human's answer has to carry it. */
  newTicket(): string {
    return randomBytes(3).toString("hex");
  }

  /**
   * Install the channel on `context`. With `root` set, the context is shared
   * with other sessions (an attached browser, where each session leases its own
   * tab), so the bridge wires only `root` and popups opened from a page it
   * already wired. Without it, the context belongs to this session and every
   * page in it is wired.
   */
  async attach(context: BrowserContext, opts: { root?: Page } = {}): Promise<void> {
    const { root } = opts;
    await context.addInitScript({ content: BROWX_PAGE_STUB });
    for (const page of root ? [root] : context.pages()) {
      await page.evaluate(BROWX_PAGE_STUB).catch(() => undefined);
      await this.wirePage(page);
    }
    context.on("page", (page) => {
      void (async () => {
        if (root) {
          const opener = await page.opener().catch(() => null);
          if (!opener || !this.channels.has(opener)) return;
        }
        page.evaluate(BROWX_PAGE_STUB).catch(() => undefined);
        await this.wirePage(page);
      })();
    });
  }

  /** Install the isolated-world channel on one page. Leaves the page without a
   *  channel when the engine has no CDP. */
  private async wirePage(page: Page): Promise<void> {
    if (this.detached || this.channels.has(page)) return;
    let cdp: CDPSession;
    try {
      cdp = await page.context().newCDPSession(page);
    } catch (e) {
      log.info("browx-bridge: no CDP on this engine; the human channel is unavailable", {
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    const channel: PageChannel = { cdp, worlds: new Set() };
    cdp.on("Runtime.executionContextCreated", (ev: ContextCreatedEvent) => {
      const c = ev.context;
      if (c.name !== this.world || c.auxData?.type !== "isolated") return;
      if (EXTENSION_ORIGIN.test(c.origin ?? "")) {
        log.warn("browx-bridge: refused an extension context that carries the human-world name");
        return;
      }
      channel.worlds.add(c.id);
    });
    cdp.on("Runtime.executionContextDestroyed", (ev: { executionContextId: number }) => {
      channel.worlds.delete(ev.executionContextId);
    });
    cdp.on("Runtime.executionContextsCleared", () => channel.worlds.clear());
    cdp.on("Runtime.bindingCalled", (ev: BindingCalledEvent) => {
      if (this.detached || ev.name !== this.binding) return;
      if (!channel.worlds.has(ev.executionContextId)) {
        if (!channel.warnedForeign) {
          channel.warnedForeign = true;
          log.warn("browx-bridge: dropped a human-channel call from outside the isolated world");
        }
        return;
      }
      this.onPayload(ev.payload, page);
    });
    const script = browxHumanScript(this.binding);
    try {
      await cdp.send("Runtime.enable");
      await cdp.send("Page.enable");
      await cdp.send("Runtime.addBinding", {
        name: this.binding,
        executionContextName: this.world,
      });
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: script,
        worldName: this.world,
        runImmediately: true,
      });
      const { frameTree } = await cdp.send("Page.getFrameTree");
      const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: this.world,
      });
      await cdp.send("Runtime.evaluate", { expression: script, contextId: executionContextId });
    } catch (e) {
      log.warn("browx-bridge: failed to install the human channel on a page", {
        error: e instanceof Error ? e.message : String(e),
      });
      await cdp.detach().catch(() => undefined);
      return;
    }
    this.channels.set(page, channel);
    page.on("close", () => {
      this.channels.delete(page);
    });
  }

  private onPayload(payload: string, page: Page): void {
    try {
      const o = JSON.parse(payload) as {
        kind: string;
        name: string;
        data: unknown;
        ticket?: string | null;
      };
      if (o.kind === "signal" && typeof o.name === "string")
        this.onSignal({
          name: o.name,
          data: o.data,
          ticket: typeof o.ticket === "string" ? o.ticket : null,
          ts: Date.now(),
          url: page.url(),
        });
    } catch (e) {
      log.warn("browx-bridge: bad payload", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** True when at least one page carries the isolated-world channel. */
  humanChannelAvailable(): boolean {
    return !this.detached && this.channels.size > 0;
  }

  /** Stop listening, reject outstanding waiters, and drop the CDP sessions. */
  async detach(): Promise<void> {
    this.detached = true;
    for (const w of this.waiters) {
      if (w.timeout) clearTimeout(w.timeout);
      w.reject(new Error("bridge detached"));
    }
    this.waiters = [];
    const sessions = [...this.channels.values()].map((c) => c.cdp);
    this.channels.clear();
    await Promise.all(
      sessions.map(async (cdp) => {
        await cdp.send("Runtime.removeBinding", { name: this.binding }).catch(() => undefined);
        await cdp.detach().catch(() => undefined);
      }),
    );
  }

  /** test introspection — true once detach() has fired. */
  isDetached(): boolean {
    return this.detached;
  }

  /**
   * Wait for the next signal matching `name` (or any signal if `name` is omitted)
   * and, when `ticket` is given, carrying that ticket. Only signals that arrive
   * while the wait is pending count: nothing is queued, so an answer sent after
   * its prompt ended is dropped instead of answering the next one.
   * `timeoutMs > 0` rejects with a timeout error; `0` waits indefinitely.
   * Rejects at once with `NO_HUMAN_CHANNEL` when no page carries the channel.
   */
  awaitSignal(name?: string, timeoutMs = 0, ticket?: string): Promise<BrowxSignal> {
    if (!this.humanChannelAvailable()) {
      return Promise.reject(
        new Error(
          `${NO_HUMAN_CHANNEL}: this session has no human channel (it needs a CDP-capable ` +
            "engine: chromium, an attached Chrome, Chrome on Android, or Electron)",
        ),
      );
    }
    return new Promise<BrowxSignal>((resolve, reject) => {
      const w: Waiter = { name, ticket, resolve, reject };
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
    // The first pending waiter this answers (FIFO). No match → dropped.
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i]!;
      if (w.name && w.name !== sig.name) continue;
      if (w.ticket && w.ticket !== sig.ticket) continue;
      this.waiters.splice(i, 1);
      if (w.timeout) clearTimeout(w.timeout);
      w.resolve(sig);
      return;
    }
    log.warn("browx-bridge: dropped a human answer that matches no pending prompt", {
      name: sig.name,
      ticket: sig.ticket ?? null,
    });
  }
}
