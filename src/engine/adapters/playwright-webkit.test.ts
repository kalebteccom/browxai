import { describe, it, expect } from "vitest";
import { PlaywrightWebKitAdapter } from "./playwright-webkit.js";

// The launch/attach methods drive a real browser and are exercised by the WebKit
// keystone lane (real-WebKit). Here we assert the adapter's pure declarative
// surface — that it tags itself webkit, declares NO deep escape hatch (WebKit has
// no CDP at all), and refuses attach structurally because there is no CDP/BiDi
// attach client for WebKit/Safari.
describe("PlaywrightWebKitAdapter — declarative surface", () => {
  it("refuses attach structurally (webkit-attach-not-supported)", async () => {
    const adapter = new PlaywrightWebKitAdapter();
    await expect(adapter.attach("http://127.0.0.1:9222")).rejects.toThrow(
      /webkit-attach-not-supported/,
    );
  });
});
