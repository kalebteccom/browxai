import { describe, it, expect } from "vitest";
import { SafariWebDriverClient, WebDriverError, type FetchLike } from "./webdriver-client.js";

// Exercises the PURE WebDriver-Classic client — request shaping, the `{value}`
// envelope unwrap, the experimental-cap → ws:// negotiation, and the structured
// error mapping — entirely WITHOUT safaridriver. A mock `FetchLike` records the
// requests and returns canned responses; the real IO half is covered by the
// device-/Safari-gated keystone.

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

/** Build a mock fetch that records calls and replies from a per-path script. */
function mockFetch(routes: (rec: Recorded) => { ok?: boolean; status?: number; value: unknown }): {
  fetchImpl: FetchLike;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const rec: Recorded = {
      url,
      method: init.method,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(rec);
    const r = routes(rec);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => ({ value: r.value }),
    };
  };
  return { fetchImpl, calls };
}

describe("SafariWebDriverClient — session capability negotiation", () => {
  it("requests a BiDi socket with the experimental cap and extracts the ws:// URL", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      value: {
        sessionId: "S1",
        capabilities: { webSocketUrl: "ws://127.0.0.1:8085/session/S1" },
      },
    }));
    const client = new SafariWebDriverClient({ baseUrl: "http://localhost:4444", fetchImpl });
    const res = await client.newSession({ webSocketUrl: true, experimentalWebSocketUrl: true });

    expect(res.sessionId).toBe("S1");
    expect(res.webSocketUrl).toBe("ws://127.0.0.1:8085/session/S1");
    // The request carries BOTH caps — the experimental one is what opens the socket.
    expect(calls[0]?.body).toEqual({
      capabilities: {
        alwaysMatch: {
          browserName: "safari",
          webSocketUrl: true,
          "safari:experimentalWebSocketUrl": true,
        },
      },
    });
  });

  it("treats a boolean webSocketUrl placeholder as NO BiDi socket (Classic-only)", async () => {
    const { fetchImpl } = mockFetch(() => ({
      value: { sessionId: "S2", capabilities: { webSocketUrl: true } },
    }));
    const client = new SafariWebDriverClient({ baseUrl: "http://localhost:4444", fetchImpl });
    const res = await client.newSession({ webSocketUrl: true });
    // A boolean (not a ws:// string) means the experimental cap did not take.
    expect(res.webSocketUrl).toBeUndefined();
  });

  it("omits the cap keys when a plain session is requested", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      value: { sessionId: "S3", capabilities: {} },
    }));
    const client = new SafariWebDriverClient({ baseUrl: "http://localhost:4444", fetchImpl });
    await client.newSession();
    expect(calls[0]?.body).toEqual({
      capabilities: { alwaysMatch: { browserName: "safari" } },
    });
  });
});

describe("SafariWebDriverClient — element + exec surface", () => {
  it("extracts the W3C element key from findElement and maps no-such-element to null", async () => {
    const found = mockFetch(() => ({
      value: { "element-6066-11e4-a52e-4f735466cecf": "EL-9" },
    }));
    const c1 = new SafariWebDriverClient({ baseUrl: "http://x", fetchImpl: found.fetchImpl });
    expect(await c1.findElement("S", "css selector", "h1")).toBe("EL-9");

    const missing = mockFetch(() => ({
      ok: false,
      status: 404,
      value: { error: "no such element", message: "not found" },
    }));
    const c2 = new SafariWebDriverClient({ baseUrl: "http://x", fetchImpl: missing.fetchImpl });
    expect(await c2.findElement("S", "css selector", ".nope")).toBeNull();
  });

  it("sends both text and the legacy value array for sendKeys", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ value: null }));
    const c = new SafariWebDriverClient({ baseUrl: "http://x", fetchImpl });
    await c.elementValue("S", "EL", "hi");
    expect(calls[0]?.url).toBe("http://x/session/S/element/EL/value");
    expect(calls[0]?.body).toEqual({ text: "hi", value: ["h", "i"] });
  });

  it("passes script + args straight through to execute/sync and returns the value", async () => {
    const { fetchImpl, calls } = mockFetch((rec) => ({
      value: (rec.body as { args: unknown[] }).args[0],
    }));
    const c = new SafariWebDriverClient({ baseUrl: "http://x", fetchImpl });
    const out = await c.executeScript("S", "return arguments[0]", [{ ok: 1 }]);
    expect(out).toEqual({ ok: 1 });
    expect(calls[0]?.url).toBe("http://x/session/S/execute/sync");
  });
});

describe("SafariWebDriverClient — structured errors", () => {
  it("throws a WebDriverError on an error envelope", async () => {
    const { fetchImpl } = mockFetch(() => ({
      ok: false,
      status: 500,
      value: { error: "javascript error", message: "boom" },
    }));
    const c = new SafariWebDriverClient({ baseUrl: "http://x", fetchImpl });
    await expect(c.executeScript("S", "throw 1")).rejects.toBeInstanceOf(WebDriverError);
  });

  it("status() never throws — returns ready:false when the driver is unreachable", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const c = new SafariWebDriverClient({ baseUrl: "http://x", fetchImpl });
    expect(await c.status()).toEqual({ ready: false, message: "unreachable" });
  });
});
