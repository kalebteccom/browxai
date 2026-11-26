import { describe, expect, it } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  kindOf,
  methodOf,
  requestIdOf,
  sameJson,
  sameTerms,
  serverVersionOf,
} from "./bridge-message.js";

const m = (value: Record<string, unknown>) => value as unknown as JSONRPCMessage;

describe("bridge message reading", () => {
  it("tells a request, a notification and a response apart", () => {
    expect(kindOf(m({ jsonrpc: "2.0", id: 1, method: "ping" }))).toBe("request");
    expect(kindOf(m({ jsonrpc: "2.0", id: 0, method: "ping" }))).toBe("request");
    expect(kindOf(m({ jsonrpc: "2.0", method: "notifications/x" }))).toBe("notification");
    expect(kindOf(m({ jsonrpc: "2.0", id: 1, result: {} }))).toBe("response");
    expect(kindOf(m({ jsonrpc: "2.0", id: "a", error: { code: 1, message: "x" } }))).toBe(
      "response",
    );
    expect(kindOf(m({ jsonrpc: "2.0", error: { code: 1, message: "x" } }))).toBe("response");
  });

  it("reads the id and the method, and nothing that is not a string or a number", () => {
    expect(requestIdOf(m({ id: "a" }))).toBe("a");
    expect(requestIdOf(m({ id: 0 }))).toBe(0);
    expect(requestIdOf(m({ id: null }))).toBeUndefined();
    expect(requestIdOf(undefined)).toBeUndefined();
    expect(methodOf(m({ method: "tools/call" }))).toBe("tools/call");
    expect(methodOf(m({ method: 4 }))).toBeUndefined();
  });

  it("reads the server version of an initialize result", () => {
    expect(serverVersionOf({ serverInfo: { name: "browxai", version: "1.2.3" } })).toBe("1.2.3");
    expect(serverVersionOf({})).toBeUndefined();
  });
});

describe("sameJson and sameTerms", () => {
  it("compares deeply and ignores key order", () => {
    expect(sameJson({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson([], {})).toBe(false);
    expect(sameJson(null, {})).toBe(false);
    expect(sameJson(undefined, undefined)).toBe(true);
  });

  it("compares the protocol version and the capabilities, and not the server's version", () => {
    const base = {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "browxai", version: "1.0.0" },
    };
    expect(sameTerms(base, { ...base, serverInfo: { name: "browxai", version: "9.9.9" } })).toBe(
      true,
    );
    expect(sameTerms(base, { ...base, protocolVersion: "2024-11-05" })).toBe(false);
    expect(sameTerms(base, { ...base, capabilities: { tools: { listChanged: true } } })).toBe(
      false,
    );
  });
});
