import { describe, it, expect } from "vitest";
import type { CDPSession, Locator, Page } from "playwright-core";
import {
  directClick,
  directDispatchUnsupported,
  DIRECT_DISPATCH_ENGINE_REFUSAL,
  DIRECT_DISPATCH_TARGET_REFUSAL,
} from "./actions-direct-dispatch.js";
import { RefRegistry, type RefLocatorInputs } from "./refs.js";

// The plumbing and the refusals. The claim these CANNOT test — that the
// dispatched events are trusted and land where the actionability path could not
// — is the keystone's job (test/keystone/direct-dispatch.keystone.test.ts); a
// mocked CDP session would pass either way.

interface CdpCall {
  method: string;
  params: Record<string, unknown>;
}

function cdpMock(): { cdp: CDPSession; calls: CdpCall[] } {
  const calls: CdpCall[] = [];
  const cdp = {
    send: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return {};
    },
  } as unknown as CDPSession;
  return { cdp, calls };
}

/** A page whose `evaluate` answers the measurement call with `rect`, and every
 *  later call (the `captureHit` probes) with null. */
function pageMock(rect: { x: number; y: number; width: number; height: number } | null): Page {
  let first = true;
  return {
    evaluate: async () => {
      if (first) {
        first = false;
        return rect;
      }
      return null;
    },
  } as unknown as Page;
}

const locMock = { count: async () => 0 } as unknown as Locator;

function refsWith(inputs: RefLocatorInputs): { refs: RefRegistry; ref: string } {
  const refs = new RefRegistry();
  return { refs, ref: refs.forKey("k1", inputs) };
}

describe("directDispatchUnsupported — the engine refusal", () => {
  it("refuses with the named reason and never claims success", () => {
    const r = directDispatchUnsupported({ selector: "#send" }, "firefox");
    expect(r.ok).toBe(false);
    expect(r.error).toContain(DIRECT_DISPATCH_ENGINE_REFUSAL);
    expect(r.error).toContain('"firefox"');
    expect(r.action).toEqual({ type: "click", selector: "#send" });
  });

  it("names the engine it was asked to run on, so the refusal is not generic", () => {
    for (const engine of ["firefox", "webkit", "safari"]) {
      expect(directDispatchUnsupported({ ref: "e1" }, engine).error).toContain(`"${engine}"`);
    }
  });

  it("says why there is no page-JS fallback rather than leaving it unexplained", () => {
    expect(directDispatchUnsupported({ ref: "e1" }, "webkit").error).toContain("isTrusted:false");
  });
});

describe("directClick — dispatch plumbing", () => {
  it("sends move / press / release at the measured box centre with the right buttons mask", async () => {
    const { cdp, calls } = cdpMock();
    const page = pageMock({ x: 100, y: 200, width: 40, height: 20 });
    await directClick(page, cdp, locMock, {
      target: { selector: "#send" },
      refs: new RefRegistry(),
      button: "right",
    });
    expect(calls.map((c) => c.method)).toEqual([
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
    ]);
    expect(calls.map((c) => c.params.type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    for (const c of calls) {
      expect(c.params.x).toBe(120);
      expect(c.params.y).toBe(210);
    }
    expect(calls[1]?.params).toMatchObject({ button: "right", buttons: 2, clickCount: 1 });
    expect(calls[2]?.params).toMatchObject({ button: "right", buttons: 0 });
  });

  it("defaults to the left button", async () => {
    const { cdp, calls } = cdpMock();
    await directClick(pageMock({ x: 0, y: 0, width: 10, height: 10 }), cdp, locMock, {
      target: { selector: "#send" },
      refs: new RefRegistry(),
    });
    expect(calls[1]?.params).toMatchObject({ button: "left", buttons: 1 });
  });

  it("stamps the mandatory bypass warning naming the coordinate and the trust level", async () => {
    const { cdp } = cdpMock();
    const probed = await directClick(
      pageMock({ x: 100, y: 200, width: 40, height: 20 }),
      cdp,
      locMock,
      { target: { selector: "#send" }, refs: new RefRegistry() },
    );
    const warning = probed.warnings?.[0] ?? "";
    expect(warning).toContain('dispatch:"direct"');
    expect(warning).toContain("(120, 210)");
    expect(warning).toContain("isTrusted:true");
    expect(warning).toContain("does not scroll");
  });

  it("refuses a target with no rendered box instead of dispatching at (0,0)", async () => {
    const { cdp, calls } = cdpMock();
    await expect(
      directClick(pageMock(null), cdp, locMock, {
        target: { selector: "#send" },
        refs: new RefRegistry(),
      }),
    ).rejects.toThrow(DIRECT_DISPATCH_TARGET_REFUSAL);
    expect(calls).toEqual([]);
  });

  it("refuses a ref that carries no CSS form, since the page-side measurement needs one", async () => {
    const { cdp, calls } = cdpMock();
    const { refs, ref } = refsWith({ role: "button", name: "Send" });
    await expect(
      directClick(pageMock({ x: 0, y: 0, width: 10, height: 10 }), cdp, locMock, {
        target: { ref },
        refs,
      }),
    ).rejects.toThrow(DIRECT_DISPATCH_TARGET_REFUSAL);
    expect(calls).toEqual([]);
  });

  it("measures a ref through its test attribute when it has one", async () => {
    const { cdp, calls } = cdpMock();
    const { refs, ref } = refsWith({
      role: "button",
      name: "Send",
      testId: "send-btn",
      testIdAttr: "data-testid",
    });
    const seen: unknown[] = [];
    const page = {
      evaluate: async (_fn: unknown, arg: unknown) => {
        seen.push(arg);
        return seen.length === 1 ? { x: 0, y: 0, width: 10, height: 10 } : null;
      },
    } as unknown as Page;
    await directClick(page, cdp, locMock, { target: { ref }, refs });
    expect(seen[0]).toEqual({ selector: '[data-testid="send-btn"]' });
    expect(calls).toHaveLength(3);
  });

  it("falls back to the structural css path when the ref has no test attribute", async () => {
    const { cdp } = cdpMock();
    const { refs, ref } = refsWith({ role: "generic", cssPath: "body > div:nth-child(2)" });
    const seen: unknown[] = [];
    const page = {
      evaluate: async (_fn: unknown, arg: unknown) => {
        seen.push(arg);
        return seen.length === 1 ? { x: 0, y: 0, width: 10, height: 10 } : null;
      },
    } as unknown as Page;
    await directClick(page, cdp, locMock, { target: { ref }, refs });
    expect(seen[0]).toEqual({ selector: "body > div:nth-child(2)" });
  });

  it("scopes a contextRef selector so the measurement queries inside the right subtree", async () => {
    const { cdp } = cdpMock();
    const { refs, ref } = refsWith({
      role: "row",
      testId: "row-3",
      testIdAttr: "data-testid",
    });
    const seen: unknown[] = [];
    const page = {
      evaluate: async (_fn: unknown, arg: unknown) => {
        seen.push(arg);
        return seen.length === 1 ? { x: 0, y: 0, width: 10, height: 10 } : null;
      },
    } as unknown as Page;
    await directClick(page, cdp, locMock, {
      target: { selector: ".edit", contextRef: ref },
      refs,
    });
    expect(seen[0]).toEqual({ selector: ".edit", contextSelector: '[data-testid="row-3"]' });
  });
});
