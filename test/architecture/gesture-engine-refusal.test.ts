// L5 — retiring `deep: true` on the five touch/gesture tools moved the refusal,
// it did not remove it.
//
// `touch_start` / `touch_move` / `touch_end` / `gesture_swipe` / `gesture_pinch`
// carried `deep: true` until RFC 0009 P3, so `assertEngineSupports` refused them
// on any engine declaring `deep:false` — before the action substrate was
// consulted. That question was the wrong one: it asks "does this engine have raw
// CDP", and touch is the PRIMARY input on the native engines RFC 0008 adds, which
// have no CDP. The flag refused a native agent exactly the tools it needs most.
//
// So the question became "can this engine dispatch touch", asked at
// `ActionSubstrate.gesture`. This file is the gate on that swap, end to end
// through the real server, and it has to hold BOTH halves or the swap is a
// widening:
//
//   1. An engine shaped like firefox / webkit — a Playwright session whose
//      ActionContext carries NO cdp accessor, driven by the REAL
//      `PlaywrightActionSubstrate` — still refuses all five, with the `error` line
//      character-identical to the one the engine gate produced and the same
//      `{ok, error, engine, hint, tokensEstimate}` envelope.
//   2. An engine that CAN dispatch touch without CDP answers all five. That is
//      the thing the flag made impossible and the reason this phase exists; it is
//      also RFC 0009's P3 row of the enforcement table (`gesture_swipe` on the
//      Page-free synthetic engine).
//
// Both engines are synthetic and browser-free, so this runs in `pnpm test`.

import { describe, it, expect, beforeAll } from "vitest";
import type { EngineCapabilities, EngineKind } from "../../src/engine/index.js";
import type { BrowserSession } from "../../src/session/types.js";
import type { ActionContext } from "../../src/page/actionresult.js";
import { createServer } from "../../src/server.js";
import { registerEngine } from "../../src/engine/registry.js";
import { PlaywrightActionSubstrate } from "../../src/page/action-substrate.js";
import { inMemorySubstrateBundle } from "./_synthetic-engine.js";

const NO_CDP = "gesture-no-cdp" as EngineKind;
const ANSWERS = "gesture-answers" as EngineKind;

/** The five registrations that left `DEEP_TOOLS`, with an argument bag that
 *  reaches the substrate on each. The table is the unit of coverage here, so its
 *  length is asserted below — a generated table that quietly loses a row runs
 *  fewer cases and stays green, which is the trap RFC 0009 P2 hit. */
const RETIRED = [
  { tool: "touch_start", args: { coords: { x: 10, y: 20 } } },
  { tool: "touch_move", args: { coords: { x: 30, y: 40 } } },
  { tool: "touch_end", args: {} },
  { tool: "gesture_swipe", args: { from: { x: 0, y: 0 }, to: { x: 40, y: 0 }, steps: 2 } },
  { tool: "gesture_pinch", args: { coords: { x: 50, y: 50 }, scale: 2, steps: 2 } },
] as const;

function caps(kind: EngineKind): EngineCapabilities {
  return {
    engine: kind,
    subInterfaces: new Set(["lifecycle", "navigation", "snapshot", "input"]),
    // The whole point: deep:false. While the five tools carried the flag, this
    // line alone refused them.
    deep: false,
  };
}

function session(kind: EngineKind): BrowserSession {
  return { mode: "managed", ownsBrowser: true, engine: kind, close: async () => {} };
}

function register(kind: EngineKind, realPlaywrightAdapter: boolean): void {
  registerEngine({
    kind,
    capabilities: caps(kind),
    makeAdapter: async () => session(kind),
    makeSubstrates: (deps) => {
      const bundle = inMemorySubstrateBundle(deps);
      if (!realPlaywrightAdapter) return bundle;
      // The REAL adapter over a context with no cdp accessor — byte-for-byte the
      // firefox / webkit shape. An in-memory stand-in told to refuse would prove
      // only that the stand-in refuses.
      return {
        ...bundle,
        actions: () => new PlaywrightActionSubstrate(() => ({}) as unknown as ActionContext, kind),
      };
    },
    postWire: () => {},
  });
}

type Body = {
  ok?: boolean;
  error?: string;
  engine?: string;
  hint?: string;
  action?: string;
  identifier?: number;
  steps?: number;
};

async function call(
  server: Awaited<ReturnType<typeof createServer>>,
  tool: string,
  args: Record<string, unknown>,
): Promise<Body> {
  const res = await server.handlers[tool](args);
  return JSON.parse((res.content[0] as { text: string }).text) as Body;
}

describe("the five touch tools still refuse on an engine that cannot dispatch touch", () => {
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeAll(async () => {
    register(NO_CDP, true);
    register(ANSWERS, false);
    server = await createServer({ headless: true, browserType: NO_CDP });
    await server.handlers.open_session({ session: "no-cdp" });
  });

  it("covers all five registrations", () => {
    expect(RETIRED.map((r) => r.tool)).toEqual([
      "touch_start",
      "touch_move",
      "touch_end",
      "gesture_swipe",
      "gesture_pinch",
    ]);
  });

  for (const { tool, args } of RETIRED) {
    it(`${tool} refuses with the engine gate's own error line`, async () => {
      const body = await call(server, tool, args);
      expect(body.ok).toBe(false);
      // CHARACTER-IDENTICAL to `assertEngineSupports`'s error. This is the string
      // an agent or a recorded transcript may already match on, and the deep-flag
      // retirement must not move it.
      expect(body.error).toBe(`tool "${tool}" is not supported on the "${NO_CDP}" engine`);
      expect(body.engine).toBe(NO_CDP);
      expect(typeof body.hint).toBe("string");
      // Actionable: it names the mechanism, says there is no fallback, and says
      // where to re-run.
      expect(body.hint).toContain("Input.dispatchTouchEvent");
      expect(body.hint).toContain("chromium");
    });
  }

  it("the refusal envelope matches the engine gate's, so one classifier covers both", async () => {
    const body = await call(server, "gesture_swipe", RETIRED[3].args);
    expect(Object.keys(body).sort()).toEqual(["engine", "error", "hint", "ok", "tokensEstimate"]);
  });
});

describe("an engine that CAN dispatch touch without CDP now answers", () => {
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeAll(async () => {
    server = await createServer({ headless: true, browserType: ANSWERS });
    await server.handlers.open_session({ session: "answers" });
  });

  for (const { tool, args } of RETIRED) {
    it(`${tool} runs on a Page-free, CDP-free engine`, async () => {
      // Every one of these returned `not supported on the "…" engine` before the
      // flag retired, on an engine whose substrate was perfectly able to answer.
      // That is the blocker RFC 0008 §1 names, measured.
      const body = await call(server, tool, args);
      expect(body.ok, `${tool} still refuses on an engine that implements it`).toBe(true);
      expect(body.error).toBeUndefined();
      expect(body.engine, "a dispatched gesture is not a refusal envelope").toBeUndefined();
    });
  }

  it("reports the touch evidence body, not an empty ok", async () => {
    const body = await call(server, "touch_start", { coords: { x: 1, y: 2 }, identifier: 7 });
    expect(body.action).toBe("start");
    expect(body.identifier).toBe(7);
  });
});
