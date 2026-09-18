// L2/L5 — every DEEP_TOOLS member is gated by an engine's declared `deep`
// capability, not by an engine NAME, across the full EngineKind × DEEP_TOOLS
// matrix.
//
// Two complementary angles, both keyed off real exported values:
//
//   1. The engine matrix (assertEngineSupports across every engine × every deep
//      tool): a deep engine (`deep: true` — chromium, android) runs every deep
//      tool; a non-deep engine (firefox, webkit, safari) structured-refuses each
//      one. Closes the engine-adapters gap "no suite validates every DEEP_TOOLS
//      entry is unavailable on Firefox/WebKit".
//
//   2. Derived completeness (every DEEP_TOOLS entry is a registered tool name):
//      the gate cannot drift to a ghost — a deep tool that was renamed or removed
//      but left in DEEP_TOOLS fails here.
//
// Complementary to src/engine/tool-gate.test.ts: that suite asserts the per-engine
// refusal text and the chromium/android allow path on hand-picked tools; this
// architecture version drives the FULL matrix parametrically and adds the
// registration-completeness angle the gate-local test does not cover.

import { describe, it, expect, beforeAll } from "vitest";
// RFC 0004 P2: DEEP_TOOLS is DERIVED from the colocated `host.register({ deep })`
// metadata, populated by the tools-layer bootstrap's lazy collector. Loading it
// installs the collector so a synchronous `DEEP_TOOLS` read (the size assertion)
// is populated regardless of test order.
import "../../src/tools/tool-metadata.js";
import {
  assertEngineSupports,
  DEEP_TOOLS,
  ENGINE_KINDS,
  capabilitiesFor,
} from "../../src/engine/index.js";
import { registeredToolNames, toolRegistrations } from "./_surface.js";

beforeAll(async () => {
  // Force the derivation once so every assertion (incl. the synchronous size and
  // matrix checks) sees the fully-populated derived set.
  await toolRegistrations();
});

describe("L2/L5 — every deep tool is gated by engine capability, not engine name", () => {
  // Every deep tool × 5 engines. assertEngineSupports
  // (tool-gate.ts:131) returns a structured refusal on a non-deep engine and null
  // on a deep one — keyed on the engine's declared `deep`, never its name.
  it.each(ENGINE_KINDS)("[%s] gates all deep tools by its declared `deep`", (engine) => {
    const deep = capabilitiesFor(engine)?.deep ?? false;
    for (const tool of DEEP_TOOLS) {
      const refusal = assertEngineSupports(tool, engine);
      if (deep) {
        expect(refusal, `${tool} should run on deep engine ${engine}`).toBeNull();
      } else {
        expect(refusal, `${tool} should refuse on non-deep engine ${engine}`).not.toBeNull();
        expect(refusal!.error).toBe(`tool "${tool}" is not supported on the "${engine}" engine`);
      }
    }
  });
});

describe("L2 — DEEP_TOOLS is derived from the registrations", () => {
  it("no DEEP_TOOLS name gates a ghost (every deep tool is registered)", async () => {
    const names = new Set(await registeredToolNames());
    const ghosts = [...DEEP_TOOLS].filter((t) => !names.has(t));
    expect(ghosts, `DEEP_TOOLS names with no registered tool: ${ghosts.join(", ")}`).toEqual([]);
  });

  it("the derived set is exactly the `{ deep: true }` registrations", async () => {
    // RFC 0004 P2 (D2): DEEP_TOOLS is derived from each `register({ deep: true })`
    // call. A new CDP-dependent tool now self-declares and auto-gates rather than
    // being remembered in a hand-maintained checklist.
    const table = await toolRegistrations();
    const flagged = new Set([...table].filter(([, m]) => m.deep).map(([name]) => name));
    const onlyInSet = [...DEEP_TOOLS].filter((t) => !flagged.has(t));
    const onlyFlagged = [...flagged].filter((t) => !DEEP_TOOLS.has(t));
    expect(onlyInSet, "in DEEP_TOOLS but not flagged deep").toEqual([]);
    expect(onlyFlagged, "flagged deep but missing from DEEP_TOOLS").toEqual([]);
  });

  it("the derived set equals the current snapshot size (31 at P0, 26 after RFC 0009 P3)", () => {
    // 31 → 26. RFC 0009 P3 retired the flag on the five touch/gesture
    // registrations named in RETIRED_BY_SUBSTRATE below. Lowering this number is
    // only ever legitimate alongside the assertions in the next block, which show
    // the tools are still refused on the same engines for the same reason.
    expect(DEEP_TOOLS.size).toBe(26);
  });
});

/** The five registrations RFC 0009 P3 took `deep: true` off, and the tools they
 *  are. Named here, not counted: the size assertion above would go green on any
 *  five removals, and these are the five. */
const RETIRED_BY_SUBSTRATE = [
  "touch_start",
  "touch_move",
  "touch_end",
  "gesture_swipe",
  "gesture_pinch",
] as const;

describe("L2/L5 — the five touch tools left DEEP_TOOLS without widening any engine", () => {
  // WHY THEY LEFT. `deep: true` asks "does this engine have raw CDP?", and the
  // gate answers before the substrate is consulted. Touch is the PRIMARY input on
  // the native engines of RFC 0008, and they have no CDP — so the flag refused a
  // native agent exactly the tools it needs most, on a question that was never
  // the right one. The right question is "can this engine dispatch touch?", and
  // `ActionSubstrate.gesture` is where it is now asked.
  //
  // WHY THAT IS NOT A WIDENING, and where each half is proven:
  //   - the Playwright adapter refuses when the session's ActionContext carries
  //     no CDP accessor, which is exactly the set of engines `caps.deep:false`
  //     described (firefox, webkit) — `src/page/action-substrate.test.ts`;
  //   - the refusal's `error` line is character-identical to the one this gate
  //     produced, and the envelope is the same `{ok, error, engine, hint,
  //     tokensEstimate}` — same file, plus `gesture-engine-refusal.test.ts`
  //     end-to-end through the real server;
  //   - safari refuses in its own adapter — same file.
  // This block holds the third leg: they are gone from the gate, and nothing put
  // them back.

  it.each(RETIRED_BY_SUBSTRATE)("[%s] is no longer gated by the `deep` flag", (tool) => {
    expect(
      DEEP_TOOLS.has(tool),
      `${tool} is back in DEEP_TOOLS. The engine gate refuses it before ` +
        "`ActionSubstrate.gesture` is reached, which is what stopped a no-CDP engine " +
        "from ever dispatching touch. If it genuinely needs raw CDP again, that is an " +
        "RFC 0009 amendment, not a flag.",
    ).toBe(false);
  });

  it.each(ENGINE_KINDS)("[%s] the gate un-gates all five, deep or not", (engine) => {
    // The gate now says nothing about these tools on ANY engine — including the
    // non-deep ones, where it used to be the only thing refusing them. That is
    // the load the substrate picked up.
    for (const tool of RETIRED_BY_SUBSTRATE) {
      expect(assertEngineSupports(tool, engine)).toBeNull();
    }
  });

  it("names five, and the registrations still exist", async () => {
    // The P2 trap: a list a test iterates can shrink without failing. Pin the
    // length, and pin that every name is a live registration — a rename that left
    // this list stale would otherwise assert nothing about anything.
    expect(RETIRED_BY_SUBSTRATE).toHaveLength(5);
    const names = new Set(await registeredToolNames());
    for (const tool of RETIRED_BY_SUBSTRATE) {
      expect(names.has(tool), `${tool} is not a registered tool`).toBe(true);
    }
  });
});
