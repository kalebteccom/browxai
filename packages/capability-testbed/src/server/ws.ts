// Minimal RFC 6455 WebSocket server — text frames only, zero dependencies.
// Enough to exercise browxai's ws_read / ws_send / ws_intercept tools against a
// real socket. Handles the upgrade handshake, masked client text frames, server
// text frames, ping/pong, and close. Not a general-purpose WS library.

import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface MinimalSocket {
  /** Send a UTF-8 text frame to the client. */
  send(text: string): void;
  /** Register a text-message handler. */
  onMessage(fn: (text: string) => void): void;
  /** Register a close handler. */
  onClose(fn: () => void): void;
  /** Close the connection (1000 normal). */
  close(): void;
}

/** Complete the WebSocket upgrade handshake and return a MinimalSocket, or
 *  undefined if the request is not a valid WS upgrade. */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex): MinimalSocket | undefined {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") return undefined;
  const accept = createHash("sha1")
    .update(key + GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const messageHandlers: Array<(text: string) => void> = [];
  const closeHandlers: Array<() => void> = [];
  let closed = false;
  let buffer = Buffer.alloc(0);

  function encodeFrame(opcode: number, payload: Buffer): Buffer {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }

  function emitClose(): void {
    if (closed) return;
    closed = true;
    for (const fn of closeHandlers) fn();
  }

  const api: MinimalSocket = {
    send(text: string): void {
      if (closed) return;
      socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
    },
    onMessage(fn): void {
      messageHandlers.push(fn);
    },
    onClose(fn): void {
      closeHandlers.push(fn);
    },
    close(): void {
      if (closed) return;
      try {
        socket.write(encodeFrame(0x8, Buffer.alloc(0)));
      } catch {
        // socket may already be torn down
      }
      socket.end();
      emitClose();
    },
  };

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    // Parse as many complete frames as the buffer holds.
    for (;;) {
      if (buffer.length < 2) return;
      const first = buffer[0]!;
      const second = buffer[1]!;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let len = second & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < offset + 2) return;
        len = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buffer.length < offset + 8) return;
        len = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      const maskKey = masked ? buffer.subarray(offset, offset + 4) : Buffer.alloc(0);
      if (masked) offset += 4;
      if (buffer.length < offset + len) return; // wait for the rest
      const payload = buffer.subarray(offset, offset + len);
      const decoded = Buffer.alloc(len);
      for (let i = 0; i < len; i++) {
        decoded[i] = masked ? payload[i]! ^ maskKey[i % 4]! : payload[i]!;
      }
      buffer = buffer.subarray(offset + len);

      if (opcode === 0x8) {
        api.close();
        return;
      } else if (opcode === 0x9) {
        socket.write(encodeFrame(0xa, decoded)); // pong
      } else if (opcode === 0x1) {
        const text = decoded.toString("utf8");
        for (const fn of messageHandlers) fn(text);
      }
      // opcode 0x2 (binary) / 0xa (pong) ignored
    }
  });

  socket.on("close", emitClose);
  socket.on("error", emitClose);
  return api;
}
