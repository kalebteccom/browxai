import { describe, it, expect, vi } from "vitest";
import type { Browser } from "playwright-core";
import { acquireConnection, normalizeAttachEndpoint } from "./attach-endpoint.js";

function fakeBrowser(): { browser: Browser; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => undefined);
  const browser = { close, once: () => undefined } as unknown as Browser;
  return { browser, close };
}

describe("normalizeAttachEndpoint", () => {
  it("collapses the interchangeable loopback spellings onto one key", () => {
    const key = normalizeAttachEndpoint("http://127.0.0.1:9222");
    expect(normalizeAttachEndpoint("http://localhost:9222")).toBe(key);
    expect(normalizeAttachEndpoint("http://LOCALHOST:9222/")).toBe(key);
    expect(normalizeAttachEndpoint("http://[::1]:9222")).toBe(key);
  });

  it("keeps distinct ports and paths distinct", () => {
    expect(normalizeAttachEndpoint("http://127.0.0.1:9222")).not.toBe(
      normalizeAttachEndpoint("http://127.0.0.1:9333"),
    );
    expect(normalizeAttachEndpoint("http://127.0.0.1:9222/devtools/browser/abc")).toBe(
      "http://127.0.0.1:9222/devtools/browser/abc",
    );
  });
});

describe("acquireConnection", () => {
  it("connects once per endpoint and shares the browser across sessions", async () => {
    const { browser } = fakeBrowser();
    const connect = vi.fn(() => Promise.resolve(browser));
    const a = await acquireConnection("http://127.0.0.1:9401", connect);
    const b = await acquireConnection("http://localhost:9401", connect);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(b.browser).toBe(a.browser);
    expect(a.endpoint).toBe(b.endpoint);
    await a.release();
    await b.release();
  });

  it("closes the connection only when the last session releases", async () => {
    const { browser, close } = fakeBrowser();
    const connect = () => Promise.resolve(browser);
    const a = await acquireConnection("http://127.0.0.1:9402", connect);
    const b = await acquireConnection("http://127.0.0.1:9402", connect);
    await a.release();
    expect(close).not.toHaveBeenCalled();
    await a.release();
    expect(close).not.toHaveBeenCalled();
    await b.release();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reconnects after the shared connection has been released", async () => {
    const first = fakeBrowser();
    const second = fakeBrowser();
    const connect = vi
      .fn()
      .mockResolvedValueOnce(first.browser)
      .mockResolvedValueOnce(second.browser);
    const a = await acquireConnection("http://127.0.0.1:9403", connect);
    await a.release();
    const b = await acquireConnection("http://127.0.0.1:9403", connect);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(b.browser).toBe(second.browser);
    await b.release();
  });

  it("drops a failed connection so the next attach retries", async () => {
    const { browser } = fakeBrowser();
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(browser);
    await expect(acquireConnection("http://127.0.0.1:9404", connect)).rejects.toThrow(
      /ECONNREFUSED/,
    );
    const retry = await acquireConnection("http://127.0.0.1:9404", connect);
    expect(retry.browser).toBe(browser);
    await retry.release();
  });
});
