// `caches_put` stores a response a service worker can hand the page. Without
// `eval` it refuses a document or script content type and stores everything
// else with `X-Content-Type-Options: nosniff`. Browser-free: the policy is a
// pure function, and the handler runs against a stub host whose storage port
// records what it was asked to store.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cachePutHeaders, registerStorageCachesTools } from "./storage-caches-tools.js";
import type { ToolResponse } from "./host.js";

describe("cachePutHeaders", () => {
  it.each([
    "text/javascript",
    "application/javascript; charset=utf-8",
    "text/html",
    "image/svg+xml",
  ])("names %s as executable without eval", (ct) => {
    expect(cachePutHeaders({ "Content-Type": ct }, false)).toEqual({ executable: ct });
  });

  it.each([
    [{ "content-type": "application/json", "Content-Type": "text/javascript" }, "text/javascript"],
    [{ "Content-Type": "text/javascript", "content-type": "application/json" }, "text/javascript"],
    [{ " CONTENT-TYPE ": "text/html" }, "text/html"],
    [{ "content-type": "application/json, text/javascript" }, "application/json, text/javascript"],
    [{ "content-type": "text/javascript, application/json" }, "text/javascript, application/json"],
    [
      { "content-type": " Application/JSON ,TEXT/HTML ;charset=utf-8" },
      " Application/JSON ,TEXT/HTML ;charset=utf-8",
    ],
  ] as Array<[Record<string, string>, string]>)(
    "checks every Content-Type key and every comma-separated part: %o",
    (headers, executable) => {
      expect(cachePutHeaders(headers, false)).toEqual({ executable });
    },
  );

  it("replaces an x-content-type-options key whatever its casing or spacing", () => {
    expect(
      cachePutHeaders(
        { "content-type": "application/json", " X-Content-Type-Options ": "x" },
        false,
      ),
    ).toEqual({
      headers: { "content-type": "application/json", "x-content-type-options": "nosniff" },
    });
  });

  it("keeps a non-executable comma-separated value and adds nosniff", () => {
    expect(cachePutHeaders({ "content-type": "application/json, text/plain" }, false)).toEqual({
      headers: {
        "content-type": "application/json, text/plain",
        "x-content-type-options": "nosniff",
      },
    });
  });

  it("adds nosniff to every other response, replacing a caller's value", () => {
    expect(cachePutHeaders(undefined, false)).toEqual({
      headers: { "x-content-type-options": "nosniff" },
    });
    expect(
      cachePutHeaders({ "content-type": "application/json", "X-Content-Type-Options": "x" }, false),
    ).toEqual({
      headers: { "content-type": "application/json", "x-content-type-options": "nosniff" },
    });
  });

  it("stores the caller's headers as given with eval", () => {
    const headers = { "content-type": "text/javascript" };
    expect(cachePutHeaders(headers, true)).toEqual({ headers });
  });
});

type Handler = (args: Record<string, unknown>) => Promise<ToolResponse>;

function caching(enabled: readonly string[]) {
  const h: Record<string, Handler> = {};
  const stored: Array<{ headers?: Record<string, string> }> = [];
  const host = {
    z,
    register: (name: string, _def: unknown, handler: Handler) => {
      h[name] = handler;
    },
    gateCheck: (_tool: string, extra?: readonly string[], reason?: string) => {
      const missing = (extra ?? []).find((c) => !enabled.includes(c));
      if (!missing) return null;
      const text = JSON.stringify({ ok: false, requiredCapability: missing, reason });
      return { content: [{ type: "text", text }] };
    },
    subInterfaceGate: () => null,
    entryFor: async () => ({ id: "s" }),
    okText: (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body) }] }),
    errText: (_t: string, err: unknown) => ({
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }],
    }),
    storageFor: () => ({
      cachesPut: async (args: { response: { headers?: Record<string, string> } }) => {
        stored.push(args.response);
        return { ok: true };
      },
    }),
    cfgActionTimeout: () => 5_000,
  };
  registerStorageCachesTools(host as never);
  return { put: h.caches_put!, stored };
}

const bodyOf = (r: ToolResponse) =>
  JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;

describe("caches_put", () => {
  const args = (ct: string) => ({
    cacheName: "app",
    url: "https://app.example/app.js",
    response: { headers: { "content-type": ct }, body: "x" },
  });

  it("refuses a script content type without eval and stores nothing", async () => {
    const { put, stored } = caching(["read", "action"]);
    const body = bodyOf(await put(args("text/javascript")));
    expect(body.requiredCapability).toBe("eval");
    expect(body.reason).toMatch(/service worker could hand the page/);
    expect(stored).toEqual([]);
  });

  it("refuses duplicate Content-Type keys when any one is executable, and stores nothing", async () => {
    const { put, stored } = caching(["read", "action"]);
    const body = bodyOf(
      await put({
        cacheName: "app",
        url: "https://app.example/app.js",
        response: {
          headers: { "content-type": "application/json", "Content-Type": "text/javascript" },
          body: "x",
        },
      }),
    );
    expect(body.requiredCapability).toBe("eval");
    expect(stored).toEqual([]);
  });

  it("refuses a comma-separated value with an executable part", async () => {
    const { put, stored } = caching(["read", "action"]);
    const body = bodyOf(await put(args("application/json, text/javascript")));
    expect(body.requiredCapability).toBe("eval");
    expect(stored).toEqual([]);
  });

  it("stores a JSON response with nosniff without eval", async () => {
    const { put, stored } = caching(["read", "action"]);
    expect(bodyOf(await put(args("application/json"))).ok).toBe(true);
    expect(stored[0]?.headers).toEqual({
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
    });
  });

  it("stores a script as given with eval", async () => {
    const { put, stored } = caching(["read", "action", "eval"]);
    expect(bodyOf(await put(args("text/javascript"))).ok).toBe(true);
    expect(stored[0]?.headers).toEqual({ "content-type": "text/javascript" });
  });
});
