import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { SocketTransport, MAX_SOCKET_MESSAGE_BYTES } from "./socket-transport.js";

class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy(): this {
    this.destroyed = true;
    return this;
  }
  end(cb?: () => void): this {
    cb?.();
    return this;
  }
  write(_data: string, cb?: (err?: Error | null) => void): boolean {
    cb?.();
    return true;
  }
}

async function started(maxMessageBytes?: number) {
  const socket = new FakeSocket();
  const transport = new SocketTransport(
    socket as unknown as Socket,
    maxMessageBytes === undefined ? {} : { maxMessageBytes },
  );
  const messages: unknown[] = [];
  const errors: Error[] = [];
  let closed = 0;
  transport.onmessage = (m) => messages.push(m);
  transport.onerror = (e) => errors.push(e);
  transport.onclose = () => closed++;
  await transport.start();
  return { socket, messages, errors, closed: () => closed };
}

const line = (id: number) =>
  Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }) + "\n");

describe("SocketTransport read buffer cap", () => {
  it("defaults to 32 MiB", () => {
    expect(MAX_SOCKET_MESSAGE_BYTES).toBe(32 * 1024 * 1024);
  });

  it("delivers messages under the cap, including one split across chunks", async () => {
    const t = await started(1024);
    const whole = line(1);
    t.socket.emit("data", whole.subarray(0, 10));
    t.socket.emit("data", whole.subarray(10));
    t.socket.emit("data", line(2));
    expect(t.messages).toHaveLength(2);
    expect(t.errors).toHaveLength(0);
    expect(t.socket.destroyed).toBe(false);
  });

  it("closes with an error when a line without a newline grows past the cap", async () => {
    const t = await started(100);
    t.socket.emit("data", Buffer.alloc(60, 0x61));
    expect(t.socket.destroyed).toBe(false);
    t.socket.emit("data", Buffer.alloc(60, 0x61));
    expect(t.socket.destroyed).toBe(true);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0]!.message).toContain("100-byte limit");
    expect(t.closed()).toBe(1);
  });

  it("closes when one chunk holds a complete line over the cap", async () => {
    const t = await started(50);
    t.socket.emit("data", Buffer.from("x".repeat(80) + "\n"));
    expect(t.socket.destroyed).toBe(true);
    expect(t.errors).toHaveLength(1);
  });

  it("counts each line on its own, so many small messages in one stream pass", async () => {
    const t = await started(80);
    const one = line(1);
    expect(one.length).toBeLessThan(80);
    for (let i = 0; i < 20; i++) t.socket.emit("data", one);
    expect(t.messages).toHaveLength(20);
    expect(t.socket.destroyed).toBe(false);
  });

  it("ignores data after it closed the connection", async () => {
    const t = await started(10);
    t.socket.emit("data", Buffer.alloc(20, 0x61));
    t.socket.emit("data", Buffer.alloc(20, 0x61));
    expect(t.errors).toHaveLength(1);
    expect(t.closed()).toBe(1);
  });
});
