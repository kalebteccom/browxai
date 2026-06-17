// Per-session engine launch-plan helper. `defaultModeForEngine` is the pure
// policy that decides a session's default mode from its EFFECTIVE (per-session)
// engine — the piece that makes `open_session({engine:"android"})` default to
// attached even on a chromium-default server, while keeping every non-android
// engine byte-identical to the legacy server default. Pure over (engine,
// attachCdp): no browser, no registry.

import { describe, it, expect } from "vitest";
import { defaultModeForEngine } from "./session-registry.js";
import { ENGINE_KINDS } from "../engine/index.js";

describe("defaultModeForEngine — per-session default launch mode", () => {
  it("android is attach-only: defaults to attached regardless of BROWX_ATTACH_CDP", () => {
    expect(defaultModeForEngine("android", undefined)).toBe("attached");
    expect(defaultModeForEngine("android", "http://127.0.0.1:9222")).toBe("attached");
  });

  it.each(["chromium", "firefox", "webkit", "safari"] as const)(
    "%s defaults to persistent with no attach endpoint",
    (engine) => {
      expect(defaultModeForEngine(engine, undefined)).toBe("persistent");
    },
  );

  it.each(["chromium", "firefox", "webkit", "safari"] as const)(
    "%s defaults to attached when BROWX_ATTACH_CDP is set",
    (engine) => {
      expect(defaultModeForEngine(engine, "http://127.0.0.1:9222")).toBe("attached");
    },
  );

  it("is byte-identical to the legacy server default for every engine/attach combo", () => {
    // The legacy server-level rule (createServer): android OR attachCdp => attached,
    // else persistent. For a non-android engine the helper must match it exactly,
    // so omitting `engine` (effectiveEngine === serverEngine) changes nothing.
    const legacy = (engine: string, attachCdp: string | undefined): string =>
      engine === "android" || attachCdp ? "attached" : "persistent";
    for (const engine of ENGINE_KINDS) {
      for (const attachCdp of [undefined, "http://127.0.0.1:9222"]) {
        expect(defaultModeForEngine(engine, attachCdp)).toBe(legacy(engine, attachCdp));
      }
    }
  });
});
