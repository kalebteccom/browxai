import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { snapshotSubstrateFor } from "./snapshot-substrate-select.js";
import { networkSubstrateFor } from "./network-substrate-select.js";
import { SafariClassicSnapshotSubstrate } from "./snapshot-substrate-safari.js";
import { CdpSnapshotSubstrate, PlaywrightSnapshotSubstrate } from "./snapshot-substrate.js";
import {
  CdpNetworkSubstrate,
  PlaywrightNetworkSubstrate,
  SafariNoopNetworkSubstrate,
} from "./network-substrate.js";
import { registerEngine } from "../engine/registry.js";
import { engineDeclares } from "../engine/sub-interface.js";
import type { EngineKind, SafariSessionHandle } from "../engine/index.js";
import type { CDPSession, Page } from "playwright-core";

// RFC 0009 P1 — the substrate selectors key on the DECLARED `page` sub-interface,
// never on an engine name.
//
// The two selectors used to open with `session.engine === "safari"`, which was a
// second spelling of `caps.subInterfaces.has("page")` (RFC 0004 D5). Two spellings
// of one fact is the L2 violation, and the literal is the spelling that needs a
// new branch per engine — so `ios-app` and `android-app` (RFC 0008) would each
// have cost an edit here.
//
// The proof that the literal is really gone has to come from an engine the
// selectors have never heard of. A synthetic engine registered at runtime with no
// `page` sub-interface takes the no-Page branch on both selectors; the same
// synthetic engine declaring `page` takes the Playwright branch. No string in
// either file names either of them.

const NO_PAGE = "declaration-test-nopage" as EngineKind;
const WITH_PAGE = "declaration-test-withpage" as EngineKind;

const bundle = () => ({}) as never;
registerEngine({
  kind: NO_PAGE,
  capabilities: {
    engine: NO_PAGE,
    subInterfaces: new Set(["lifecycle", "navigation", "snapshot", "input"]),
    deep: false,
  },
  makeAdapter: () => Promise.reject(new Error("never launched")),
  makeSubstrates: bundle,
  postWire: () => {},
});
registerEngine({
  kind: WITH_PAGE,
  capabilities: {
    engine: WITH_PAGE,
    subInterfaces: new Set(["lifecycle", "navigation", "snapshot", "input", "page", "network"]),
    deep: false,
  },
  makeAdapter: () => Promise.reject(new Error("never launched")),
  makeSubstrates: bundle,
  postWire: () => {},
});

/** A Safari-shaped native handle: the two WebDriver endpoints the no-Page
 *  snapshot substrate is wired from. */
function nativeHandle(): SafariSessionHandle {
  return {
    sessionId: "SID",
    webDriver: { executeScript: () => Promise.resolve([]), currentUrl: () => Promise.resolve("") },
  } as unknown as SafariSessionHandle;
}

/** A Page fake that fails loudly. Any selector branch that reaches for a Page on
 *  a no-Page engine must blow up here rather than degrade quietly. */
function forbiddenPage(): () => Page {
  return () => {
    throw new Error("selector reached for a Page on an engine that declares none");
  };
}

describe("substrate selection keys on the declared `page` sub-interface", () => {
  it("routes an unknown engine that declares no `page` to the no-Page substrates", () => {
    const session = {
      engine: NO_PAGE,
      page: forbiddenPage(),
      safari: nativeHandle,
    };
    // The engine is synthetic, registered at runtime, and named nowhere in either
    // selector — the declaration is the only thing steering this.
    expect(engineDeclares(NO_PAGE, "page")).toBe(false);
    expect(snapshotSubstrateFor(session)).toBeInstanceOf(SafariClassicSnapshotSubstrate);
    expect(networkSubstrateFor(session)).toBeInstanceOf(SafariNoopNetworkSubstrate);
  });

  it("routes an unknown engine that DOES declare `page` to the Playwright substrates", () => {
    const page = {
      context: () => ({ on: () => undefined }),
      on: () => undefined,
    } as unknown as Page;
    const session = { engine: WITH_PAGE, page: () => page };
    expect(engineDeclares(WITH_PAGE, "page")).toBe(true);
    expect(snapshotSubstrateFor(session)).toBeInstanceOf(PlaywrightSnapshotSubstrate);
    expect(networkSubstrateFor(session)).toBeInstanceOf(PlaywrightNetworkSubstrate);
  });

  it("prefers the CDP substrates when the engine exposes the raw handle", () => {
    const page = {
      context: () => ({ on: () => undefined }),
      on: () => undefined,
    } as unknown as Page;
    const cdp = { on: () => undefined, send: () => Promise.resolve({}) } as unknown as CDPSession;
    const session = { engine: WITH_PAGE, page: () => page, cdp: () => cdp };
    expect(snapshotSubstrateFor(session)).toBeInstanceOf(CdpSnapshotSubstrate);
    expect(networkSubstrateFor(session)).toBeInstanceOf(CdpNetworkSubstrate);
  });

  it("never calls page() on an engine that declares none", () => {
    let reached = false;
    const session = {
      engine: NO_PAGE,
      page: () => {
        reached = true;
        throw new Error("unreachable");
      },
      safari: nativeHandle,
    };
    snapshotSubstrateFor(session);
    networkSubstrateFor(session);
    expect(reached).toBe(false);
  });

  it("contains no EngineKind literal in either selector module", () => {
    // The lint rule (`no-engine-literal-branches`) enforces this too — both files
    // came off `ENGINE_SELECT_ALLOWLIST` in this phase. Asserting it here as well
    // means the ratchet cannot be quietly undone by putting the entry back.
    const here = dirname(fileURLToPath(import.meta.url));
    const kinds = ["chromium", "firefox", "webkit", "android", "safari"];
    for (const file of ["snapshot-substrate-select.ts", "network-substrate-select.ts"]) {
      const src = readFileSync(join(here, file), "utf8");
      // Comments legitimately discuss the engines by name; only code is at issue,
      // and an engine literal in code is a quoted string.
      const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const kind of kinds) {
        expect(code, `${file} branches on the "${kind}" literal`).not.toContain(`"${kind}"`);
      }
    }
  });
});
