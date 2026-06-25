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

export class SocketTransport implements Transport {
  private readonly _socket: Socket;
  private readonly _readBuffer = new ReadBuffer();
  private _started = false;
  private _closed = false;

  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;

  constructor(socket: Socket) {
    this._socket = socket;
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
    this._readBuffer.append(chunk);
    this._processBuffer();
  };

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
