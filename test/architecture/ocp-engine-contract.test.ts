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

/** The synthetic engine is Page-FREE. It declares no `"page"` sub-interface and
 *  implements no `page()`, which is the acceptance criterion RFC 0009 states for
 *  this test: the open-closed claim has to hold on an engine that has no
 *  Playwright `Page` at all, not on one holding a fake.
 *
 *  It carried a `fakePage()` until P1. What kept it alive was `snapshot`/`find`
 *  reading `page().url()` / `page().title()` for the header, and `find`'s
 *  best-effort locator probes. P1 moved the first two onto `TargetSubstrate` and
 *  made `find` read the `"page"` DECLARATION before asking for a handle, so an
 *  engine that declares none ranks from the substrate tree and never reaches for
 *  one. A regression that puts a Page read back on any of these paths fails here
 *  with a `TypeError` naming the method, on a test that already runs in
 *  `pnpm test`. */
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
  // No `page`, no `cdp`, no `safari`. Every read the contract drives goes through
  // the engine's in-memory substrates (see _synthetic-engine.ts); requireCdp()
  // and requirePage() both structured-refuse, and the declaration above is the
  // single oracle for both.
  async close(): Promise<void> {}
}

// Activated in P1: the `registerEngine` it dynamically imports now exists. The
// dynamic import inside the body keeps the static graph resolvable in any earlier
// phase; here it resolves the real registry module.
describe("L1 — a new engine adapter plugs in with zero core edits", () => {
  it("registers via registerEngine and drives navigate/snapshot/find/click", async () => {
    // Dynamic import: resolves only when this test runs (P1), never at P0 collection.
    const { registerEngine } = await import("../../src/engine/registry.js"); // lands D1/P1
    const { inMemorySubstrateBundle, SYNTHETIC_TITLE } = await import("./_synthetic-engine.js"); // lands with P1

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
    const row = (listed.sessions as Array<{ id: string; engine: string; url: string | null }>).find(
      (r) => r.id === "synth-a",
    );
    expect(row?.engine).toBe(SYNTH); // the tag is reported correctly
    // RFC 0009 P1: the url column comes from the engine's TargetSubstrate. The
    // fake Page carries no `url()` at all, so a value here can only have come
    // through the port.
    expect(row?.url).toBe("about:blank");

    // Core tools must be engine-agnostic — they reach the substrates, never a raw
    // page() branch. If any handler leaked `engine === "chromium"`, the synthetic
    // engine would diverge here.
    await server.handlers.navigate({ url: "about:blank" });
    const snap = await server.handlers.snapshot({});
    expect(snap.content[0]).toBeTruthy();
    // The snapshot header's url/title likewise come from the TargetSubstrate.
    // Before P1 they were `page().url()` / `page().title()`, which is why the
    // fake Page had to carry them.
    const snapText = (snap.content[0] as { text: string }).text;
    expect(snapText).toContain("about:blank");
    // A sentinel only `InMemoryTargetSubstrate.title()` emits. Asserting on
    // `"synthetic"` here proved nothing: that is the engine tag and the a11y
    // root's name, so the assertion held with the port returning an empty string.
    expect(snapText).toContain(SYNTHETIC_TITLE);
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
