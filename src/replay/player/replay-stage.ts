/// <reference lib="dom" />
// The DOM-replay surface. rrweb's `Replayer` renders the page; everything on
// this side of it speaks the browxai envelope.
//
// Two rules the rest of the player depends on:
//   - the envelope is read here, never assumed. `dom/rrweb` events are filtered
//     out of the log and only `payload` is handed to rrweb, so a log carrying
//     network, console and framework events alongside the DOM stream replays
//     exactly the same as one that does not.
//   - a log with no usable DOM stream is an empty stage, not a crash. `create`
//     returns undefined and the timeline, the step list and jump-to-failure all
//     still work.

import type { ReplayEvent } from "../schema.js";

/** rrweb's own numbering, asserted against the numbers because the payload
 *  crosses as plain JSON and the player never imports rrweb's types. */
const RRWEB_META = 4;
const RRWEB_FULL_SNAPSHOT = 2;

export interface RrwebMeta {
  startTime: number;
  endTime: number;
  totalTime: number;
}

export interface RrwebReplayerLike {
  play(timeOffset?: number): void;
  pause(timeOffset?: number): void;
  destroy(): void;
  setConfig(config: Record<string, unknown>): void;
  getMetaData(): RrwebMeta;
  getCurrentTime(): number;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
}

export interface RrwebGlobal {
  Replayer: new (events: unknown[], config?: Record<string, unknown>) => RrwebReplayerLike;
}

interface RrwebPayload {
  type?: number;
  timestamp?: number;
}

/** Take `payload` out of our envelope, drop everything else. An event of any
 *  other type — including one this build has never heard of — is skipped here
 *  and picked up by the timeline as an unknown marker. */
export function domPayloads(events: readonly ReplayEvent[]): RrwebPayload[] {
  const out: RrwebPayload[] = [];
  for (const event of events) {
    if (event.type !== "dom/rrweb") continue;
    const payload = event.payload;
    if (typeof payload === "object" && payload !== null) out.push(payload);
  }
  return out;
}

/** rrweb needs a meta event and a full snapshot before it can build a document,
 *  and refuses a one-event list outright. Checking here is what turns "the
 *  artifact has no DOM stream" into an empty state instead of a thrown
 *  constructor. */
export function isPlayable(payloads: readonly RrwebPayload[]): boolean {
  if (payloads.length < 2) return false;
  return (
    payloads.some((p) => p.type === RRWEB_META) &&
    payloads.some((p) => p.type === RRWEB_FULL_SNAPSHOT)
  );
}

export interface StageOptions {
  root: HTMLElement;
  /** `ReplayManifest.clockOrigin`: our `t` is relative to it, rrweb's
   *  `timestamp` is absolute, and the stage is where the two meet. */
  clockOrigin: number;
  onTime?: (t: number) => void;
  onFinish?: () => void;
  rrweb?: RrwebGlobal;
}

function rrwebGlobal(explicit?: RrwebGlobal): RrwebGlobal | undefined {
  if (explicit) return explicit;
  const candidate = (globalThis as { rrweb?: RrwebGlobal }).rrweb;
  return typeof candidate?.Replayer === "function" ? candidate : undefined;
}

/** Wraps one `Replayer`, translating between browxai timeline ms and rrweb's
 *  offset-from-first-event ms. */
export class ReplayStage {
  private readonly replayer: RrwebReplayerLike;
  private readonly meta: RrwebMeta;
  private readonly clockOrigin: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private playing = false;

  private constructor(replayer: RrwebReplayerLike, clockOrigin: number, opts: StageOptions) {
    this.replayer = replayer;
    this.meta = replayer.getMetaData();
    this.clockOrigin = clockOrigin;
    if (opts.onTime) {
      // rrweb emits no continuous time event, so the playhead is sampled. 16ms
      // tracks a 60Hz scrubber without costing a render per tick.
      this.timer = setInterval(() => {
        if (this.playing) opts.onTime?.(this.currentT());
      }, 16);
    }
    if (opts.onFinish) {
      replayer.on("finish", () => {
        this.playing = false;
        opts.onFinish?.();
      });
    }
  }

  static create(events: readonly ReplayEvent[], opts: StageOptions): ReplayStage | undefined {
    const payloads = domPayloads(events);
    const rrweb = rrwebGlobal(opts.rrweb);
    if (!rrweb || !isPlayable(payloads)) return undefined;
    const replayer = new rrweb.Replayer(payloads, {
      root: opts.root,
      speed: 1,
      skipInactive: false,
      showWarning: false,
      showDebug: false,
      mouseTail: false,
      // A replay opened from file:// cannot fetch the origin's stylesheets, so
      // an un-inlined <link> would render an unstyled page and read as a bug in
      // the capture. Blocking the class makes the gap visible instead.
      blockClass: "browx-replay-blocked",
      liveMode: false,
    });
    return new ReplayStage(replayer, opts.clockOrigin, opts);
  }

  /** Our timeline ms -> rrweb offset, clamped into the stream's own window. */
  offsetFor(t: number): number {
    const wall = this.clockOrigin + t;
    return Math.min(Math.max(0, wall - this.meta.startTime), this.meta.totalTime);
  }

  /**
   * Seeking is one millisecond ahead of playing, and it has to be.
   *
   * rrweb applies an event synchronously only when `timestamp < baselineTime`;
   * anything landing exactly ON the baseline is handed to the playback timer
   * instead. A seek pauses the timer immediately, so an offset of exactly 0
   * leaves the meta + full-snapshot pair queued and the stage renders an empty
   * iframe. The +1 puts every event at or before `t` on the synchronous side,
   * which is also the semantics a reviewer wants from "show me the page after
   * this step". Deliberately NOT clamped at the top: an offset past the end
   * means "apply everything", which is the correct end-of-replay frame.
   */
  seekOffsetFor(t: number): number {
    return Math.max(0, this.clockOrigin + t - this.meta.startTime) + 1;
  }

  currentT(): number {
    return Math.max(0, this.meta.startTime + this.replayer.getCurrentTime() - this.clockOrigin);
  }

  /** Timeline window the DOM stream actually covers, so the UI can shade the
   *  part of the scrubber with no page behind it. */
  coverage(): { from: number; to: number } {
    return {
      from: Math.max(0, this.meta.startTime - this.clockOrigin),
      to: Math.max(0, this.meta.endTime - this.clockOrigin),
    };
  }

  seek(t: number): void {
    this.playing = false;
    this.replayer.pause(this.seekOffsetFor(t));
  }

  play(t?: number): void {
    this.playing = true;
    this.replayer.play(t === undefined ? undefined : this.offsetFor(t));
  }

  pause(): void {
    this.playing = false;
    this.replayer.pause();
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  setSpeed(speed: number): void {
    this.replayer.setConfig({ speed });
  }

  setSkipInactive(skip: boolean): void {
    this.replayer.setConfig({ skipInactive: skip });
  }

  destroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.replayer.destroy();
  }
}
