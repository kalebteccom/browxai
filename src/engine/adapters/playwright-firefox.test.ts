import { describe, it, expect } from "vitest";
import {
  PlaywrightFirefoxAdapter,
  firefoxChannelFromEnv,
  MOZ_FIREFOX_CHANNEL,
} from "./playwright-firefox.js";
import { FIREFOX_CAPABILITIES } from "../capabilities.js";

// The launch/attach methods drive a real browser and are exercised by the
// Firefox keystone lane (real-Firefox). Here we assert the adapter's pure
// declarative surface — that it tags itself firefox, declares NO deep escape
// hatch, refuses CDP-attach structurally (Firefox speaks BiDi/Juggler, not
// CDP), and resolves the experimental moz-firefox BiDi channel flag.
describe("PlaywrightFirefoxAdapter — declarative surface", () => {
  it("identifies as the firefox engine", () => {
    expect(new PlaywrightFirefoxAdapter().engine).toBe("firefox");
  });

  it("exposes the firefox capability declaration — all sub-interfaces, NO deep", () => {
    const adapter = new PlaywrightFirefoxAdapter();
    expect(adapter.capabilities).toBe(FIREFOX_CAPABILITIES);
    expect(adapter.capabilities.deep).toBe(false);
    expect(adapter.capabilities.subInterfaces.size).toBe(10); // +page (RFC 0004 D5)
  });

  it("exposes the two managed launch shapes the session factories delegate to", () => {
    const adapter = new PlaywrightFirefoxAdapter();
    expect(typeof adapter.launchPersistent).toBe("function");
    expect(typeof adapter.launchEphemeral).toBe("function");
  });

  it("refuses CDP-attach structurally (firefox-attach-not-supported)", async () => {
    const adapter = new PlaywrightFirefoxAdapter();
    await expect(adapter.attach("http://127.0.0.1:9222")).rejects.toThrow(
      /firefox-attach-not-supported/,
    );
    await expect(adapter.attach("http://127.0.0.1:9222")).rejects.toThrow(/WebDriver BiDi/);
  });
});

describe("firefoxChannelFromEnv — the moz-firefox BiDi flag (Juggler vs BiDi two-track)", () => {
  it("returns undefined for the default Juggler lane (flag unset)", () => {
    expect(firefoxChannelFromEnv({})).toBeUndefined();
    expect(firefoxChannelFromEnv({ BROWX_FIREFOX_CHANNEL: "" })).toBeUndefined();
  });

  it("selects the moz-firefox channel when the flag is set to it", () => {
    expect(firefoxChannelFromEnv({ BROWX_FIREFOX_CHANNEL: MOZ_FIREFOX_CHANNEL })).toBe(
      MOZ_FIREFOX_CHANNEL,
    );
  });

  it("rejects an unknown channel value loudly (no silent fallback)", () => {
    expect(() => firefoxChannelFromEnv({ BROWX_FIREFOX_CHANNEL: "bidi" })).toThrow(
      /unknown value "bidi"/,
    );
  });
});
