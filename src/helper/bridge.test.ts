import { describe, it, expect } from "vitest";
import { BrowxBridge } from "./bridge.js";

describe("BrowxBridge — W-G2 detach state", () => {
  it("isDetached() is false until detach() runs", async () => {
    const b = new BrowxBridge();
    expect(b.isDetached()).toBe(false);
    await b.detach();
    expect(b.isDetached()).toBe(true);
  });

  it("detach() rejects any outstanding awaitSignal() waiters", async () => {
    const b = new BrowxBridge();
    const pending = b.awaitSignal("never-fires", 0);
    await b.detach();
    await expect(pending).rejects.toThrow(/bridge detached/);
  });

  it("detach() is idempotent — second call is a no-op", async () => {
    const b = new BrowxBridge();
    await b.detach();
    await b.detach();
    expect(b.isDetached()).toBe(true);
  });
});
