import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { ReadBuffer } from "@modelcontextprotocol/sdk/shared/stdio.js";
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

/** A valid message whose line, newline excluded, is exactly `bytes` long. */
function lineOfBytes(bytes: number): Buffer {
  const empty = JSON.stringify({ jsonrpc: "2.0", method: "notifications/x", params: { pad: "" } });
  const text = JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/x",
    params: { pad: "a".repeat(bytes - empty.length) },
  });
  return Buffer.from(text + "\n");
}

/** Emit `data` in pieces of `size` bytes, as a socket would deliver a long line. */
function emitInPieces(socket: FakeSocket, data: Buffer, size: number): void {
  for (let at = 0; at < data.length; at += size) {
    socket.emit("data", data.subarray(at, at + size));
  }
}

const MIB = 1024 * 1024;

describe("SocketTransport line limit against the read buffer's own cap", () => {
  // The SDK's read buffer stops at 10 MiB unless it is told otherwise. Each cap here is
  // checked at the limit and one byte past it, so the line limit is what decides.
  it.each([200, 64 * 1024, 11 * MIB])(
    "delivers a line of exactly %d bytes and closes on one byte more",
    async (cap) => {
      const atLimit = await started(cap);
      emitInPieces(atLimit.socket, lineOfBytes(cap), MIB);
      expect(atLimit.errors).toHaveLength(0);
      expect(atLimit.messages).toHaveLength(1);
      expect(atLimit.socket.destroyed).toBe(false);

      const over = await started(cap);
      emitInPieces(over.socket, lineOfBytes(cap + 1), MIB);
      expect(over.messages).toHaveLength(0);
      expect(over.errors).toHaveLength(1);
      expect(over.errors[0]!.message).toContain(`${cap}-byte limit`);
      expect(over.socket.destroyed).toBe(true);
      expect(over.closed()).toBe(1);
    },
  );

  it("delivers an 11 MiB line under the default limit", async () => {
    const t = await started();
    emitInPieces(t.socket, lineOfBytes(11 * MIB), MIB);
    t.socket.emit("data", line(2));
    expect(t.errors).toHaveLength(0);
    expect(t.messages).toHaveLength(2);
    expect(t.socket.destroyed).toBe(false);
  });

  it("delivers every line of one chunk that is longer than the limit in total", async () => {
    const t = await started(80);
    const one = line(1);
    t.socket.emit("data", Buffer.concat(Array.from({ length: 50 }, () => one)));
    expect(t.messages).toHaveLength(50);
    expect(t.errors).toHaveLength(0);
    expect(t.socket.destroyed).toBe(false);
  });
});

describe("SocketTransport malformed input", () => {
  it("drops a line that is not a message and delivers the lines after it", async () => {
    const t = await started(1024);
    t.socket.emit(
      "data",
      Buffer.concat([line(1), Buffer.from("not json\n"), Buffer.from('{"a":1}\n'), line(2)]),
    );
    expect(t.messages).toEqual([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    expect(t.errors).toHaveLength(2);
    expect(t.socket.destroyed).toBe(false);
    expect(t.closed()).toBe(0);
  });

  it("keeps reading after a malformed line in an earlier chunk", async () => {
    const t = await started(1024);
    t.socket.emit("data", Buffer.from("{broken\n"));
    t.socket.emit("data", line(7));
    expect(t.messages).toEqual([{ jsonrpc: "2.0", id: 7, method: "ping" }]);
    expect(t.errors).toHaveLength(1);
  });

  it("closes the connection, without throwing, when the read buffer refuses a chunk", async () => {
    const t = await started(1024);
    const append = vi.spyOn(ReadBuffer.prototype, "append").mockImplementationOnce(() => {
      throw new Error("ReadBuffer exceeded maximum size of 1 bytes");
    });
    try {
      expect(() => t.socket.emit("data", line(1))).not.toThrow();
    } finally {
      append.mockRestore();
    }
    expect(t.messages).toHaveLength(0);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0]!.message).toContain("could not read an incoming message");
    expect(t.socket.destroyed).toBe(true);
    expect(t.closed()).toBe(1);
    t.socket.emit("data", line(2));
    expect(t.messages).toHaveLength(0);
  });

  it("does not throw when the error listener throws while a connection is closed", async () => {
    const socket = new FakeSocket();
    const transport = new SocketTransport(socket as unknown as Socket, { maxMessageBytes: 10 });
    let closed = 0;
    transport.onerror = () => {
      throw new Error("listener failed");
    };
    transport.onclose = () => closed++;
    await transport.start();
    expect(() => socket.emit("data", Buffer.alloc(20, 0x61))).not.toThrow();
    expect(socket.destroyed).toBe(true);
    expect(closed).toBe(1);
  });
});
