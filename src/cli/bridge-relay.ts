// The relay behind `browxai bridge`: every MCP message a client sends goes to the daemon
// unchanged, and every message the daemon sends comes back unchanged. It runs no MCP
// server and no MCP client, holds no tool table and applies no gate. The client talks to
// the daemon's own MCP server, so it sees the daemon's version, capabilities and tools.
//
// It reads two fields of a message, `id` and `method`, for one purpose: to know which of
// the client's requests have no response yet. When the daemon connection is lost, each of
// those gets an error response, a request that arrives during the gap gets one at once,
// and the relay connects again and repeats the client's `initialize` handshake to the new
// connection. Nothing is replayed: a click sent again to a restarted daemon would run
// against a session that no longer exists.
//
// Both ends are MCP `Transport` objects, so a test drives the relay with in-memory pairs.

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, type JSONRPCMessage, type RequestId } from "@modelcontextprotocol/sdk/types.js";
import { SendQueue, type FlowControl } from "./bridge-queue.js";
import {
  asRecord,
  methodOf,
  requestIdOf,
  sameTerms,
  serverVersionOf,
  type MessageKind,
  kindOf,
} from "./bridge-message.js";

/** One connection to the daemon: a transport that is not started yet, and the switch
 *  that stops and restarts reading from it. */
export interface DaemonLink extends Partial<FlowControl> {
  readonly transport: Transport;
}

/** Thrown by `openDaemon` when trying again cannot help. The relay ends with exit 3 and
 *  the message. */
export class RelayFatalError extends Error {}

/** How the relay ended: the process exit code, and a sentence for standard error. */
export interface RelayEnd {
  readonly code: 0 | 1 | 3;
  readonly message?: string;
}

export interface RelayOptions {
  /** The client side, not started. */
  readonly client: Transport;
  /** Stops and restarts reading from the client. */
  readonly clientFlow?: FlowControl;
  /** Open a new daemon connection. A rejection is tried again, except
   *  {@link RelayFatalError}, which ends the relay. */
  readonly openDaemon: () => Promise<DaemonLink>;
  /** Where the relay reports what happened. It is never given a frame. */
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The first wait before a reconnect attempt. Each failed attempt doubles it. */
  readonly retryFirstMs?: number;
  /** The longest wait between reconnect attempts. */
  readonly retryMaxMs?: number;
  /** How long a reconnected daemon may take to answer the repeated `initialize`. */
  readonly handshakeTimeoutMs?: number;
  /** A send queue holding more than this many bytes pauses the side it reads from. */
  readonly highWaterBytes?: number;
  /** How long the relay waits, when it ends, for responses to reach the client. */
  readonly flushMs?: number;
  /** The line limit to name when the client sends a longer line. */
  readonly clientLineLimit?: string;
}

const DEFAULTS = {
  retryFirstMs: 250,
  retryMaxMs: 5_000,
  handshakeTimeoutMs: 30_000,
  highWaterBytes: 64 * 1024 * 1024,
  flushMs: 2_000,
};

/** `up` relays. `handshake` holds the client's messages while a new connection repeats
 *  the handshake. `down` has no connection. `closed` is the end. */
type State = "up" | "handshake" | "down" | "closed";

const LOST = "browxai bridge: the connection to the daemon was lost";

export class BridgeRelay {
  /** Resolves once, when the relay has ended and both sides are closed. */
  public readonly done: Promise<RelayEnd>;

  private readonly _opts: RelayOptions & typeof DEFAULTS;
  private readonly _toClient: SendQueue;
  private _toDaemon: SendQueue | undefined;
  private _link: DaemonLink | undefined;
  private _state: State = "down";
  /** The client's requests that have no response yet. */
  private readonly _open = new Set<RequestId>();
  /** The client's messages that arrived while a new connection repeats the handshake. */
  private _held: JSONRPCMessage[] = [];
  private _initRequest: JSONRPCMessage | undefined;
  private _initResult: Record<string, unknown> | undefined;
  private _initialized: JSONRPCMessage | undefined;
  private _lostReason: string | undefined;
  private _clientFault: string | undefined;
  private _retryMs: number;
  private _handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private _draining = false;
  private _ended = false;
  private _whenIdle: (() => void) | undefined;
  private _resolveDone!: (end: RelayEnd) => void;

  constructor(opts: RelayOptions) {
    this._opts = { ...DEFAULTS, ...opts };
    this._retryMs = this._opts.retryFirstMs;
    this.done = new Promise((resolve) => (this._resolveDone = resolve));
    this._toClient = new SendQueue({
      send: (m) => this._opts.client.send(m),
      flow: { pause: () => this._link?.pause?.(), resume: () => this._link?.resume?.() },
      highWaterBytes: this._opts.highWaterBytes,
      // A write to the client that fails means the client is gone.
      onError: () => void this._end({ code: 0 }, false),
    });
  }

  /** The number of client requests with no response yet. */
  public get openRequests(): number {
    return this._open.size;
  }

  /** Start relaying between the client and a daemon connection that is already open. */
  public async start(first: DaemonLink): Promise<void> {
    const client = this._opts.client;
    client.onmessage = (m) => this._onClientMessage(m);
    client.onerror = (err) => this._onClientError(err);
    client.onclose = () => void this._end(this._clientEnd(), false);
    await this._attach(first);
    await client.start();
  }

  /** The client closed its side for writing. Wait up to `graceMs` for the responses still
   *  on their way, then end with exit 0. No session is closed. */
  public async drain(graceMs: number): Promise<void> {
    if (this._ended || this._draining) return;
    this._draining = true;
    if (this._open.size > 0) {
      await Promise.race([
        new Promise<void>((resolve) => (this._whenIdle = resolve)),
        this._sleep(graceMs),
      ]);
    }
    await this._end({ code: 0 }, true);
  }

  /** End now with exit 0: the client is gone, or the process was told to stop. */
  public close(): Promise<void> {
    return this._end({ code: 0 }, false);
  }

  private _sleep(ms: number): Promise<void> {
    return this._opts.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }

  private _log(message: string, fields?: Record<string, unknown>): void {
    this._opts.log?.(message, fields);
  }

  private _clientEnd(): RelayEnd {
    return this._clientFault === undefined ? { code: 0 } : { code: 1, message: this._clientFault };
  }

  // ── client side ───────────────────────────────────────────────────────────

  private _onClientError(err: Error): void {
    // The SDK's stdio transport reports a full read buffer, then closes itself.
    if (/exceeded maximum size/i.test(err.message)) {
      const limit = this._opts.clientLineLimit ?? "the line limit";
      this._clientFault = `browxai bridge: the client sent a line over ${limit}, which the bridge cannot relay or answer. Stopping.`;
      return;
    }
    // The error text of a line that failed to parse can quote the line, so only its
    // kind is reported.
    this._log("dropped a line from the client that is not a valid message", { kind: err.name });
  }

  private _onClientMessage(message: JSONRPCMessage): void {
    if (this._state === "closed" || this._draining) return;
    const kind = kindOf(message);
    this._noteClientMessage(message, kind);
    if (this._state === "down") {
      const id = requestIdOf(message);
      if (kind === "request" && id !== undefined) {
        this._toClient.push(
          lostResponse(id, `${LOST}, and it is not back yet. The call was not sent.`),
        );
      }
      return;
    }
    const id = requestIdOf(message);
    if (kind === "request" && id !== undefined) this._open.add(id);
    if (this._state === "handshake") this._held.push(message);
    else this._toDaemon?.push(message);
  }

  /** Keep what a reconnect needs, and forget a request the client cancelled. */
  private _noteClientMessage(message: JSONRPCMessage, kind: MessageKind): void {
    const method = methodOf(message);
    if (kind === "request" && method === "initialize") {
      this._initRequest = message;
      this._initResult = undefined;
      this._initialized = undefined;
    } else if (kind === "notification" && method === "notifications/initialized") {
      this._initialized = message;
    } else if (kind === "notification" && method === "notifications/cancelled") {
      const cancelled = asRecord(asRecord(message)?.params)?.requestId;
      if (typeof cancelled === "string" || typeof cancelled === "number") {
        this._settle(cancelled);
      }
    }
  }

  private _settle(id: RequestId): void {
    this._open.delete(id);
    if (this._open.size === 0) this._whenIdle?.();
  }

  // ── daemon side ───────────────────────────────────────────────────────────

  private async _attach(link: DaemonLink): Promise<void> {
    this._link = link;
    this._lostReason = undefined;
    this._toDaemon = new SendQueue({
      send: (m) => link.transport.send(m),
      flow: this._opts.clientFlow,
      highWaterBytes: this._opts.highWaterBytes,
      // A failed write is followed by the transport's close, which is handled below.
      onError: () => undefined,
    });
    link.transport.onmessage = (m) => this._onDaemonMessage(link, m);
    link.transport.onerror = (err) => this._onDaemonError(link, err);
    link.transport.onclose = () => this._onDaemonGone(link);
    const repeat = this._initResult === undefined ? undefined : this._initRequest;
    this._state = repeat === undefined ? "up" : "handshake";
    await link.transport.start();
    if (this._link !== link || repeat === undefined) return;
    this._handshakeTimer = setTimeout(() => {
      this._log("the daemon did not answer the repeated handshake, so the connection is closed");
      void link.transport.close().catch(() => undefined);
    }, this._opts.handshakeTimeoutMs);
    this._handshakeTimer.unref?.();
    this._toDaemon.push(repeat);
  }

  private _onDaemonError(link: DaemonLink, err: Error): void {
    if (link !== this._link) return;
    // The transport's own sentences name a limit and never quote a frame. Any other
    // error can quote the line that caused it, so only its kind is reported.
    if (err.message.startsWith("SocketTransport:")) {
      this._lostReason = err.message.replace(/^SocketTransport:\s*/, "");
      this._log("daemon connection error", { reason: this._lostReason });
    } else {
      this._log("dropped a line from the daemon that is not a valid message", { kind: err.name });
    }
  }

  private _onDaemonMessage(link: DaemonLink, message: JSONRPCMessage): void {
    if (link !== this._link) return;
    if (kindOf(message) === "response") {
      const id = requestIdOf(message);
      if (this._state === "handshake" && id === requestIdOf(this._initRequest)) {
        this._finishHandshake(link, message);
        return;
      }
      this._noteInitResult(id, message);
      if (id !== undefined) this._settle(id);
    }
    this._toClient.push(message);
  }

  /** Keep the first `initialize` result: a reconnect compares the new one with it. */
  private _noteInitResult(id: RequestId | undefined, message: JSONRPCMessage): void {
    if (this._initRequest === undefined || this._initResult !== undefined) return;
    if (id === undefined || id !== requestIdOf(this._initRequest)) return;
    const result = asRecord(asRecord(message)?.result);
    if (result === undefined) return;
    this._initResult = result;
    this._log("daemon answered initialize", { daemonVersion: serverVersionOf(result) });
  }

  /** The answer to the repeated `initialize`. The client never sees it. */
  private _finishHandshake(link: DaemonLink, message: JSONRPCMessage): void {
    clearTimeout(this._handshakeTimer);
    const result = asRecord(asRecord(message)?.result);
    if (result === undefined || this._initResult === undefined) {
      this._log("the daemon refused the repeated handshake, so the connection is closed");
      void link.transport.close().catch(() => undefined);
      return;
    }
    if (!sameTerms(this._initResult, result)) {
      this._failOpen(`${LOST}, and the bridge is stopping. The call was not sent.`);
      void this._end(
        {
          code: 3,
          message:
            "browxai bridge: the daemon came back with a different protocol version or different capabilities, so this connection cannot carry on. Start the MCP server again to negotiate with it.",
        },
        true,
      );
      return;
    }
    const before = serverVersionOf(this._initResult);
    const now = serverVersionOf(result);
    if (before !== now) this._log("the daemon version changed", { before, now });
    if (this._initialized !== undefined) this._toDaemon?.push(this._initialized);
    this._state = "up";
    this._retryMs = this._opts.retryFirstMs;
    this._log("daemon connection restored");
    const held = this._held;
    this._held = [];
    for (const m of held) this._toDaemon?.push(m);
  }

  private _onDaemonGone(link: DaemonLink): void {
    if (link !== this._link || this._state === "closed") return;
    clearTimeout(this._handshakeTimer);
    const established = this._state === "up";
    this._link = undefined;
    this._toDaemon?.dispose();
    this._toDaemon = undefined;
    this._state = "down";
    const why = this._lostReason === undefined ? "" : ` (${this._lostReason})`;
    this._log("daemon connection lost", { openRequests: this._open.size });
    this._failOpen(`${LOST}${why}. The call may or may not have run.`);
    // A client that never got an `initialize` result has nothing to repeat: it sends
    // its own again.
    if (this._initResult === undefined) this._initRequest = undefined;
    if (established) this._retryMs = this._opts.retryFirstMs;
    if (!this._draining) void this._reconnect();
  }

  /** Answer every open request with an error, and drop what was held for the daemon. */
  private _failOpen(text: string): void {
    for (const id of this._open) this._toClient.push(lostResponse(id, text));
    this._open.clear();
    this._held = [];
    this._whenIdle?.();
  }

  private async _reconnect(): Promise<void> {
    // cap: ends when a connection opens or the relay closes; every pass waits first,
    // and the wait grows to `retryMaxMs`.
    while (this._state === "down") {
      const wait = this._retryMs;
      this._retryMs = Math.min(wait * 2, this._opts.retryMaxMs);
      await this._sleep(wait);
      if (this._state !== "down") return;
      let link: DaemonLink;
      try {
        link = await this._opts.openDaemon();
      } catch (err) {
        if (err instanceof RelayFatalError) {
          await this._end({ code: 3, message: err.message }, true);
          return;
        }
        continue;
      }
      if (this._state !== "down") {
        await link.transport.close().catch(() => undefined);
        return;
      }
      await this._attach(link);
      return;
    }
  }

  // ── the end ───────────────────────────────────────────────────────────────

  private async _end(end: RelayEnd, flush: boolean): Promise<void> {
    if (this._ended) return;
    this._ended = true;
    this._state = "closed";
    clearTimeout(this._handshakeTimer);
    const link = this._link;
    this._link = undefined;
    this._toDaemon?.dispose();
    if (flush) await Promise.race([this._toClient.idle(), this._sleep(this._opts.flushMs)]);
    this._toClient.dispose();
    if (link !== undefined) {
      link.transport.onclose = undefined;
      await link.transport.close().catch(() => undefined);
    }
    this._opts.client.onclose = undefined;
    await this._opts.client.close().catch(() => undefined);
    this._resolveDone(end);
  }
}

function lostResponse(id: RequestId, message: string): JSONRPCMessage {
  return { jsonrpc: "2.0", id, error: { code: ErrorCode.ConnectionClosed, message } };
}
