// point_probe — the structured failure envelope survives a gone target.
//
// `point_probe`'s catch block reports the coordinate plus the target URL so the
// agent can triage. The URL read sits INSIDE that catch, so a second throw there
// escapes the handler entirely and the agent gets a transport-level rejection
// instead of `{ok:false, point, url, error}`. That is what a non-async adapter
// method typed `Promise<string>` does on an attached (BYOB) session whose tab is
// closed: `requirePage` throws before a promise exists, so the `.catch(() => "")`
// guarding the read never runs.
//
// Browser-free: `requirePage` throws on the way IN, so `pointProbe` itself is
// never reached and no real page is needed.

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { registerReadObserveBufferTools } from "./read-observe-buffer-tools.js";
import { PlaywrightTargetSubstrate, SafariTargetSubstrate } from "../page/target-substrate.js";
import { requirePage, type PageCapable, type SafariSessionHandle } from "../engine/index.js";
import type { ToolHost, ToolResponse } from "./host.js";

type CapturedHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;

const GONE = "attach-target-gone: the attached tab is closed";

/** Register the buffer tools against a minimal mock host and return the
 *  `point_probe` handler. `targetFor` returns a REAL adapter over the supplied
 *  session — the adapter's behaviour is what is under test, so it is not
 *  stubbed. */
function capturePointProbe(session: object, target: () => unknown): CapturedHandler {
  const handlers: Record<string, CapturedHandler> = {};
  const host = {
    z,
    register: (name: string, _def: unknown, handler: CapturedHandler) => {
      handlers[name] = handler;
    },
    gateCheck: () => undefined,
    entryFor: () => ({ session }),
    cfgActionTimeout: () => 1_000,
    egressFor: () => ({ maskDeep: (x: unknown) => x }),
    targetFor: target,
  } as unknown as ToolHost;
  registerReadObserveBufferTools(host);
  const handler = handlers.point_probe;
  if (!handler) throw new Error("point_probe was not registered");
  return handler;
}

function bodyOf(res: ToolResponse): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("point_probe — structured envelope on a gone target", () => {
  it("returns {ok:false, point, url, error} when the attached tab is closed", async () => {
    const session: PageCapable = {
      engine: "chromium",
      page: () => {
        throw new Error(GONE);
      },
    };
    const handler = capturePointProbe(
      session,
      () =>
        // The Playwright adapter over the session's own (throwing) accessor.
        new PlaywrightTargetSubstrate(() => requirePage(session), session.engine),
    );
    const body = bodyOf(await handler({ coords: { x: 12, y: 34 } }));
    expect(body.ok).toBe(false);
    expect(body.point).toEqual({ x: 12, y: 34 });
    // The URL degrades to "" — the same value main produced from its inner
    // try/catch — and the probe's own failure is what gets reported.
    expect(body.url).toBe("");
    expect(String(body.error)).toContain("attach-target-gone");
  });

  it("fills the URL from the target port on an engine with no Playwright Page", async () => {
    // Safari: `requirePage` refuses on the way in, but the port still answers
    // the URL over WebDriver — so the triage envelope carries a real URL.
    const handle = {
      sessionId: "SID-1",
      webDriver: { currentUrl: () => Promise.resolve("https://shop.test/cart") },
    } as unknown as SafariSessionHandle;
    const handler = capturePointProbe(
      { engine: "safari" },
      () => new SafariTargetSubstrate(handle),
    );
    const body = bodyOf(await handler({ coords: { x: 1, y: 2 } }));
    expect(body.ok).toBe(false);
    expect(body.url).toBe("https://shop.test/cart");
    expect(String(body.error)).toContain("backs no Playwright Page");
  });
});
