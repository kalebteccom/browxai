// L5 (substitutable adapters) — every adapter honors its declared port contract.
//
// The Safari LSP leak (D5): `BrowserSession.page(): Page` is documented as
// throwing (src/session/types.ts:93-99) and actually throws on Safari
// (safari-no-playwright-page) — a present-but-unconditionally-throwing port
// method, the forbidden L5 state, which forced the 17 scattered
// `sess.engine !== "safari"` guards in session-registry.ts.
//
// This contract test runs over EVERY declared engine. A port method is either
// (a) implemented and returns a value, or (b) DECLARED absent via capabilities
// (so the gate refuses upstream) — never (c) present-but-throwing. P0 lands it
// GREEN and documenting: the active checks assert each engine has a coherent
// capability declaration (the seam D5 will tighten); the page-availability
// declaration≡reality assertion is a `describe.todo` because the `"page"`
// sub-interface and its reader land with D5.

import { describe, it, expect } from "vitest";
import { capabilitiesFor, ENGINE_KINDS } from "../../src/engine/index.js";
import type { EngineCapabilities } from "../../src/engine/index.js";

describe("L5 — every adapter honors its declared port contract", () => {
  it.each(ENGINE_KINDS)(
    "[%s] has a capability declaration with the universal sub-interfaces",
    (engine) => {
      const caps = capabilitiesFor(engine);
      expect(caps, `${engine} has no capability declaration`).toBeDefined();
      // snapshot is universal — every engine, including the no-Playwright-Page
      // Safari, must be able to produce an a11y snapshot.
      expect(caps!.subInterfaces.has("snapshot")).toBe(true);
      // No engine may claim `deep` (the raw-CDP escape hatch) without a real CDP
      // handle — only chromium and the Chrome-on-Android attach declare it.
      if (caps!.deep) {
        expect(["chromium", "android"]).toContain(engine);
      }
    },
  );

  it("no deep engine omits a sub-interface a deep tool needs (declaration coherence)", () => {
    // A deep engine drives the full Playwright surface; it must declare every
    // sub-interface, so a deep tool never reaches a missing port mid-call. This
    // is the upstream-declaration guarantee that replaces downstream throws.
    for (const engine of ENGINE_KINDS) {
      const caps = capabilitiesFor(engine);
      if (caps?.deep) {
        for (const sub of ["lifecycle", "navigation", "snapshot", "input"] as const) {
          expect(
            caps.subInterfaces.has(sub),
            `deep engine ${engine} must declare the "${sub}" sub-interface`,
          ).toBe(true);
        }
      }
    }
  });

  // D5 (RFC 0004 P1): page-availability is now a DECLARED capability — the `"page"`
  // sub-interface is present iff the engine backs a real Playwright Page. This is
  // the seam that closes the Safari LSP leak: a no-Page engine omits `"page"`, its
  // post-wire skips every Playwright-only step, and no caller reaches the
  // `page()`-throws fallback. Activated now that the sub-interface exists.
  describe("[D5] page-availability is DECLARED, never a throwing page()", () => {
    // Reads the D5 `"page"` sub-interface; present ⇔ the engine returns a real
    // Playwright Page.
    const hasPagePort = (caps: EngineCapabilities) => caps.subInterfaces.has("page");
    it.each(ENGINE_KINDS)("[%s] declares page-availability matching reality", (engine) => {
      const caps = capabilitiesFor(engine)!;
      // Ground truth: only Safari has no Playwright Page. The `"page"` sub-interface
      // is present iff the engine returns a real Page; this fails if a non-Safari
      // engine loses its Page or Safari ever claims one.
      const hasPlaywrightPage = engine !== "safari";
      expect(hasPagePort(caps)).toBe(hasPlaywrightPage);
    });
  });
});
