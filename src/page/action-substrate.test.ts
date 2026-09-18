import { describe, it, expect } from "vitest";
import {
  PlaywrightActionSubstrate,
  SafariActionSubstrate,
  gestureToolName,
  TOUCH_DISPATCH_ENGINE_REFUSAL,
  type ActionSubstrate,
  type GestureRequest,
} from "./action-substrate.js";
import { DIRECT_DISPATCH_ENGINE_REFUSAL } from "./actions-direct-dispatch.js";
import { RefRegistry } from "./refs.js";
import type { ActionContext } from "./actionresult.js";
import type { SafariSessionHandle } from "../engine/index.js";

// The ActionSubstrate port routing/gating. PlaywrightActionSubstrate is trivial
// delegation to actions.* (covered by the per-engine keystones); these cover the
// Safari adapter's curated-subset routing + the in-adapter gating that replaced
// the per-handler `if (engine === "safari")` branches.

function safariHandle(): { handle: SafariSessionHandle; navigated: string[] } {
  const navigated: string[] = [];
  const handle = {
    sessionId: "S",
    webDriver: {
      currentUrl: async () => "about:blank",
      navigate: async (_s: string, url: string) => {
        navigated.push(url);
      },
      findElement: async () => null,
    },
  } as unknown as SafariSessionHandle;
  return { handle, navigated };
}

describe("SafariActionSubstrate", () => {
  it("tags the safari engine", () => {
    const { handle } = safariHandle();
    expect(new SafariActionSubstrate(handle, new RefRegistry()).engine).toBe("safari");
  });

  it("routes navigate to the WebDriver client", async () => {
    const { handle, navigated } = safariHandle();
    const sub = new SafariActionSubstrate(handle, new RefRegistry());
    const r = await sub.navigate({ url: "https://example.com/" });
    expect(r.ok).toBe(true);
    expect(navigated).toEqual(["https://example.com/"]);
  });

  it("gates the actions outside the curated subset cleanly (in the adapter, not the handler)", async () => {
    const { handle } = safariHandle();
    const sub: ActionSubstrate = new SafariActionSubstrate(handle, new RefRegistry());
    for (const r of [
      await sub.hover({ target: { selector: "#x" } }),
      await sub.select({ target: { selector: "#x" }, values: ["a"] }),
      await sub.scroll({}),
      await sub.goBack({}),
    ]) {
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/not supported on the Safari engine/);
    }
  });

  it("press without a target refuses (page-level press has no WebDriver element)", async () => {
    const { handle } = safariHandle();
    const sub = new SafariActionSubstrate(handle, new RefRegistry());
    const r = await sub.press({ key: "Enter" });
    expect(r.ok).toBe(false);
  });

  it('refuses click({dispatch:"direct"}) with the named reason — Safari has no CDP', async () => {
    const { handle } = safariHandle();
    const sub = new SafariActionSubstrate(handle, new RefRegistry());
    const r = await sub.click({ target: { selector: "#send" }, dispatch: "direct" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(DIRECT_DISPATCH_ENGINE_REFUSAL);
    expect(r.error).toContain('"safari"');
  });
});

// The engine gate for `dispatch:"direct"` lives at this seam, keyed on the
// ActionContext carrying a CDP accessor — never on an engine name.
describe("PlaywrightActionSubstrate — the dispatch:'direct' engine gate", () => {
  const ctxFor = (cdp: boolean): ActionContext =>
    ({ ...(cdp ? { cdp: () => ({}) as never } : {}) }) as unknown as ActionContext;

  it("refuses on an engine whose context carries no CDP accessor", async () => {
    const sub = new PlaywrightActionSubstrate(() => ctxFor(false), "firefox");
    const r = await sub.click({ target: { selector: "#send" }, dispatch: "direct" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(DIRECT_DISPATCH_ENGINE_REFUSAL);
    expect(r.error).toContain('"firefox"');
  });

  it("does not refuse when the option is unset, on any engine", async () => {
    let reached = false;
    const sub = new PlaywrightActionSubstrate(() => {
      reached = true;
      return ctxFor(false);
    }, "webkit");
    await sub.click({ target: { selector: "#send" } }).catch(() => undefined);
    expect(reached).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The touch pipeline on the port (RFC 0009 P3). One member, three request kinds.
// These five tools carried `deep: true` until this phase, so the engine gate
// refused them upstream and the substrate was never consulted; the refusal lives
// here now and these are the tests that hold it.

/** One sample per request kind. A `Record` over the union's discriminant, so the
 *  TABLE'S OWN COMPLETENESS is a compile error instead of a silently smaller test
 *  run: a fourth gesture kind that is not added here fails `pnpm typecheck`. The
 *  runtime assertion below closes the other half — the three kinds still cover
 *  the five tool registrations this phase retired `deep: true` on. */
const GESTURE_SAMPLES: Record<GestureRequest["kind"], GestureRequest> = {
  touch: { kind: "touch", phase: "start", coords: { x: 10, y: 20 }, identifier: 3 },
  swipe: { kind: "swipe", from: { x: 0, y: 0 }, to: { x: 50, y: 0 }, steps: 2, durationMs: 0 },
  pinch: { kind: "pinch", coords: { x: 100, y: 100 }, scale: 2, steps: 2, startOffset: 40 },
};

const ALL_SAMPLES = Object.values(GESTURE_SAMPLES);

function fakeCdpCtx(): { ctx: ActionContext; calls: string[] } {
  const calls: string[] = [];
  const cdp = {
    send: async (method: string) => {
      calls.push(method);
      return {};
    },
  };
  return { ctx: { cdp: () => cdp } as unknown as ActionContext, calls };
}

describe("ActionSubstrate.gesture — the request union", () => {
  it("covers the five registrations that retired `deep: true`", () => {
    // The P2 trap, applied here: a generated table that loses an entry runs FEWER
    // cases and stays green. The `Record<GestureRequest["kind"], …>` above makes
    // a missing KIND a type error; this makes a missing TOOL a test failure, so
    // the table cannot drift away from the registrations it stands for.
    const names = new Set([
      ...(["start", "move", "end"] as const).map((phase) =>
        gestureToolName({ kind: "touch", phase }),
      ),
      ...ALL_SAMPLES.map(gestureToolName),
    ]);
    expect([...names].sort()).toEqual([
      "gesture_pinch",
      "gesture_swipe",
      "touch_end",
      "touch_move",
      "touch_start",
    ]);
    expect(ALL_SAMPLES).toHaveLength(3);
  });
});

describe("PlaywrightActionSubstrate.gesture", () => {
  it.each(ALL_SAMPLES.map((req) => [req.kind, req] as const))(
    "[%s] dispatches through CDP when the context carries the accessor",
    async (_kind, req) => {
      const { ctx, calls } = fakeCdpCtx();
      const sub = new PlaywrightActionSubstrate(() => ctx, "chromium");
      const r = await sub.gesture(req);
      expect(r.kind).toBe("dispatched");
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((m) => m === "Input.dispatchTouchEvent")).toBe(true);
    },
  );

  it("reports the touch evidence body the pre-seam handler rendered", async () => {
    const { ctx } = fakeCdpCtx();
    const sub = new PlaywrightActionSubstrate(() => ctx, "chromium");
    const r = await sub.gesture(GESTURE_SAMPLES.touch);
    expect(r.kind === "dispatched" && r.report).toEqual({
      ok: true,
      action: "start",
      coords: { x: 10, y: 20 },
      identifier: 3,
    });
  });

  it("reports the swipe and pinch evidence bodies unchanged", async () => {
    const { ctx } = fakeCdpCtx();
    const sub = new PlaywrightActionSubstrate(() => ctx, "chromium");
    const swipe = await sub.gesture(GESTURE_SAMPLES.swipe);
    expect(swipe.kind === "dispatched" && swipe.report).toEqual({
      ok: true,
      from: { x: 0, y: 0 },
      to: { x: 50, y: 0 },
      steps: 2,
      durationMs: 0,
    });
    const pinch = await sub.gesture(GESTURE_SAMPLES.pinch);
    expect(pinch.kind === "dispatched" && pinch.report).toEqual({
      ok: true,
      coords: { x: 100, y: 100 },
      scale: 2,
      steps: 2,
      startOffset: 40,
      endOffset: 80,
    });
  });

  it.each(ALL_SAMPLES.map((req) => [req.kind, req] as const))(
    "[%s] refuses on an engine whose context carries no CDP accessor",
    async (_kind, req) => {
      const sub = new PlaywrightActionSubstrate(() => ({}) as unknown as ActionContext, "firefox");
      const r = await sub.gesture(req);
      expect(r.kind).toBe("refusal");
      expect(r.kind === "refusal" && r.engine).toBe("firefox");
      expect(r.kind === "refusal" && r.hint).toContain(TOUCH_DISPATCH_ENGINE_REFUSAL);
    },
  );

  it("refuses with the string the engine gate produced while the flag was set", async () => {
    // The assertion that makes "no widening, same reason" checkable. This is
    // `assertEngineSupports`'s `error` line, character for character, for each of
    // the five tools — so an agent (or a recorded transcript) matching on it sees
    // no change from the deep-flag retirement.
    const sub = new PlaywrightActionSubstrate(() => ({}) as unknown as ActionContext, "webkit");
    for (const phase of ["start", "move", "end"] as const) {
      const r = await sub.gesture({ kind: "touch", phase, coords: { x: 1, y: 1 } });
      expect(r.kind === "refusal" && r.error).toBe(
        `tool "touch_${phase}" is not supported on the "webkit" engine`,
      );
    }
    for (const req of [GESTURE_SAMPLES.swipe, GESTURE_SAMPLES.pinch]) {
      const r = await sub.gesture(req);
      expect(r.kind === "refusal" && r.error).toBe(
        `tool "${gestureToolName(req)}" is not supported on the "webkit" engine`,
      );
    }
  });

  it("rejects when the context accessor is dead, and never throws synchronously", async () => {
    // The `substrate-adapter-async` bug class at this member: the accessor throws
    // on a closed BYOB tab, and an `async` body turns that into a rejection the
    // handler's guard can see.
    const sub = new PlaywrightActionSubstrate(() => {
      throw new Error("attach-target-gone");
    }, "chromium");
    let promise: unknown;
    expect(() => {
      promise = sub.gesture(GESTURE_SAMPLES.swipe);
    }).not.toThrow();
    await expect(promise).rejects.toThrow("attach-target-gone");
  });
});

describe("SafariActionSubstrate.gesture", () => {
  it.each(ALL_SAMPLES.map((req) => [req.kind, req] as const))(
    "[%s] refuses — safaridriver drives no pointer-source sequence",
    async (_kind, req) => {
      const { handle } = safariHandle();
      const sub = new SafariActionSubstrate(handle, new RefRegistry());
      const r = await sub.gesture(req);
      expect(r.kind).toBe("refusal");
      expect(r.kind === "refusal" && r.engine).toBe("safari");
      expect(r.kind === "refusal" && r.error).toBe(
        `tool "${gestureToolName(req)}" is not supported on the "safari" engine`,
      );
    },
  );
});
