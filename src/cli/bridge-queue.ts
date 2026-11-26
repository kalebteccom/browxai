// One direction of the `browxai bridge` relay: a first-in, first-out queue of messages
// for one transport. A message is written only after the one before it was accepted, so
// order holds and a slow reader slows the writer. When the queue holds more than its
// limit, it pauses the side the messages come from, and resumes it once it is empty.

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** Stops and restarts reading from one side of the relay. */
export interface FlowControl {
  pause(): void;
  resume(): void;
}

export interface SendQueueOptions {
  /** Write one message. Resolves when the transport has accepted it. */
  readonly send: (message: JSONRPCMessage) => Promise<void>;
  /** The side to pause while the queue is over its limit. */
  readonly flow?: FlowControl;
  readonly highWaterBytes: number;
  /** A write failed. The queue carries on with the next message. */
  readonly onError: (err: unknown) => void;
}

export class SendQueue {
  private readonly _opts: SendQueueOptions;
  private _tail: Promise<void> = Promise.resolve();
  private _depth = 0;
  private _waitingBytes = 0;
  private _paused = false;
  private _disposed = false;

  constructor(opts: SendQueueOptions) {
    this._opts = opts;
  }

  /** Add a message behind the ones already queued. */
  public push(message: JSONRPCMessage): void {
    if (this._disposed) return;
    // A message is measured only when it has to wait behind another. With no backlog
    // there is nothing to bound, and the common case costs no second serialization.
    const bytes = this._depth === 0 ? 0 : JSON.stringify(message).length;
    this._depth++;
    this._waitingBytes += bytes;
    if (!this._paused && this._waitingBytes > this._opts.highWaterBytes) {
      this._paused = true;
      this._opts.flow?.pause();
    }
    this._tail = this._tail
      .then(() => (this._disposed ? undefined : this._opts.send(message)))
      .catch((err: unknown) => {
        if (!this._disposed) this._opts.onError(err);
      })
      .then(() => {
        this._depth--;
        this._waitingBytes -= bytes;
        if (this._depth === 0) this._resume();
      });
  }

  /** Resolves when every message queued so far has been written or dropped. */
  public idle(): Promise<void> {
    return this._tail;
  }

  /** Whether the queue has paused its source. */
  public get paused(): boolean {
    return this._paused;
  }

  /** Stop writing. Messages still queued are dropped, and a paused source resumes. */
  public dispose(): void {
    this._disposed = true;
    this._resume();
  }

  private _resume(): void {
    if (!this._paused) return;
    this._paused = false;
    this._opts.flow?.resume();
  }
}
