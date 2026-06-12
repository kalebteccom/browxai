import { describe, it, expect } from "vitest";
import { PlaywrightChromiumAdapter } from "./playwright-chromium.js";
import { CHROMIUM_CAPABILITIES } from "../capabilities.js";

// The launch/attach methods drive a real browser and are exercised by the
// keystone lane (the same real-Chromium path the session factories always
// took). Here we assert the adapter's pure declarative surface — that it tags
// itself chromium and exposes the full capability set, so the engine dimension
// gates nothing in P0.
describe("PlaywrightChromiumAdapter — declarative surface", () => {
  it("identifies as the chromium engine", () => {
    const adapter = new PlaywrightChromiumAdapter();
    expect(adapter.engine).toBe("chromium");
  });

  it("exposes the full chromium capability declaration (deep + all sub-interfaces)", () => {
    const adapter = new PlaywrightChromiumAdapter();
    expect(adapter.capabilities).toBe(CHROMIUM_CAPABILITIES);
    expect(adapter.capabilities.deep).toBe(true);
    expect(adapter.capabilities.subInterfaces.size).toBe(9);
  });

  it("exposes the three launch shapes the session factories delegate to", () => {
    const adapter = new PlaywrightChromiumAdapter();
    expect(typeof adapter.launchPersistent).toBe("function");
    expect(typeof adapter.launchEphemeral).toBe("function");
    expect(typeof adapter.attachOverCdp).toBe("function");
  });
});
