import { describe, it, expect } from "vitest";
import { PlaywrightChromiumAdapter } from "./playwright-chromium.js";
import { CHROMIUM_CAPABILITIES } from "../capabilities.js";

// The launch/attach methods drive a real browser and are exercised by the
// keystone lane (the same real-Chromium path the session factories always
// took). Here we assert the adapter's pure declarative surface — that it tags
// itself chromium and exposes the full capability set, so the engine dimension
// gates nothing in P0.
describe("PlaywrightChromiumAdapter — declarative surface", () => {
  it("exposes the full chromium capability declaration (deep + all sub-interfaces)", () => {
    const adapter = new PlaywrightChromiumAdapter();
    expect(adapter.capabilities).toBe(CHROMIUM_CAPABILITIES);
    expect(adapter.capabilities.deep).toBe(true);
    expect(adapter.capabilities.subInterfaces.size).toBe(11); // +page (RFC 0004 D5), +element (RFC 0009 P2)
  });
});
