import { describe, it, expect } from "vitest";
import {
  PlaywrightFirefoxAdapter,
  firefoxChannelFromEnv,
  MOZ_FIREFOX_CHANNEL,
} from "./playwright-firefox.js";

// The launch/attach methods drive a real browser and are exercised by the
// Firefox keystone lane (real-Firefox). Here we assert the adapter's pure
// declarative surface — that it tags itself firefox, declares NO deep escape
// hatch, refuses CDP-attach structurally (Firefox speaks BiDi/Juggler, not
// CDP), and resolves the experimental moz-firefox BiDi channel flag.
describe("PlaywrightFirefoxAdapter — declarative surface", () => {
  it("refuses CDP-attach structurally (firefox-attach-not-supported)", async () => {
    const adapter = new PlaywrightFirefoxAdapter();
    await expect(adapter.attach("http://127.0.0.1:9222")).rejects.toThrow(
      /firefox-attach-not-supported/,
    );
    await expect(adapter.attach("http://127.0.0.1:9222")).rejects.toThrow(/WebDriver BiDi/);
  });
});

describe("firefoxChannelFromEnv — the moz-firefox BiDi flag (Juggler vs BiDi two-track)", () => {
  it.each([
    { label: "unset flag", env: {}, expected: undefined },
    {
      label: "the moz-firefox value",
      env: { BROWX_FIREFOX_CHANNEL: MOZ_FIREFOX_CHANNEL },
      expected: MOZ_FIREFOX_CHANNEL,
    },
  ])("resolves $label to the Juggler default or the moz-firefox channel", ({ env, expected }) => {
    expect(firefoxChannelFromEnv(env)).toBe(expected);
  });

  it("rejects an unknown channel value loudly (no silent fallback)", () => {
    expect(() => firefoxChannelFromEnv({ BROWX_FIREFOX_CHANNEL: "bidi" })).toThrow(
      /unknown value "bidi"/,
    );
  });
});
