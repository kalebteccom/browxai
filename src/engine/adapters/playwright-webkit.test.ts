import { describe, it, expect } from "vitest";
import { PlaywrightWebKitAdapter } from "./playwright-webkit.js";
import { WEBKIT_CAPABILITIES } from "../capabilities.js";

// The launch/attach methods drive a real browser and are exercised by the WebKit
// keystone lane (real-WebKit). Here we assert the adapter's pure declarative
// surface — that it tags itself webkit, declares NO deep escape hatch (WebKit has
// no CDP at all), and refuses attach structurally because there is no CDP/BiDi
// attach client for WebKit/Safari.
describe("PlaywrightWebKitAdapter — declarative surface", () => {
  it("identifies as the webkit engine", () => {
    expect(new PlaywrightWebKitAdapter().engine).toBe("webkit");
  });

  it("exposes the webkit capability declaration — all sub-interfaces, NO deep", () => {
    const adapter = new PlaywrightWebKitAdapter();
    expect(adapter.capabilities).toBe(WEBKIT_CAPABILITIES);
    expect(adapter.capabilities.deep).toBe(false);
    expect(adapter.capabilities.subInterfaces.size).toBe(10); // +page (RFC 0004 D5)
  });

  it("exposes the two managed launch shapes the session factories delegate to", () => {
    const adapter = new PlaywrightWebKitAdapter();
    expect(typeof adapter.launchPersistent).toBe("function");
    expect(typeof adapter.launchEphemeral).toBe("function");
  });

  it("refuses attach structurally (webkit-attach-not-supported)", async () => {
    const adapter = new PlaywrightWebKitAdapter();
    await expect(adapter.attach("http://127.0.0.1:9222")).rejects.toThrow(
      /webkit-attach-not-supported/,
    );
  });
});
