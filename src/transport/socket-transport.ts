// Shared MCP-over-Unix-socket transport. Reuses the MCP SDK's existing
// newline-delimited JSON framing (`ReadBuffer` + `serializeMessage` /
// `deserializeMessage`) so the wire format on a socket is byte-identical to
// the stdio path. The class implements the MCP `Transport` interface and is
// usable on BOTH ends:
//
//   - server side: `new SocketTransport(socket).start()` after `net.Server`
//     accepts a connection, then `mcpServer.connect(socketTransport)`.
//
//   - client side: `new SocketTransport(socket).start()` after `net.connect`
//     resolves, then `mcpClient.connect(socketTransport)`.
//
// Why not extend the existing stdio transport? Its constructor is bound to
// `process.stdin` / `process.stdout` and would attach a real `data` handler
// to stdin, which is exactly the side-effect we want to avoid in a server
// embedding the SDK. A small dedicated transport keeps the surface tight.
//
// Why this lives in src/transport/ (a neutral module) rather than src/sdk/:
// it is a shared wire primitive used by BOTH the server (src/cli/serve.ts)
// and the SDK client (src/sdk/transport-socket.ts). Homing it under src/sdk/
// forced the CLI to reach into the SDK package surface — an ownership
// inversion. A neutral transport module is the seam both ends import.

import type { Socket } from "node:net";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** Longest incoming line, in bytes, the transport buffers before it closes the
 *  connection: 32 MiB. The framing is newline-delimited, so a peer that never
 *  sends a newline would otherwise grow the read buffer without limit. */
export const MAX_SOCKET_MESSAGE_BYTES = 32 * 1024 * 1024;

const NEWLINE = 0x0a;

export class SocketTransport implements Transport {
  private readonly _socket: Socket;
  private readonly _readBuffer = new ReadBuffer();
  private readonly _maxMessageBytes: number;
  /** Bytes buffered since the last newline: the length of the line in progress. */
  private _pendingBytes = 0;
  private _started = false;
  private _closed = false;

  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;

  constructor(socket: Socket, opts: { maxMessageBytes?: number } = {}) {
    this._socket = socket;
    this._maxMessageBytes = opts.maxMessageBytes ?? MAX_SOCKET_MESSAGE_BYTES;
  }

  public start(): Promise<void> {
    if (this._started) {
      return Promise.reject(new Error("SocketTransport already started"));
    }
    this._started = true;
    this._socket.on("data", this._onData);
    this._socket.on("error", this._onError);
    this._socket.on("close", this._onClose);
    return Promise.resolve();
  }

  public async send(message: JSONRPCMessage): Promise<void> {
    if (this._closed) throw new Error("SocketTransport: send after close");
    return new Promise<void>((resolve, reject) => {
      const line = serializeMessage(message);
      this._socket.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  public async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._socket.removeListener("data", this._onData);
    this._socket.removeListener("error", this._onError);
    this._socket.removeListener("close", this._onClose);
    this._readBuffer.clear();
    await new Promise<void>((resolve) => {
      if (this._socket.destroyed) return resolve();
      this._socket.end(() => resolve());
    });
    this.onclose?.();
  }

  private _onData = (chunk: Buffer): void => {
    if (this._overLimit(chunk)) {
      this._closeOversized();
      return;
    }
    this._readBuffer.append(chunk);
    this._processBuffer();
  };

  /** Track the line in progress across chunks. True when any line, finished or
   *  not, runs past the limit. */
  private _overLimit(chunk: Buffer): boolean {
    let pending = this._pendingBytes;
    let start = 0;
    // cap: one pass per newline in `chunk`; `start` moves past each, so it ends at the last one.
    for (;;) {
      const newline = chunk.indexOf(NEWLINE, start);
      if (newline === -1) {
        pending += chunk.length - start;
        break;
      }
      if (pending + (newline - start) > this._maxMessageBytes) return true;
      pending = 0;
      start = newline + 1;
    }
    this._pendingBytes = pending;
    return pending > this._maxMessageBytes;
  }

  private _closeOversized(): void {
    this._closed = true;
    this._socket.removeListener("data", this._onData);
    this._socket.removeListener("close", this._onClose);
    this._readBuffer.clear();
    this._pendingBytes = 0;
    this._socket.destroy();
    this.onerror?.(
      new Error(
        `SocketTransport: an incoming message is over the ${this._maxMessageBytes}-byte limit; closing the connection`,
      ),
    );
    this.onclose?.();
  }

  private _onError = (err: Error): void => {
    this.onerror?.(err);
  };

  private _onClose = (): void => {
    if (this._closed) return;
    this._closed = true;
    this._readBuffer.clear();
    this.onclose?.();
  };

  private _processBuffer(): void {
    for (;;) {
      try {
        const msg = this._readBuffer.readMessage();
        if (!msg) return;
        this.onmessage?.(msg);
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
  }
}
