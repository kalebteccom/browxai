// The append-only capture side of RFC 0007: buffer ReplayEvents, stream them to
// `events.jsonl`, and stop cleanly at a cap. Capture runs on the browser
// session's hot path, so `record()` is synchronous and never awaits the disk.

import { mkdir, open as openFile, readFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { resolveWorkspaceReadPath, resolveWorkspaceWritePath } from "../util/workspace.js";
import type { ReplayEvent, ReplayEventType, ReplayManifest } from "./schema.js";

export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_EVENTS = 500_000;
export const DEFAULT_FLUSH_BYTES = 64 * 1024;
export const DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024;

/** `manifest.truncated` carries only size-cap / event-cap, so a backpressure
 *  drop is reported here in `counts` instead of being folded into one of those
 *  two reasons, which would misreport why the log is short. */
export const BACKPRESSURE_DROP_KEY = "log/dropped-backpressure";

const TOOL = "replay_log";

export type ReplayTruncation = NonNullable<ReplayManifest["truncated"]>;

export interface ReplayLogOptions {
  workspaceRoot: string;
  /** Workspace-relative path for `events.jsonl`. */
  path: string;
  clockOrigin?: number;
  /** Monotonic millisecond source. Defaults to `performance.now`. */
  now?: () => number;
  maxBytes?: number;
  maxEvents?: number;
  flushBytes?: number;
  maxPendingBytes?: number;
}

export interface ReplayLogStats {
  path: string;
  clockOrigin: number;
  bytes: number;
  events: number;
  counts: Record<string, number>;
  truncated?: ReplayTruncation;
}

export interface RecordOptions {
  v?: number;
  targetId?: string;
  t?: number;
}

export class ReplayLog {
  readonly clockOrigin: number;
  readonly path: string;

  private readonly now: () => number;
  private readonly monoOrigin: number;
  private readonly maxBytes: number;
  private readonly maxEvents: number;
  private readonly flushBytes: number;
  private readonly maxPendingBytes: number;
  private readonly handle: FileHandle;
  private readonly countsMap: Record<string, number> = {};

  private pending: string[] = [];
  private pendingBytes = 0;
  private inFlightBytes = 0;
  private byteCount = 0;
  private eventCount = 0;
  private lastT = 0;
  private closed = false;
  private truncation: ReplayTruncation | undefined;
  private writeError: Error | undefined;
  private tail: Promise<void> = Promise.resolve();

  private constructor(opts: ReplayLogOptions, path: string, handle: FileHandle) {
    this.path = path;
    this.handle = handle;
    this.now = opts.now ?? (() => performance.now());
    this.monoOrigin = this.now();
    this.clockOrigin = opts.clockOrigin ?? Date.now();
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.flushBytes = opts.flushBytes ?? DEFAULT_FLUSH_BYTES;
    this.maxPendingBytes = opts.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
  }

  static async open(opts: ReplayLogOptions): Promise<ReplayLog> {
    const abs = resolveWorkspaceWritePath(opts.workspaceRoot, opts.path, TOOL);
    // `abs` is inside $BROWX_WORKSPACE by construction — resolveWorkspacePath
    // throws on anything that escapes the root.
    await mkdir(dirname(abs), { recursive: true });
    const handle = await openFile(abs, "w");
    return new ReplayLog(opts, abs, handle);
  }

  get truncated(): ReplayTruncation | undefined {
    return this.truncation;
  }

  get counts(): Record<string, number> {
    return { ...this.countsMap };
  }

  get bytes(): number {
    return this.byteCount;
  }

  get events(): number {
    return this.eventCount;
  }

  record<P>(type: ReplayEventType | (string & {}), payload: P, opts: RecordOptions = {}): boolean {
    const event: ReplayEvent<P> = {
      t: opts.t ?? this.tick(),
      type,
      v: opts.v ?? 1,
      payload,
    };
    if (opts.targetId !== undefined) event.targetId = opts.targetId;
    return this.append(event);
  }

  append(event: ReplayEvent): boolean {
    if (this.closed) return false;
    // The two caps are irreversible — once tripped, we never take more. But
    // backpressure is reversible: the disk may catch up, and the RFC pins that
    // distinction as load-bearing ("a log can carry dropped events and still
    // run to the end of the session"). So a size/event trip gates future
    // appends here; a backpressure trip records the reason without gating
    // subsequent successful writes.
    if (this.truncation && this.truncation.reason !== "backpressure") {
      this.truncation.droppedEvents++;
      return false;
    }
    const line = `${JSON.stringify(event)}\n`;
    const size = Buffer.byteLength(line, "utf8");
    if (this.eventCount + 1 > this.maxEvents) return this.trip(event.t, "event-cap");
    if (this.byteCount + size > this.maxBytes) return this.trip(event.t, "size-cap");
    // The unflushed + in-flight window is the only unbounded memory on this
    // path, so a stalled disk drops events instead of growing the buffer.
    if (this.pendingBytes + this.inFlightBytes + size > this.maxPendingBytes) {
      this.bump(BACKPRESSURE_DROP_KEY);
      // Record the first backpressure drop as the truncation reason so a
      // short log surfaces it on the manifest (`schema.ts` names the three-way
      // reason as load-bearing). Subsequent backpressure drops increment the
      // counter; a later size/event trip supersedes because those two are
      // permanent.
      if (!this.truncation) {
        this.truncation = { at: event.t, reason: "backpressure", droppedEvents: 1 };
      } else if (this.truncation.reason === "backpressure") {
        this.truncation.droppedEvents++;
      }
      return false;
    }
    this.pending.push(line);
    this.pendingBytes += size;
    this.byteCount += size;
    this.eventCount++;
    this.bump(event.type);
    if (this.pendingBytes >= this.flushBytes) this.flush();
    return true;
  }

  flush(): void {
    if (this.pending.length === 0) return;
    const chunk = Buffer.from(this.pending.join(""), "utf8");
    this.pending = [];
    this.pendingBytes = 0;
    this.inFlightBytes += chunk.byteLength;
    this.tail = this.tail.then(async () => {
      try {
        await this.handle.write(chunk);
      } catch (err) {
        this.writeError ??= err instanceof Error ? err : new Error(String(err));
      } finally {
        this.inFlightBytes -= chunk.byteLength;
      }
    });
  }

  /** Resolves once every flushed chunk has reached the file. A checkpoint for
   *  callers that want the log on disk without closing it. */
  async drained(): Promise<void> {
    await this.tail;
  }

  async close(): Promise<ReplayLogStats> {
    if (!this.closed) {
      this.closed = true;
      this.flush();
      await this.tail;
      await this.handle.close();
    }
    if (this.writeError) throw this.writeError;
    return {
      path: this.path,
      clockOrigin: this.clockOrigin,
      bytes: this.byteCount,
      events: this.eventCount,
      counts: this.counts,
      truncated: this.truncation,
    };
  }

  private tick(): number {
    this.lastT = Math.max(this.lastT, Math.max(0, Math.round(this.now() - this.monoOrigin)));
    return this.lastT;
  }

  private bump(key: string): void {
    this.countsMap[key] = (this.countsMap[key] ?? 0) + 1;
  }

  private trip(t: number, reason: ReplayTruncation["reason"]): false {
    this.truncation = { at: t, reason, droppedEvents: 1 };
    return false;
  }
}

export async function readEventLog(workspaceRoot: string, path: string): Promise<Buffer> {
  return await readFile(resolveWorkspaceReadPath(workspaceRoot, path, TOOL));
}
