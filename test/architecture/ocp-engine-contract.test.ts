// L1 (the closed core) — a new engine adapter plugs in with ZERO core edits.
//
// THE fitness function for the open-closed claim: a synthetic 6th engine,
// defined only in this file, must drive the engine-agnostic core through the
// post-D1 EngineRegistry — with no edit to any session factory (managed.ts /
// incognito.ts / byob.ts), the session registry, host-build.ts, or the tool-gate.
//
// P0 stance (.todo, not .skip-of-a-static-import): `registerEngine`
// (src/engine/registry.ts) does NOT exist until P1. A top-level
// `import { registerEngine } from "../../src/engine/registry.js"` would fail
// MODULE RESOLUTION even under describe.todo (todo skips execution, not the static
// import graph), breaking the P0 collection. So the registry is pulled in via a
// DYNAMIC `await import(...)` INSIDE the test body — P0 never resolves the missing
// module, the gate stays green, and the test activates and goes green in P1 the
// moment registry.ts lands.

import { describe, it, expect } from "vitest";
import type { EngineCapabilities, EngineKind } from "../../src/engine/index.js";
import type { BrowserSession } from "../../src/session/types.js";
import { createServer } from "../../src/server.js";

// A 6th engine that exists ONLY in this test file. If adding it required editing
// any src/session/*.ts or src/tools/host-build.ts, this test could not be written
// without that edit — and the OCP claim would be false. The registration in the
// activated body below is meant to be the ONLY new line a 6th engine needs.
const SYNTH = "synthetic" as EngineKind;

class InMemoryBrowserSession implements BrowserSession {
  readonly mode = "managed" as const; // SessionMode = "managed" | "byob" (session/types.ts:9)
  readonly ownsBrowser = true;
  readonly engine = SYNTH;
  // Carried as an EXTRA field (not a BrowserSession member) so the registration
  // can read `.capabilities`; deep:false ⇒ no CDP escape hatch.
  readonly capabilities: EngineCapabilities = {
    engine: SYNTH,
    subInterfaces: new Set(["lifecycle", "navigation", "snapshot", "input"]),
    deep: false, // no CDP — proves the gate refuses deep tools without a per-engine edit
  };
  // page() backs onto an in-memory fake DOM the contract drives; cdp()/safari()
  // are absent (deep:false), so requireCdp() must structured-refuse.
  page(): never {
    // The in-memory fake Page lands with the activated (P1) body; pre-P1 this
    // class is never instantiated (the describe is .todo), so the stub is inert.
    throw new Error("InMemoryBrowserSession.page(): fake Page lands with the P1 activation");
  }
  async close(): Promise<void> {}
}

// In P0 this lands `.todo` (the `registerEngine` it dynamically imports does not
// exist until D1/P1), so P0 stays gate-green — and because the import is dynamic
// and inside the test body, P0 does not even resolve the missing module; it
// activates and goes green in P1.
describe.todo("L1 — a new engine adapter plugs in with zero core edits", () => {
  it("registers via registerEngine and drives navigate/snapshot/find/click", async () => {
    // Dynamic import: resolves only when this test runs (P1), never at P0 collection.
    const { registerEngine } = await import("../../src/engine/registry.js"); // lands D1/P1
    const { inMemorySubstrateBundle } = await import("./_synthetic-engine.js"); // lands with P1

    // The ONE line that adds an engine. No edit to managed.ts / incognito.ts /
    // byob.ts / session-registry.ts / host-build.ts. This is the documented
    // registry API (0004-03 §1 / 0004-04 P1), not an EngineRegistry.register method.
    registerEngine({
      kind: SYNTH,
      capabilities: new InMemoryBrowserSession().capabilities,
      makeAdapter: async () => new InMemoryBrowserSession(), // Promise<BrowserSession>
      makeSubstrates: () => inMemorySubstrateBundle(), // all 7 SubstrateBundle fields, in-memory
      postWire: () => {}, // the synthetic engine needs no extra bookkeeping
    });

    // Select the synthetic engine the only way the surface allows: at the SERVER
    // level (createServer's opts.browserType, server.ts:284). open_session has no
    // `browserType` — the engine is the server's, the session inherits it.
    const server = await createServer({ headless: true, browserType: SYNTH });
    const open = await server.handlers.open_session({ session: "synth-a" });
    const session = JSON.parse((open.content[0] as { text: string }).text);
    expect(session.engine).toBe(SYNTH); // the tag is reported correctly

    // Core tools must be engine-agnostic — they reach the substrates, never a raw
    // page() branch. If any handler leaked `engine === "chromium"`, the synthetic
    // engine would diverge here.
    await server.handlers.navigate({ url: "about:blank" });
    const snap = await server.handlers.snapshot({});
    expect(snap.content[0]).toBeTruthy();
    await server.handlers.find({ query: "button" });
    await server.handlers.click({ ref: "r1" });

    // deep:false ⇒ a CDP-hard tool structured-refuses, no per-engine gate edit.
    const refusal = JSON.parse(
      (await server.handlers.perf_start({}).then((r) => r.content[0] as { text: string })).text,
    );
    expect(refusal.ok).toBe(false);
    expect(refusal.error).toMatch(/not supported on the "synthetic" engine/);
  });
});
