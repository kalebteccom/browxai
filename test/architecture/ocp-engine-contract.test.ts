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
import type { Page } from "playwright-core";
import type { EngineCapabilities, EngineKind } from "../../src/engine/index.js";
import type { BrowserSession } from "../../src/session/types.js";
import { createServer } from "../../src/server.js";

// A 6th engine that exists ONLY in this test file. If adding it required editing
// any src/session/*.ts or src/tools/host-build.ts, this test could not be written
// without that edit — and the OCP claim would be false. The registration in the
// activated body below is meant to be the ONLY new line a 6th engine needs.
const SYNTH = "synthetic" as EngineKind;

/** A minimal Playwright-`Page`-shaped fake the in-memory engine returns. The core
 *  snapshot/find path reads `url()` / `title()` (the snapshot header) and probes
 *  `locator(...)` (find's disambiguation/bbox/actionability — all best-effort,
 *  try/caught). The locator stub rejects every probe so find falls back to the
 *  bare hint + null bbox, exactly as the no-Playwright-Page path does. */
function fakePage(): Page {
  const refuse = () => Promise.reject(new Error("synthetic engine: no real locator"));
  const locator = () => ({
    count: refuse,
    isEnabled: refuse,
    isVisible: refuse,
    boundingBox: refuse,
    first() {
      return this;
    },
  });
  return {
    url: () => "about:blank",
    title: () => Promise.resolve("synthetic"),
    locator,
  } as unknown as Page;
}

class InMemoryBrowserSession implements BrowserSession {
  readonly mode = "managed" as const; // SessionMode = "managed" | "byob" (session/types.ts:9)
  readonly ownsBrowser = true;
  readonly engine = SYNTH;
  private readonly fake = fakePage();
  // Carried as an EXTRA field (not a BrowserSession member) so the registration
  // can read `.capabilities`; deep:false ⇒ no CDP escape hatch.
  readonly capabilities: EngineCapabilities = {
    engine: SYNTH,
    subInterfaces: new Set(["lifecycle", "navigation", "snapshot", "input"]),
    deep: false, // no CDP — proves the gate refuses deep tools without a per-engine edit
  };
  // page() backs onto an in-memory fake the contract drives (the snapshot header +
  // find's best-effort locator probes); cdp()/safari() are absent (deep:false), so
  // requireCdp() must structured-refuse and the snapshot/action substrates are the
  // engine's in-memory ones (see _synthetic-engine.ts).
  page(): Page {
    return this.fake;
  }
  async close(): Promise<void> {}
}

// Activated in P1: the `registerEngine` it dynamically imports now exists. The
// dynamic import inside the body keeps the static graph resolvable in any earlier
// phase; here it resolves the real registry module.
describe("L1 — a new engine adapter plugs in with zero core edits", () => {
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
      // `deps` is the composition root's per-server SubstrateDeps; the in-memory
      // substrates need no host config, so the synthetic engine ignores them.
      makeSubstrates: (deps) => inMemorySubstrateBundle(deps), // all 7 SubstrateBundle fields, in-memory
      postWire: () => {}, // the synthetic engine needs no extra bookkeeping (ignores deps)
    });

    // Select the synthetic engine the only way the surface allows: at the SERVER
    // level (createServer's opts.browserType, server.ts:284). open_session has no
    // `browserType` — the engine is the server's, the session inherits it.
    const server = await createServer({ headless: true, browserType: SYNTH });
    const open = await server.handlers.open_session({ session: "synth-a" });
    const session = JSON.parse((open.content[0] as { text: string }).text);
    expect(session.ok).toBe(true); // the synthetic session opened with zero core edits
    // The engine tag is reported correctly through the real surface that carries it
    // (`list_sessions` reports `engine` per row — open_session's envelope omits it).
    const listed = JSON.parse((await server.handlers.list_sessions({})).content[0]!.text as string);
    const row = (listed.sessions as Array<{ id: string; engine: string }>).find(
      (r) => r.id === "synth-a",
    );
    expect(row?.engine).toBe(SYNTH); // the tag is reported correctly

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
