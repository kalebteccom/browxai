// The little the `browxai bridge` relay reads of an MCP message: which kind it is, its
// `id` and `method`, and the parts of an `initialize` result that a reconnect compares.
// Pure: no I/O.

import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";

/** A request has a method and an id, a notification a method only, a response an id only
 *  (or neither, for an error that answers a line with no readable id). */
export type MessageKind = "request" | "notification" | "response";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function methodOf(message: JSONRPCMessage | undefined): string | undefined {
  const method = asRecord(message)?.method;
  return typeof method === "string" ? method : undefined;
}

export function requestIdOf(message: JSONRPCMessage | undefined): RequestId | undefined {
  const id = asRecord(message)?.id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

export function kindOf(message: JSONRPCMessage): MessageKind {
  if (methodOf(message) === undefined) return "response";
  return requestIdOf(message) === undefined ? "notification" : "request";
}

/** `serverInfo.version` of an `initialize` result. */
export function serverVersionOf(result: Record<string, unknown>): string | undefined {
  const version = asRecord(result.serverInfo)?.version;
  return typeof version === "string" ? version : undefined;
}

/** Deep equality of two JSON values. The order of an object's keys does not count. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameJson(item, b[i]));
  }
  const left = asRecord(a);
  const right = asRecord(b);
  if (left === undefined || right === undefined) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

/** Whether two `initialize` results negotiated the same terms: the protocol version and
 *  the capabilities. The server's name and version are not terms. */
export function sameTerms(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return a.protocolVersion === b.protocolVersion && sameJson(a.capabilities, b.capabilities);
}
