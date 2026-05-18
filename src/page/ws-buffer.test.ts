import { describe, it, expect, vi } from "vitest";
import { WsBuffer, fetchResponseBody } from "./network.js";

describe("fetchResponseBody — W-H5", () => {
  it("returns the body for a retained response", async () => {
    const cdp = { send: vi.fn(async () => ({ body: '{"id":1}', base64Encoded: false })) } as never;
    const r = await fetchResponseBody(cdp, "req-1");
    expect(r).toEqual({ ok: true, body: '{"id":1}', base64Encoded: false });
  });

  it("truncates oversized bodies and flags it", async () => {
    const big = "x".repeat(10);
    const cdp = { send: vi.fn(async () => ({ body: big, base64Encoded: false })) } as never;
    const r = await fetchResponseBody(cdp, "req-1", 4);
    expect(r.body).toBe("xxxx");
    expect(r.truncated).toBe(true);
  });

  it("returns ok:false with a helpful message when the body was discarded", async () => {
    const cdp = { send: vi.fn(async () => { throw new Error("No resource with given identifier found"); }) } as never;
    const r = await fetchResponseBody(cdp, "gone");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/short-lived/);
  });
});

// Minimal CDP stub: records `on` handlers by event name and lets the test
// fire them. `send` resolves (Network.enable is idempotent).
function fakeCdp() {
  const handlers = new Map<string, (e: unknown) => void>();
  return {
    cdp: {
      send: vi.fn(async () => undefined),
      on: (evt: string, fn: (e: unknown) => void) => handlers.set(evt, fn),
      off: () => undefined,
    } as never,
    fire: (evt: string, e: unknown) => handlers.get(evt)?.(e),
  };
}

describe("WsBuffer — W-H1 frame capture", () => {
  it("maps webSocketCreated url onto subsequent frames, both directions", async () => {
    const { cdp, fire } = fakeCdp();
    const ws = new WsBuffer(cdp);
    await ws.attach();
    fire("Network.webSocketCreated", { requestId: "r1", url: "wss://rt.example/socket" });
    fire("Network.webSocketFrameReceived", { requestId: "r1", response: { opcode: 1, payloadData: '{"type":"broadcast"}' } });
    fire("Network.webSocketFrameSent", { requestId: "r1", response: { opcode: 1, payloadData: "subscribe" } });
    const { total, frames } = ws.recent();
    expect(total).toBe(2);
    expect(frames[0]).toMatchObject({ url: "wss://rt.example/socket", dir: "recv", kind: "ws", opcode: 1, payload: '{"type":"broadcast"}' });
    expect(frames[1]).toMatchObject({ dir: "sent", kind: "ws", payload: "subscribe" });
  });

  it("captures SSE messages via eventSourceMessageReceived", async () => {
    const { cdp, fire } = fakeCdp();
    const ws = new WsBuffer(cdp);
    await ws.attach();
    fire("Network.requestWillBeSent", { requestId: "sse1", request: { url: "https://api.example/stream" }, type: "EventSource" });
    fire("Network.eventSourceMessageReceived", { requestId: "sse1", eventName: "ping", data: "{}" });
    const { frames } = ws.recent();
    expect(frames[0]).toMatchObject({ url: "https://api.example/stream", dir: "recv", kind: "sse", event: "ping", payload: "{}" });
  });

  it("truncates payloads to maxPayload and flags truncated", async () => {
    const { cdp, fire } = fakeCdp();
    const ws = new WsBuffer(cdp, 500, 8);
    await ws.attach();
    fire("Network.webSocketCreated", { requestId: "r", url: "wss://x" });
    fire("Network.webSocketFrameReceived", { requestId: "r", response: { opcode: 1, payloadData: "0123456789abcdef" } });
    const f = ws.recent().frames[0]!;
    expect(f.payload).toBe("01234567");
    expect(f.truncated).toBe(true);
  });

  it("recent() filters by urlPattern substring", async () => {
    const { cdp, fire } = fakeCdp();
    const ws = new WsBuffer(cdp);
    await ws.attach();
    fire("Network.webSocketCreated", { requestId: "a", url: "wss://chat.example/ws" });
    fire("Network.webSocketCreated", { requestId: "b", url: "wss://metrics.example/ws" });
    fire("Network.webSocketFrameReceived", { requestId: "a", response: { opcode: 1, payloadData: "chat-msg" } });
    fire("Network.webSocketFrameReceived", { requestId: "b", response: { opcode: 1, payloadData: "metric" } });
    expect(ws.recent(50, "chat.example").frames.map((f) => f.payload)).toEqual(["chat-msg"]);
  });

  it("ring evicts oldest beyond cap", async () => {
    const { cdp, fire } = fakeCdp();
    const ws = new WsBuffer(cdp, 3);
    await ws.attach();
    fire("Network.webSocketCreated", { requestId: "r", url: "wss://x" });
    for (let i = 0; i < 5; i++) {
      fire("Network.webSocketFrameReceived", { requestId: "r", response: { opcode: 1, payloadData: `f${i}` } });
    }
    const { total, frames } = ws.recent();
    expect(total).toBe(3);
    expect(frames.map((f) => f.payload)).toEqual(["f2", "f3", "f4"]);
  });

  it("since(ts) returns only frames at/after the timestamp (per-action slice)", async () => {
    const { cdp, fire } = fakeCdp();
    const ws = new WsBuffer(cdp);
    await ws.attach();
    fire("Network.webSocketCreated", { requestId: "r", url: "wss://x" });
    fire("Network.webSocketFrameReceived", { requestId: "r", response: { opcode: 1, payloadData: "before" } });
    await new Promise((r) => setTimeout(r, 5));
    const mark = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    fire("Network.webSocketFrameReceived", { requestId: "r", response: { opcode: 1, payloadData: "after" } });
    const sliced = ws.since(mark);
    expect(sliced.map((f) => f.payload)).toEqual(["after"]);
  });

  it("frames whose create event was missed get an empty url, still captured", async () => {
    const { cdp, fire } = fakeCdp();
    const ws = new WsBuffer(cdp);
    await ws.attach();
    fire("Network.webSocketFrameReceived", { requestId: "unknown", response: { opcode: 2, payloadData: "binary-ish" } });
    expect(ws.recent().frames[0]).toMatchObject({ url: "", opcode: 2, payload: "binary-ish" });
  });
});
