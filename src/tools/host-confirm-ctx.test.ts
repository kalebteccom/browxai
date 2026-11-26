// The confirm context a call gets is built from the session it runs in. Exercised
// through the real `buildHost` with stub dependencies, so no browser.

import { describe, it, expect } from "vitest";
import { buildHost, type HostDeps } from "./host-build.js";
import type { SessionEntry } from "../session/registry.js";

function hostOf(): ReturnType<typeof buildHost> {
  return buildHost({
    server: { registerTool: () => undefined },
    toolHandlers: {},
    registry: { list: () => [], peek: () => undefined },
    config: { testAttributes: [] },
    caps: { enabled: new Set(["read", "action"]) },
    confirmHooks: new Set(["byob_action"]),
    originPolicy: { allowed: [], blocked: [] },
    diagnostics: { enabled: false },
    pluginRecords: () => [],
    // No attach endpoint anywhere in the deps: the answer comes from the entry.
    startOptions: { headless: true },
  } as unknown as HostDeps);
}

const entry = (mode: SessionEntry["mode"]): SessionEntry =>
  ({ id: `s-${mode}`, mode, bridge: null }) as unknown as SessionEntry;

describe("confirmCtxFor — the hold follows the session's mode", () => {
  it("marks an attached session, with no server attach endpoint set", () => {
    const ctx = hostOf().confirmCtxFor(entry("attached"));
    expect(ctx.isByob).toBe(true);
    expect(ctx.sessionId).toBe("s-attached");
  });

  it("does not mark a persistent or an incognito session", () => {
    const host = hostOf();
    expect(host.confirmCtxFor(entry("persistent")).isByob).toBe(false);
    expect(host.confirmCtxFor(entry("incognito")).isByob).toBe(false);
  });

  it("carries the server's hooks and the session's bridge", () => {
    const bridge = { humanChannelAvailable: () => false };
    const e = { id: "a", mode: "attached", bridge } as unknown as SessionEntry;
    const ctx = hostOf().confirmCtxFor(e);
    expect([...ctx.hooks]).toEqual(["byob_action"]);
    expect(ctx.bridge).toBe(bridge);
  });
});
