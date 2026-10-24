import { describe, it, expect, vi } from "vitest";
import type { BrowserContext, Request, Response } from "playwright-core";
import { PlaywrightNetworkBuffer, bodyReadDecision } from "./network-playwright.js";

describe("bodyReadDecision", () => {
  it("reads a body whose content-length is within the cap", () => {
    expect(bodyReadDecision({ "content-length": "100" }, 1000)).toEqual({ read: true });
    expect(bodyReadDecision({ "content-length": "1000" }, 1000)).toEqual({ read: true });
  });

  it("does not read a body over the cap and reports its size", () => {
    expect(bodyReadDecision({ "content-length": "1001" }, 1000)).toEqual({
      read: false,
      size: 1001,
    });
  });

  it("does not read a body of unknown size", () => {
    expect(bodyReadDecision({}, 1000)).toEqual({ read: false });
    expect(bodyReadDecision({ "content-length": "abc" }, 1000)).toEqual({ read: false });
  });

  it("prefers the transfer size of a finished request", () => {
    expect(bodyReadDecision({}, 1000, 400)).toEqual({ read: true });
    expect(bodyReadDecision({ "content-length": "10" }, 1000, 5000)).toEqual({
      read: false,
      size: 5000,
    });
  });

  it("holds a compressed body to a smaller transfer size", () => {
    const gz = { "content-encoding": "gzip" };
    expect(bodyReadDecision({ ...gz, "content-length": "125" }, 1000)).toEqual({ read: true });
    expect(bodyReadDecision({ ...gz, "content-length": "126" }, 1000)).toEqual({
      read: false,
      size: 126,
    });
    expect(
      bodyReadDecision({ "content-encoding": "identity", "content-length": "900" }, 1000),
    ).toEqual({
      read: true,
    });
  });
});

type Handler = (arg: unknown) => void;

function harness(maxBodyBytes = 1000) {
  const handlers = new Map<string, Handler>();
  const context = {
    on: (event: string, cb: Handler) => handlers.set(event, cb),
  } as unknown as BrowserContext;
  const buffer = new PlaywrightNetworkBuffer(context, 500, 50, maxBodyBytes);
  const respond = (headers: Record<string, string>, body: Buffer) => {
    const request = {
      method: () => "GET",
      url: () => "https://site.test/data",
      resourceType: () => "fetch",
      sizes: () => Promise.resolve({ responseBodySize: -1 }),
    } as unknown as Request;
    const bodyFn = vi.fn(() => Promise.resolve(body));
    const response = {
      request: () => request,
      status: () => 200,
      headers: () => headers,
      body: bodyFn,
    } as unknown as Response;
    handlers.get("request")?.(request);
    handlers.get("response")?.(response);
    return bodyFn;
  };
  const lastId = () => buffer.iter().at(-1)?.requestId ?? "";
  return { buffer, respond, lastId };
}

describe("PlaywrightNetworkBuffer response bodies", () => {
  it("reads no body when nothing asks for one", async () => {
    const h = harness();
    await h.buffer.attach();
    const bodyFn = h.respond({ "content-length": "5" }, Buffer.from("hello"));
    expect(bodyFn).not.toHaveBeenCalled();
  });

  it("reads and returns a body within the cap on request", async () => {
    const h = harness();
    await h.buffer.attach();
    const bodyFn = h.respond({ "content-length": "5" }, Buffer.from("hello"));
    const r = await h.buffer.fetchBody(h.lastId(), null);
    expect(r).toEqual({ ok: true, body: "hello", base64Encoded: false });
    expect(bodyFn).toHaveBeenCalledTimes(1);
  });

  it("does not read a body whose content-length is over the cap", async () => {
    const h = harness(10);
    await h.buffer.attach();
    const bodyFn = h.respond({ "content-length": "11" }, Buffer.from("x".repeat(11)));
    const r = await h.buffer.fetchBody(h.lastId(), null);
    expect(r.ok).toBe(false);
    expect(r.truncated).toBe(true);
    expect(r.error).toContain("11 bytes");
    expect(r.error).toContain("10-byte cap");
    expect(bodyFn).not.toHaveBeenCalled();
  });

  it("does not read a body of unknown size", async () => {
    const h = harness();
    await h.buffer.attach();
    const bodyFn = h.respond({}, Buffer.from("hello"));
    const r = await h.buffer.fetchBody(h.lastId(), null);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not known");
    expect(bodyFn).not.toHaveBeenCalled();
  });

  it("keeps at most bodyCap responses reachable", async () => {
    const handlers = new Map<string, Handler>();
    const context = {
      on: (event: string, cb: Handler) => handlers.set(event, cb),
    } as unknown as BrowserContext;
    const buffer = new PlaywrightNetworkBuffer(context, 500, 2, 1000);
    await buffer.attach();
    for (let i = 0; i < 5; i++) {
      const request = {
        method: () => "GET",
        url: () => `https://site.test/${i}`,
        resourceType: () => "fetch",
      } as unknown as Request;
      const response = {
        request: () => request,
        status: () => 200,
        headers: () => ({ "content-length": "1" }),
        body: () => Promise.resolve(Buffer.from("x")),
      } as unknown as Response;
      handlers.get("request")?.(request);
      handlers.get("response")?.(response);
    }
    const ids = buffer.iter().map((e) => e.requestId!);
    const results = await Promise.all(ids.map((id) => buffer.fetchBody(id, null)));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });
});
