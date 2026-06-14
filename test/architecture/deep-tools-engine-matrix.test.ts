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

import { describe, it, expect } from "vitest";
import {
  assertEngineSupports,
  DEEP_TOOLS,
  ENGINE_KINDS,
  capabilitiesFor,
} from "../../src/engine/index.js";
import { registeredToolNames } from "./_surface.js";

describe("L2/L5 — every deep tool is gated by engine capability, not engine name", () => {
  // 31 deep tools (tool-gate.ts:38-88) × 5 engines. assertEngineSupports
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

describe("L2 — DEEP_TOOLS is complete: every entry is a registered tool", () => {
  it("no DEEP_TOOLS name gates a ghost (every deep tool is registered)", async () => {
    const names = new Set(await registeredToolNames());
    const ghosts = [...DEEP_TOOLS].filter((t) => !names.has(t));
    expect(ghosts, `DEEP_TOOLS names with no registered tool: ${ghosts.join(", ")}`).toEqual([]);
  });
});
