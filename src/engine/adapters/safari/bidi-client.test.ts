import { describe, it, expect } from "vitest";
import { SafariBidiClient, BidiError, type WebSocketLike } from "./bidi-client.js";

// Exercises the BiDi client's request/response correlation, event dispatch, and
// structured error mapping with a driven fake socket — no real WebSocket, no
// safaridriver. The real socket is covered by the Safari-gated keystone.

class FakeWebSocket implements WebSocketLike {
  readonly sent: string[] = [];
  private readonly listeners: Record<string, ((ev: { data?: string }) => void)[]> = {};
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (ev: { data?: string }) => void,
  ): void {
    (this.listeners[type] ??= []).push(listener);
  }

  // test drivers
  emitOpen(): void {
    for (const l of this.listeners["open"] ?? []) l({});
  }
  emitMessage(obj: unknown): void {
    for (const l of this.listeners["message"] ?? []) l({ data: JSON.stringify(obj) });
  }
  lastFrame(): { id?: number; method: string; params: Record<string, unknown> } {
    return JSON.parse(this.sent[this.sent.length - 1]!);
  }
}

function connected(): { client: SafariBidiClient; ws: FakeWebSocket } {
  const ws = new FakeWebSocket();
  const client = new SafariBidiClient({ url: "ws://x", wsFactory: () => ws });
  void client.connect();
  ws.emitOpen();
  return { client, ws };
}

describe("SafariBidiClient — connection + correlation", () => {
  it("resolves connect() on socket open", async () => {
    const ws = new FakeWebSocket();
    const client = new SafariBidiClient({ url: "ws://x", wsFactory: () => ws });
    const p = client.connect();
    ws.emitOpen();
    await expect(p).resolves.toBeUndefined();
  });

  it("correlates a command reply by id", async () => {
    const { client, ws } = connected();
    const p = client.send("script.evaluate", { expression: "1+2" });
    const frame = ws.lastFrame();
    expect(frame.method).toBe("script.evaluate");
    ws.emitMessage({ type: "success", id: frame.id, result: { value: 3 } });
    await expect(p).resolves.toEqual({ value: 3 });
  });

  it("rejects with BidiError on an error reply (e.g. unknown command)", async () => {
    const { client, ws } = connected();
    const p = client.send("network.addIntercept", {});
    const frame = ws.lastFrame();
    ws.emitMessage({
      type: "error",
      id: frame.id,
      error: "unknown command",
      message: "'network' not found",
    });
    await expect(p).rejects.toBeInstanceOf(BidiError);
  });
});

describe("SafariBidiClient — events", () => {
  it("subscribes and dispatches event params to on() handlers", async () => {
    const { client, ws } = connected();
    const seen: Record<string, unknown>[] = [];
    client.on("log.entryAdded", (params) => seen.push(params));

    const sub = client.subscribe(["log.entryAdded"]);
    const subFrame = ws.lastFrame();
    expect(subFrame.method).toBe("session.subscribe");
    ws.emitMessage({ type: "success", id: subFrame.id, result: {} });
    await sub;

    ws.emitMessage({ type: "event", method: "log.entryAdded", params: { text: "hello" } });
    expect(seen).toEqual([{ text: "hello" }]);
  });

  it("ignores events with no registered handler", () => {
    const { ws } = connected();
    // No throw when an unsubscribed event arrives.
    expect(() =>
      ws.emitMessage({ type: "event", method: "browsingContext.load", params: {} }),
    ).not.toThrow();
  });
});

describe("SafariBidiClient — lifecycle", () => {
  it("rejects in-flight commands on close()", async () => {
    const { client, ws } = connected();
    const p = client.send("script.getRealms");
    client.close();
    expect(ws.closed).toBe(true);
    await expect(p).rejects.toThrow(/client closed/);
  });

  it("rejects send() before connect", async () => {
    const client = new SafariBidiClient({ url: "ws://x", wsFactory: () => new FakeWebSocket() });
    await expect(client.send("session.status")).rejects.toThrow(/not connected/);
  });
});
