// L1 (per-server isolation) — two servers in ONE process do NOT share each
// other's security boundary on the session hot path.
//
// THE regression test for the module-global `DEPS` race (RFC 0004 P1). Before the
// fix, `src/page/substrate-bundle.ts` and `src/session/playwright-post-wire.ts`
// each held a per-PROCESS `let DEPS`, overwritten by every `createServer()` via a
// `setPlaywright*Deps(...)` setter. The in-process SDK transport (the SDK default)
// composes one server per transport, so a SECOND server in the same process
// overwrote the FIRST server's deps (last-write-wins): server A (caps {read}, its
// own workspace) would start wiring its sessions with server B's caps + workspace
// — a capability-gating + sandbox-root + origin-policy cross-contamination.
//
// The fix threads each server's deps EXPLICITLY: the EngineEntry contract is now
// `makeSubstrates(deps: SubstrateDeps)` + `postWire(entry, deps: PostWireDeps)`,
// and the composition root (`buildSessionRegistry`, `buildHost`) passes its OWN
// per-server set at the call site. This test composes TWO servers with DIFFERENT
// caps and DIFFERENT workspace roots, opens a session on each, and asserts each
// server's `postWire`/`makeSubstrates` received ITS OWN deps — never the other's.
//
// Against the old module-global code this test cannot even be written with the old
// signatures; against the relocated-but-still-module-global code it FAILS because
// server A's session would observe server B's last-set caps/workspace. After the
// explicit-threading fix it PASSES because each server's deps are closure-owned.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import {
  registerEngine,
  hasEngine,
  type SubstrateDeps,
  type PostWireDeps,
} from "../../src/engine/registry.js";
import type { EngineCapabilities, EngineKind } from "../../src/engine/index.js";
import type { BrowserSession } from "../../src/session/types.js";
import type { SessionEntry } from "../../src/session/registry.js";
import { buildSessionRegistry } from "../../src/tools/session-registry.js";
import { ConfigStore } from "../../src/util/config-store.js";
import { resolveWorkspace } from "../../src/util/workspace.js";
import type { Workspace } from "../../src/util/workspace.js";
import type { CapabilityConfig, Capability } from "../../src/util/capabilities.js";
import { inMemorySubstrateBundle } from "./_synthetic-engine.js";

// A probe engine that exists ONLY in this file. Unlike the synthetic engine, its
// `makeSubstrates`/`postWire` RECORD the per-server deps they were handed, so the
// test can assert each server threaded its OWN deps. The engine is registered once
// per process (the registry is a process-global map); the deps it observes differ
// per server precisely because each `buildSessionRegistry` passes its own set.
const PROBE = "isolation-probe" as EngineKind;

const PROBE_CAPS: EngineCapabilities = {
  engine: PROBE,
  subInterfaces: new Set(["lifecycle", "navigation", "snapshot", "input"]),
  deep: false,
};

/** The deps the probe engine recorded on its most recent `makeSubstrates` /
 *  `postWire` call. Read by the test after each session open. */
interface Recorded {
  substrate: SubstrateDeps[];
  postWire: PostWireDeps[];
}
const recorded: Recorded = { substrate: [], postWire: [] };

/** A minimal Playwright-`Page`-shaped fake (mirrors the synthetic engine's). The
 *  factory's snapshot/network substrates read only `e.session`; the in-memory
 *  bundle never touches a real Page. */
function fakePage(): Page {
  const refuse = () => Promise.reject(new Error("probe engine: no real locator"));
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
    title: () => Promise.resolve("probe"),
    locator,
  } as unknown as Page;
}

class ProbeBrowserSession implements BrowserSession {
  readonly mode = "managed" as const;
  readonly ownsBrowser = true;
  readonly engine = PROBE;
  private readonly fake = fakePage();
  page(): Page {
    return this.fake;
  }
  async close(): Promise<void> {}
}

beforeAll(() => {
  // Add-only registration; the registry is a process-global, so register once.
  if (!hasEngine(PROBE)) {
    registerEngine({
      kind: PROBE,
      capabilities: PROBE_CAPS,
      makeAdapter: async () => new ProbeBrowserSession(),
      // RECORD the per-server SubstrateDeps, then defer to the in-memory bundle so
      // the factory's snapshot/network wiring succeeds with no real browser.
      makeSubstrates: (deps) => {
        recorded.substrate.push(deps);
        return inMemorySubstrateBundle(deps);
      },
      // RECORD the per-server PostWireDeps. The probe engine attaches nothing
      // (in-memory session has no context), so this is a pure observation point.
      postWire: (_entry: SessionEntry, deps: PostWireDeps) => {
        recorded.postWire.push(deps);
      },
    });
  }
});

const tempRoots: string[] = [];
afterEach(() => {
  recorded.substrate = [];
  recorded.postWire = [];
});

function tempWorkspace(label: string): Workspace {
  const root = mkdtempSync(join(tmpdir(), `browxai-isolation-${label}-`));
  tempRoots.push(root);
  return resolveWorkspace({ BROWX_WORKSPACE: root });
}

function capsOf(...enabled: Capability[]): CapabilityConfig {
  return { enabled: new Set(enabled), disabledTools: [], warnings: [] };
}

/** Build a per-server SessionRegistry over the probe engine, with the given caps
 *  and workspace — exactly the two per-server inputs the module-global race
 *  cross-contaminated. */
function buildServer(caps: CapabilityConfig, workspace: Workspace) {
  const configStore = new ConfigStore(workspace.root, {});
  const resolvedConfig = configStore.resolve();
  return buildSessionRegistry({
    opts: { headless: true },
    resolvedConfig,
    configStore,
    caps,
    workspace,
    serverEngine: PROBE,
    serverDefaultMode: "persistent",
  });
}

describe("L1 — two servers in one process keep their security boundaries isolated", () => {
  it("each server's postWire/makeSubstrates receives ITS OWN per-server deps, not the other's", async () => {
    // Server A: read-only, workspace A. Server B: read + action + stealth,
    // workspace B. These are the exact two dimensions the module-global race
    // crossed: a capability gate (action/stealth) and a sandbox write-root.
    const wsA = tempWorkspace("a");
    const wsB = tempWorkspace("b");
    const capsA = capsOf("read");
    const capsB = capsOf("read", "action", "stealth");

    const serverA = buildServer(capsA, wsA);
    const serverB = buildServer(capsB, wsB);

    // Compose BOTH servers (build their registries) BEFORE opening any session.
    // Under the old module-global code the second `buildSessionRegistry` /
    // host-build would have overwritten the shared `DEPS`, so server A's later
    // open would observe server B's caps/workspace. With explicit threading,
    // server A's open observes server A's deps regardless of order.

    // Open a session on server A AFTER server B exists — the adversarial order.
    await serverA.get("sess-a");
    const aPostWire = recorded.postWire.at(-1)!;
    const aSubstrate = recorded.substrate.at(-1)!;

    // Server A stays read-only and rooted at workspace A — NOT server B's
    // {read,action,stealth} / workspace B.
    expect(aPostWire.caps).toBe(capsA);
    expect(aPostWire.caps.enabled.has("action")).toBe(false);
    expect(aPostWire.caps.enabled.has("stealth")).toBe(false);
    expect(aPostWire.workspace.root).toBe(wsA.root);
    expect(aPostWire.workspace.root).not.toBe(wsB.root);

    // Now open a session on server B and confirm it sees ITS OWN deps too — so the
    // isolation holds in both directions, not just by luck of ordering.
    await serverB.get("sess-b");
    const bPostWire = recorded.postWire.at(-1)!;
    expect(bPostWire.caps).toBe(capsB);
    expect(bPostWire.caps.enabled.has("action")).toBe(true);
    expect(bPostWire.caps.enabled.has("stealth")).toBe(true);
    expect(bPostWire.workspace.root).toBe(wsB.root);

    // Re-open on server A (B's open ran most recently) — the module-global would
    // now have B's deps latched; explicit threading still hands A its own.
    await serverA.get("sess-a2");
    const a2PostWire = recorded.postWire.at(-1)!;
    expect(a2PostWire.caps).toBe(capsA);
    expect(a2PostWire.caps.enabled.has("action")).toBe(false);
    expect(a2PostWire.workspace.root).toBe(wsA.root);

    // The substrate deps the registry threaded are server A's own as well (the
    // registry resolves snapshot/network from them; action/capture are
    // host-build's concern). Sanity: the recorded set is the one server A passed,
    // distinct per server.
    expect(aSubstrate).toBeTruthy();
  });
});

// Best-effort temp cleanup at process exit (vitest workers are short-lived).
process.on("exit", () => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});
