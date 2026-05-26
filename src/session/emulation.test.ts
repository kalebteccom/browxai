// Unit tests for per-primitive emulation appliers + reapply-all.
//
// Each of the 7 primitives has a runtime-vs-context-time choice; this file
// asserts both happy paths and the reset semantics, and that `reapplyAll`
// re-issues every set knob (the "new tab in the same context" path).

import { describe, it, expect, vi } from "vitest";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import {
  newEmulationState,
  reapplyAll,
  applyLocaleCdp,
  clearLocaleCdp,
  applyTimezoneCdp,
  clearTimezoneCdp,
  applyGeolocation,
  clearGeolocation,
  applyColorScheme,
  applyReducedMotion,
  applyUserAgentCdp,
  clearUserAgentCdp,
  applyPermissions,
  clearPermissions,
  BYOB_EMULATION_WARNING,
  type EmulationState,
} from "./emulation.js";

// --- fakes ----------------------------------------------------------------

interface FakeCdp {
  send: ReturnType<typeof vi.fn>;
}
interface FakeContext {
  setGeolocation: ReturnType<typeof vi.fn>;
  grantPermissions: ReturnType<typeof vi.fn>;
  clearPermissions: ReturnType<typeof vi.fn>;
  newCDPSession: ReturnType<typeof vi.fn>;
}
interface FakePage {
  emulateMedia: ReturnType<typeof vi.fn>;
}

function fakeCdp(): FakeCdp {
  return { send: vi.fn(async () => undefined) };
}
function fakeContext(): FakeContext {
  return {
    setGeolocation: vi.fn(async () => undefined),
    grantPermissions: vi.fn(async () => undefined),
    clearPermissions: vi.fn(async () => undefined),
    newCDPSession: vi.fn(async () => fakeCdp()),
  };
}
function fakePage(): FakePage {
  return { emulateMedia: vi.fn(async () => undefined) };
}

const asCdp = (c: FakeCdp) => c as unknown as CDPSession;
const asContext = (c: FakeContext) => c as unknown as BrowserContext;
const asPage = (p: FakePage) => p as unknown as Page;

// --- per-primitive --------------------------------------------------------

describe("locale (CDP-only mid-session)", () => {
  it("apply sends Emulation.setLocaleOverride with the locale", async () => {
    const cdp = fakeCdp();
    await applyLocaleCdp(asCdp(cdp), "en-GB");
    expect(cdp.send).toHaveBeenCalledWith("Emulation.setLocaleOverride", { locale: "en-GB" });
  });

  it("clear sends Emulation.setLocaleOverride with empty string", async () => {
    const cdp = fakeCdp();
    await clearLocaleCdp(asCdp(cdp));
    expect(cdp.send).toHaveBeenCalledWith("Emulation.setLocaleOverride", { locale: "" });
  });
});

describe("timezone (CDP-only mid-session)", () => {
  it("apply sends Emulation.setTimezoneOverride", async () => {
    const cdp = fakeCdp();
    await applyTimezoneCdp(asCdp(cdp), "America/New_York");
    expect(cdp.send).toHaveBeenCalledWith("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
  });

  it("clear sends the override with empty timezoneId", async () => {
    const cdp = fakeCdp();
    await clearTimezoneCdp(asCdp(cdp));
    expect(cdp.send).toHaveBeenCalledWith("Emulation.setTimezoneOverride", { timezoneId: "" });
  });
});

describe("geolocation (Playwright context mutator)", () => {
  it("apply calls context.setGeolocation with coords + default accuracy", async () => {
    const ctx = fakeContext();
    await applyGeolocation(asContext(ctx), { latitude: 40.7, longitude: -74 });
    expect(ctx.setGeolocation).toHaveBeenCalledWith({ latitude: 40.7, longitude: -74, accuracy: 0 });
  });

  it("apply preserves explicit accuracy", async () => {
    const ctx = fakeContext();
    await applyGeolocation(asContext(ctx), { latitude: 1, longitude: 2, accuracy: 50 });
    expect(ctx.setGeolocation).toHaveBeenCalledWith({ latitude: 1, longitude: 2, accuracy: 50 });
  });

  it("clear calls context.setGeolocation(null)", async () => {
    const ctx = fakeContext();
    await clearGeolocation(asContext(ctx));
    expect(ctx.setGeolocation).toHaveBeenCalledWith(null);
  });
});

describe("colour scheme (Playwright page mutator)", () => {
  it("apply calls page.emulateMedia({colorScheme})", async () => {
    const page = fakePage();
    await applyColorScheme(asPage(page), "dark");
    expect(page.emulateMedia).toHaveBeenCalledWith({ colorScheme: "dark" });
  });

  it("'no-preference' is a valid pass-through (clears via Playwright semantics)", async () => {
    const page = fakePage();
    await applyColorScheme(asPage(page), "no-preference");
    expect(page.emulateMedia).toHaveBeenCalledWith({ colorScheme: "no-preference" });
  });
});

describe("reduced motion (Playwright page mutator)", () => {
  it("apply calls page.emulateMedia({reducedMotion})", async () => {
    const page = fakePage();
    await applyReducedMotion(asPage(page), "reduce");
    expect(page.emulateMedia).toHaveBeenCalledWith({ reducedMotion: "reduce" });
  });

  it("'no-preference' clears via Playwright semantics", async () => {
    const page = fakePage();
    await applyReducedMotion(asPage(page), "no-preference");
    expect(page.emulateMedia).toHaveBeenCalledWith({ reducedMotion: "no-preference" });
  });
});

describe("user agent (CDP-only mid-session)", () => {
  it("apply sends Network.setUserAgentOverride", async () => {
    const cdp = fakeCdp();
    await applyUserAgentCdp(asCdp(cdp), "MyBot/1.0");
    expect(cdp.send).toHaveBeenCalledWith("Network.setUserAgentOverride", { userAgent: "MyBot/1.0" });
  });

  it("clear sends override with empty UA", async () => {
    const cdp = fakeCdp();
    await clearUserAgentCdp(asCdp(cdp));
    expect(cdp.send).toHaveBeenCalledWith("Network.setUserAgentOverride", { userAgent: "" });
  });
});

describe("permissions", () => {
  it("applyPermissions records by origin and calls Playwright grant", async () => {
    const ctx = fakeContext();
    const state = newEmulationState();
    await applyPermissions(asContext(ctx), state, ["geolocation", "clipboard-read"], "https://example.com");
    expect(ctx.grantPermissions).toHaveBeenCalledWith(["geolocation", "clipboard-read"], { origin: "https://example.com" });
    expect(state.permissions.get("https://example.com")).toEqual(["geolocation", "clipboard-read"]);
  });

  it("applyPermissions without origin keys on '' and omits options arg", async () => {
    const ctx = fakeContext();
    const state = newEmulationState();
    await applyPermissions(asContext(ctx), state, ["notifications"]);
    expect(ctx.grantPermissions).toHaveBeenCalledWith(["notifications"], undefined);
    expect(state.permissions.get("")).toEqual(["notifications"]);
  });

  it("re-applying for the same origin REPLACES (mirrors Playwright semantics)", async () => {
    const ctx = fakeContext();
    const state = newEmulationState();
    await applyPermissions(asContext(ctx), state, ["geolocation"]);
    await applyPermissions(asContext(ctx), state, ["clipboard-read"]);
    expect(state.permissions.get("")).toEqual(["clipboard-read"]);
  });

  it("clearPermissions wipes the state bag AND calls Playwright clearPermissions (context-wide)", async () => {
    const ctx = fakeContext();
    const state = newEmulationState();
    state.permissions.set("https://a.com", ["geolocation"]);
    state.permissions.set("https://b.com", ["notifications"]);
    await clearPermissions(asContext(ctx), state);
    expect(ctx.clearPermissions).toHaveBeenCalled();
    expect(state.permissions.size).toBe(0);
  });

  it("clearPermissions with per-origin arg still wipes everything (platform limit)", async () => {
    const ctx = fakeContext();
    const state = newEmulationState();
    state.permissions.set("https://a.com", ["geolocation"]);
    state.permissions.set("https://b.com", ["notifications"]);
    await clearPermissions(asContext(ctx), state, "https://a.com");
    // Playwright lacks per-origin revocation — caller surfaces this as a warning,
    // and the underlying call is context-wide.
    expect(ctx.clearPermissions).toHaveBeenCalled();
    expect(state.permissions.size).toBe(0);
  });
});

// --- reapplyAll: the persistence-across-new-pages / reconnect path ---------

describe("reapplyAll — persistence across new pages / reconnect", () => {
  it("re-issues every set knob in one pass", async () => {
    const ctx = fakeContext();
    const page = fakePage();
    const cdp = fakeCdp();
    const state: EmulationState = {
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
      geolocation: { latitude: 52.5, longitude: 13.4 },
      colorScheme: "dark",
      reducedMotion: "reduce",
      userAgent: "Bot/2.0",
      permissions: new Map([
        ["", ["geolocation"]],
        ["https://example.com", ["clipboard-read"]],
      ]),
    };
    await reapplyAll(asContext(ctx), asPage(page), asCdp(cdp), state);
    expect(cdp.send).toHaveBeenCalledWith("Emulation.setLocaleOverride", { locale: "de-DE" });
    expect(cdp.send).toHaveBeenCalledWith("Emulation.setTimezoneOverride", { timezoneId: "Europe/Berlin" });
    expect(cdp.send).toHaveBeenCalledWith("Network.setUserAgentOverride", { userAgent: "Bot/2.0" });
    expect(ctx.setGeolocation).toHaveBeenCalledWith({ latitude: 52.5, longitude: 13.4, accuracy: 0 });
    expect(page.emulateMedia).toHaveBeenCalledWith({ colorScheme: "dark" });
    expect(page.emulateMedia).toHaveBeenCalledWith({ reducedMotion: "reduce" });
    expect(ctx.grantPermissions).toHaveBeenCalledWith(["geolocation"], undefined);
    expect(ctx.grantPermissions).toHaveBeenCalledWith(["clipboard-read"], { origin: "https://example.com" });
  });

  it("skips unset knobs (no CDP / Playwright calls for them)", async () => {
    const ctx = fakeContext();
    const page = fakePage();
    const cdp = fakeCdp();
    const state: EmulationState = {
      locale: "ja-JP",
      permissions: new Map(),
    };
    await reapplyAll(asContext(ctx), asPage(page), asCdp(cdp), state);
    expect(cdp.send).toHaveBeenCalledTimes(1);
    expect(cdp.send).toHaveBeenCalledWith("Emulation.setLocaleOverride", { locale: "ja-JP" });
    expect(ctx.setGeolocation).not.toHaveBeenCalled();
    expect(ctx.grantPermissions).not.toHaveBeenCalled();
    expect(page.emulateMedia).not.toHaveBeenCalled();
  });

  it("a single failing applier doesn't abort the others", async () => {
    const ctx = fakeContext();
    const page = fakePage();
    const cdp = fakeCdp();
    cdp.send.mockImplementationOnce(async () => { throw new Error("CDP locale failed"); });
    const state: EmulationState = {
      locale: "fr-FR",
      colorScheme: "dark",
      permissions: new Map(),
    };
    await reapplyAll(asContext(ctx), asPage(page), asCdp(cdp), state);
    expect(page.emulateMedia).toHaveBeenCalledWith({ colorScheme: "dark" });
  });
});

// --- BYOB warning ---------------------------------------------------------

describe("BYOB warning string", () => {
  it("names CDP override + detach-persistence as the sharp edge", () => {
    expect(BYOB_EMULATION_WARNING).toMatch(/CDP/);
    expect(BYOB_EMULATION_WARNING).toMatch(/PERSIST/i);
    expect(BYOB_EMULATION_WARNING).toMatch(/not-owned/);
  });
});
