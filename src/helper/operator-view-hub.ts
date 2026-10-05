// The live view streams on the operator channel: one per session the daemon
// asked for, each fed by a frame source and drained into the daemon's socket.
//
// Who can reach what:
//   - Only the daemon, on the authenticated connection, starts or stops a
//     stream. The hub is built by the channel and handed to nothing else. The
//     agent's tools hold no reference to it, and no tool result carries stream
//     state or a frame.
//   - A frame goes to the sink and nowhere else: it is not logged, stored,
//     masked into a result, or kept past the call that sends it.
//
// Nothing queues. At most one frame is in flight to the daemon, a frame that
// arrives while it is still unacked or the socket is backed up is dropped, and
// the screencast itself is held back (its own ack is withheld) so the browser
// does not encode frames nobody will take. A daemon that falls behind steps the
// stream down to 1 fps and 640 px, and one that never acks stops it.

import { log } from "../util/logging.js";
import {
  ACK_TIMEOUT_MS,
  MAX_STREAMS,
  STALL_STOP_MS,
  ViewAdapter,
  WINDOW_MS,
  frameParts,
  parseViewStart,
  type ViewLevel,
  type ViewParams,
} from "./operator-view.js";

/** One screencast frame from a source. */
export interface ViewFrame {
  /** Base64 JPEG. */
  data: string;
  /** Tell the browser it may send the next frame. */
  ack(): void;
}

export interface ViewHandle {
  stop(): Promise<void>;
}

/** Where a session's frames come from. `start` begins the screencast at the
 *  given picture and `stop` ends it. */
export interface ViewSource {
  start(
    picture: { quality: number; maxWidth: number },
    onFrame: (frame: ViewFrame) => void,
  ): Promise<ViewHandle>;
}

/** The channel's side of a stream: the authenticated socket. */
export interface ViewSink {
  /** True while the connection is authenticated and not backed up. */
  canWrite(): boolean;
  send(frame: Record<string, unknown>): void;
}

/** What the session factory registers with. `null` marks a session whose engine
 *  has no frame source, so a `view.start` for it is refused by name. */
export interface LiveViewRegistry {
  register(session: string, source: ViewSource | null): void;
  /** Stops the session's stream, if one runs, and forgets the source. */
  unregister(session: string): Promise<void>;
}

export type ViewStopReason =
  "daemon" | "session-closed" | "channel-down" | "channel-closed" | "stalled" | "source-error";

/** Share of a frame interval a frame may arrive early without being dropped. */
const RATE_SLACK = 0.25;

class Stream {
  readonly adapter: ViewAdapter;
  seq = 0;
  stopped = false;
  #handle: ViewHandle | null = null;
  #inflight: { seq: number; sentAt: number } | null = null;
  #lastAckAt = Date.now();
  #lastCdpAckAt = 0;
  /** The earliest time the frame rate lets the next frame go, give or take the slack. */
  #nextAt = 0;
  #width = 0;
  #retuning = false;
  readonly #timers = new Set<NodeJS.Timeout>();
  #tick: NodeJS.Timeout | null = null;

  constructor(
    readonly session: string,
    readonly params: ViewParams,
    private readonly source: ViewSource,
    private readonly sink: ViewSink,
    private readonly onEnd: (s: Stream, reason: ViewStopReason) => void,
  ) {
    this.adapter = new ViewAdapter(params);
  }

  async begin(): Promise<void> {
    this.#width = this.adapter.level.width;
    this.#handle = await this.source.start(this.#picture(), (f) => this.#onFrame(f));
    if (this.stopped) return void (await this.#handle.stop().catch(() => undefined));
    this.#tick = setInterval(() => this.#onTick(), WINDOW_MS);
    this.#tick.unref();
  }

  #picture(): { quality: number; maxWidth: number } {
    return { quality: this.params.quality, maxWidth: this.adapter.level.width };
  }

  /** Release a screencast frame back to the browser no sooner than one frame
   *  interval after the last release. This is what holds the browser to the
   *  stream's rate: it sends the next frame only once it is acked. */
  #release(f: { ack(): void }): void {
    const now = Date.now();
    const at = Math.max(now, this.#lastCdpAckAt + 1000 / this.adapter.level.fps);
    this.#lastCdpAckAt = at;
    if (at <= now) return f.ack();
    const t = setTimeout(() => {
      this.#timers.delete(t);
      if (!this.stopped) f.ack();
    }, at - now);
    t.unref();
    this.#timers.add(t);
  }

  #onFrame(f: ViewFrame): void {
    if (this.stopped || this.#retuning) return;
    this.#release(f);
    const now = Date.now();
    const interval = 1000 / this.adapter.level.fps;
    // Ahead of the frame rate: not sent, and not slowness either. Chromium keeps
    // two frames in flight, so a stream just started or a page that paints in
    // bursts hands over two frames close together. A quarter of an interval of
    // slack keeps ordinary paint jitter from costing a frame.
    if (now < this.#nextAt - interval * RATE_SLACK) return;
    const out = this.#inflight;
    if (out && now - out.sentAt > ACK_TIMEOUT_MS) this.#inflight = null;
    if (this.#inflight || !this.sink.canWrite()) return this.adapter.noteDropped();
    const seq = this.seq + 1;
    const parts = frameParts({ session: this.session, seq, at: now }, f.data);
    if (!parts) return this.adapter.noteDropped();
    this.seq = seq;
    this.#nextAt = Math.max(this.#nextAt, now) + interval;
    this.#inflight = { seq, sentAt: now };
    for (const part of parts) this.sink.send(part);
    this.adapter.noteSent();
  }

  ack(seq: number): void {
    const out = this.#inflight;
    if (!out || out.seq !== seq) return;
    const now = Date.now();
    this.adapter.noteAck(now - out.sentAt);
    this.#lastAckAt = now;
    this.#inflight = null;
  }

  #onTick(): void {
    if (this.stopped) return;
    if (this.#inflight && Date.now() - this.#lastAckAt > STALL_STOP_MS) {
      return this.onEnd(this, "stalled");
    }
    if (this.adapter.closeWindow() === "same") return;
    void this.#retune(this.adapter.level);
  }

  /** A level change that moves the width restarts the screencast at it. A
   *  change in frame rate needs none: the release timing above follows it. */
  async #retune(level: ViewLevel): Promise<void> {
    if (level.width === this.#width) return;
    this.#retuning = true;
    try {
      await this.#handle?.stop();
      if (this.stopped) return;
      this.#width = level.width;
      this.#handle = await this.source.start(this.#picture(), (f) => this.#onFrame(f));
      if (this.stopped) await this.#handle.stop().catch(() => undefined);
    } catch {
      this.#handle = null;
      this.onEnd(this, "source-error");
    } finally {
      this.#retuning = false;
    }
  }

  async end(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.#tick) clearInterval(this.#tick);
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    const h = this.#handle;
    this.#handle = null;
    await h?.stop().catch(() => undefined);
  }
}

export class ViewHub implements LiveViewRegistry {
  // `null` is a session with no frame source.
  readonly #sources = new Map<string, ViewSource | null>();
  readonly #streams = new Map<string, Stream>();

  constructor(private readonly sink: ViewSink) {}

  register(session: string, source: ViewSource | null): void {
    this.#sources.set(session, source);
  }

  async unregister(session: string): Promise<void> {
    this.#sources.delete(session);
    const s = this.#streams.get(session);
    if (s) await this.#finish(s, "session-closed");
  }

  /** One frame from the daemon: `view.start`, `view.stop` or `frame.ack`. */
  handle(f: Record<string, unknown>): void {
    if (f.type === "view.start") return void this.#start(f);
    if (f.type === "view.stop") return void this.#stop(f);
    if (f.type === "frame.ack") this.#onAck(f);
  }

  stopAll(reason: ViewStopReason): void {
    for (const s of [...this.#streams.values()]) void this.#finish(s, reason);
  }

  #error(code: string, session?: unknown): void {
    this.sink.send({
      type: "error",
      code,
      ...(typeof session === "string" ? { session: session.slice(0, 128) } : {}),
    });
  }

  async #start(f: Record<string, unknown>): Promise<void> {
    const check = parseViewStart(f);
    if (!check.ok) return this.#error(check.code, f.session);
    const { session, params } = check;
    if (!this.#sources.has(session)) return this.#error("unknown-session", session);
    const source = this.#sources.get(session);
    if (!source) return this.#error("view-unsupported", session);
    const old = this.#streams.get(session);
    if (!old && this.#streams.size >= MAX_STREAMS) return this.#error("view-limit", session);
    if (old) await this.#finish(old, "daemon", false);
    const stream = new Stream(
      session,
      params,
      source,
      this.sink,
      (s, why) => void this.#finish(s, why),
    );
    this.#streams.set(session, stream);
    try {
      await stream.begin();
    } catch {
      // The browser refused the screencast. No detail goes out: it can name the page.
      if (this.#streams.get(session) === stream) this.#streams.delete(session);
      await stream.end();
      return this.#error("view-failed", session);
    }
    if (stream.stopped) return;
    log.info("browxai: live view started");
    this.sink.send({
      type: "view.started",
      session,
      format: "jpeg",
      maxFps: params.maxFps,
      maxWidth: params.maxWidth,
      quality: params.quality,
    });
  }

  #stop(f: Record<string, unknown>): void {
    const s = typeof f.session === "string" ? this.#streams.get(f.session) : undefined;
    if (s) return void this.#finish(s, "daemon");
    // Stopping what is not running is answered like stopping what was.
    if (typeof f.session === "string") {
      this.sink.send({ type: "view.stopped", session: f.session.slice(0, 128), reason: "daemon" });
    }
  }

  #onAck(f: Record<string, unknown>): void {
    const s = typeof f.session === "string" ? this.#streams.get(f.session) : undefined;
    if (s && typeof f.seq === "number") s.ack(f.seq);
  }

  async #finish(s: Stream, reason: ViewStopReason, tell = true): Promise<void> {
    if (this.#streams.get(s.session) === s) this.#streams.delete(s.session);
    if (s.stopped) return;
    await s.end();
    if (!tell) return;
    log.info("browxai: live view stopped", { reason });
    // Sent only while the connection is up; a dropped one carries no frame.
    this.sink.send({ type: "view.stopped", session: s.session, reason });
  }
}
