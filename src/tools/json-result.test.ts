import { describe, expect, it } from "vitest";
import {
  errorBody,
  errorResult,
  errorResultWithEstimate,
  jsonResult,
  jsonResultWithEstimate,
  jsonToolResult,
} from "./json-result.js";

const text = (r: { content: Array<{ type: "text"; text: string }> }) => {
  expect(r.content).toHaveLength(1);
  expect(r.content[0]!.type).toBe("text");
  return r.content[0]!.text;
};

describe("jsonResult", () => {
  it("pretty-prints the body with two spaces and adds nothing", () => {
    expect(text(jsonResult({ ok: true, n: 1 }))).toBe('{\n  "ok": true,\n  "n": 1\n}');
  });
});

describe("jsonResultWithEstimate", () => {
  it("appends tokensEstimate, a quarter of the compact body length rounded up", () => {
    // `{"ok":true,"n":1}` is 17 characters.
    expect(text(jsonResultWithEstimate({ ok: true, n: 1 }))).toBe(
      '{\n  "ok": true,\n  "n": 1,\n  "tokensEstimate": 5\n}',
    );
  });

  it("overwrites a tokensEstimate the body already carries, in place", () => {
    // `{"tokensEstimate":999,"ok":true}` is 32 characters.
    expect(text(jsonResultWithEstimate({ tokensEstimate: 999, ok: true }))).toBe(
      '{\n  "tokensEstimate": 8,\n  "ok": true\n}',
    );
  });
});

describe("error envelopes", () => {
  it("reads the message of an Error and stringifies anything else", () => {
    expect(errorBody(new Error("boom"))).toEqual({ ok: false, error: "boom" });
    expect(errorBody("plain")).toEqual({ ok: false, error: "plain" });
    expect(errorBody(undefined)).toEqual({ ok: false, error: "undefined" });
  });

  it("renders bare", () => {
    expect(text(errorResult(new Error("boom")))).toBe('{\n  "ok": false,\n  "error": "boom"\n}');
  });

  it("renders with an estimate", () => {
    // `{"ok":false,"error":"boom"}` is 27 characters.
    expect(text(errorResultWithEstimate(new Error("boom")))).toBe(
      '{\n  "ok": false,\n  "error": "boom",\n  "tokensEstimate": 7\n}',
    );
  });
});

describe("jsonToolResult", () => {
  it("renders a returned body with an estimate", async () => {
    expect(text(await jsonToolResult(() => ({ ok: true, n: 1 })))).toBe(
      text(jsonResultWithEstimate({ ok: true, n: 1 })),
    );
  });

  it("awaits a promised body", async () => {
    expect(text(await jsonToolResult(async () => ({ ok: true, n: 1 })))).toBe(
      text(jsonResultWithEstimate({ ok: true, n: 1 })),
    );
  });

  it("renders a synchronous throw as an estimated error", async () => {
    const r = await jsonToolResult(() => {
      throw new Error("boom");
    });
    expect(text(r)).toBe(text(errorResultWithEstimate(new Error("boom"))));
  });

  it("renders a rejection as an estimated error", async () => {
    const r = await jsonToolResult(() => Promise.reject(new Error("boom")));
    expect(text(r)).toBe(text(errorResultWithEstimate(new Error("boom"))));
  });
});
