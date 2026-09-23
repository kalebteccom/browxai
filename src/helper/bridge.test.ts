import { describe, it, expect } from "vitest";
import { BrowxBridge } from "./bridge.js";

describe("BrowxBridge — detach state", () => {
  it("isDetached() is false until detach() runs", async () => {
    const b = new BrowxBridge();
    expect(b.isDetached()).toBe(false);
    await b.detach();
    expect(b.isDetached()).toBe(true);
  });

  it("awaitSignal() refuses at once when no page carries the human channel", async () => {
    // An unattached bridge stands in for an engine without CDP: there is no
    // isolated world to answer from, so a caller must not be left waiting.
    const b = new BrowxBridge();
    expect(b.humanChannelAvailable()).toBe(false);
    await expect(b.awaitSignal("respond", 0)).rejects.toThrow(/^no-human-channel:/);
  });

  it("awaitSignal() refuses after detach()", async () => {
    const b = new BrowxBridge();
    await b.detach();
    await expect(b.awaitSignal("proceed", 0)).rejects.toThrow(/no-human-channel/);
  });

  it("detach() is idempotent — second call is a no-op", async () => {
    const b = new BrowxBridge();
    await b.detach();
    await b.detach();
    expect(b.isDetached()).toBe(true);
  });
});
