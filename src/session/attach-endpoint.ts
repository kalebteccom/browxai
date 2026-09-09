// The attached CDP endpoint: one shared browser connection per endpoint, and the
// page targets reachable over it. Connection ownership lives here rather than in
// the session factory so N sessions attached to one Chrome open one connection.

import type { Browser, Page } from "playwright-core";
import type { PoolTarget, TargetSource } from "./attach-pool.js";

const LOOPBACK_ALIASES = new Set(["localhost", "::1", "[::1]"]);

/** Same Chrome, same key. The loopback spellings are interchangeable for the
 *  attach lane, so `localhost:9222` and `127.0.0.1:9222` must not open two
 *  connections and two disjoint lease sets. */
export function normalizeAttachEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  const host = LOOPBACK_ALIASES.has(url.hostname.toLowerCase()) ? "127.0.0.1" : url.hostname;
  const port = url.port ? `:${url.port}` : "";
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.protocol.toLowerCase()}//${host.toLowerCase()}${port}${path}`;
}

export interface AttachedConnection {
  readonly browser: Browser;
  /** The normalized key this connection is shared under — also the lease key. */
  readonly endpoint: string;
  release(): Promise<void>;
}

interface ConnectionEntry {
  browser: Promise<Browser>;
  refs: number;
}

const connections = new Map<string, ConnectionEntry>();

/** Refcounted `connectOverCDP`. Last session out closes the connection; for a
 *  CDP-attached browser `close()` drops the websocket and leaves the operator's
 *  Chrome running (not-owned). */
export async function acquireConnection(
  endpoint: string,
  connect: (endpoint: string) => Promise<Browser>,
): Promise<AttachedConnection> {
  const key = normalizeAttachEndpoint(endpoint);
  let entry = connections.get(key);
  if (!entry) {
    entry = { browser: connect(endpoint), refs: 0 };
    connections.set(key, entry);
  }
  entry.refs += 1;
  let browser: Browser;
  try {
    browser = await entry.browser;
  } catch (err) {
    entry.refs -= 1;
    if (entry.refs <= 0) connections.delete(key);
    throw err;
  }
  browser.once("disconnected", () => {
    if (connections.get(key) === entry) connections.delete(key);
  });

  let released = false;
  return {
    browser,
    endpoint: key,
    release: async () => {
      if (released) return;
      released = true;
      entry.refs -= 1;
      if (entry.refs > 0) return;
      if (connections.get(key) === entry) connections.delete(key);
      await browser.close().catch(() => undefined);
    },
  };
}

async function pageTargetId(page: Page): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = (await cdp.send("Target.getTargetInfo")) as {
      targetInfo: { targetId: string };
    };
    return targetInfo.targetId;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** The pool's view of an attached browser: every live page across every context
 *  is a claimable target, and a new tab in the first context is the fallback. */
export function browserTargetSource(browser: Browser): TargetSource {
  return {
    list: async () => {
      const pages = browser
        .contexts()
        .flatMap((c) => c.pages())
        .filter((p) => !p.isClosed());
      const resolved = await Promise.all(
        pages.map(async (page) => {
          const targetId = await pageTargetId(page).catch(() => undefined);
          return targetId === undefined ? undefined : { targetId, page };
        }),
      );
      return resolved.filter((t): t is PoolTarget => t !== undefined);
    },
    create: async () => {
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = await context.newPage();
      return { targetId: await pageTargetId(page), page };
    },
  };
}
