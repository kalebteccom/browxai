// Rules for the live view on the operator channel: what a `view.start` may ask
// for, how a frame is cut to fit the 64 KiB line limit, and how the stream steps
// down when the daemon is slow. Pure, so each rule is unit-testable without a
// socket or a browser. The stream lifecycle is in `operator-view-hub.ts`.
//
// A frame is page pixels. Nothing in this file logs one or puts any part of one
// in an error: a problem is described by a code.

/** What a `view.start` gets when it leaves a field out. */
export const DEFAULT_VIEW = { maxFps: 5, maxWidth: 960, quality: 60 } as const;

/** What a `view.start` may ask for at most. The daemon's number is clamped to
 *  these, never trusted. */
export const VIEW_CEILING = { maxFps: 5, maxWidth: 1280, quality: 80 } as const;

/** Lowest values a request may name, and the floor the stream adapts down to. */
export const VIEW_FLOOR = { minFps: 0.2, adaptFps: 1, minWidth: 160, adaptWidth: 640 } as const;
export const MIN_QUALITY = 10;

/** Streams running at once in one browxai process. */
export const MAX_STREAMS = 4;

/** A frame is sent as parts of at most this many base64 characters, a multiple
 *  of four so each part decodes alone. 40,960 characters is 30 KiB of JPEG and,
 *  with the envelope, stays far under `MAX_FRAME_BYTES`. */
export const PART_CHARS = 40_960;
/** A frame needing more parts than this is dropped and counts as slowness, so
 *  the stream steps down to a smaller picture. 16 parts is 480 KiB of JPEG. */
export const MAX_PARTS = 16;

/** Bytes a frame may leave unflushed on the socket before the next is dropped. */
export const MAX_UNFLUSHED_BYTES = 16 * 1024;

/** A frame the daemon has not acked after this long is counted lost. */
export const ACK_TIMEOUT_MS = 5_000;
/** No ack at all for this long while frames go out stops the stream. */
export const STALL_STOP_MS = 30_000;

export interface ViewParams {
  maxFps: number;
  maxWidth: number;
  quality: number;
}

export type ViewStartCheck =
  { ok: true; session: string; params: ViewParams } | { ok: false; code: "invalid-view" };

const MAX_SESSION_CHARS = 128;

function num(v: unknown, fallback: number, min: number, max: number): number | null {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

/** Validate one `view.start` frame. A field left out takes its default, a number
 *  outside the range is clamped, and a field of the wrong type refuses the whole
 *  frame. Only JPEG exists. */
export function parseViewStart(f: Record<string, unknown>): ViewStartCheck {
  const bad = { ok: false, code: "invalid-view" } as const;
  const { session, format } = f;
  if (typeof session !== "string" || session.length === 0 || session.length > MAX_SESSION_CHARS) {
    return bad;
  }
  if (format !== undefined && format !== "jpeg") return bad;
  const maxFps = num(f.maxFps, DEFAULT_VIEW.maxFps, VIEW_FLOOR.minFps, VIEW_CEILING.maxFps);
  const maxWidth = num(
    f.maxWidth,
    DEFAULT_VIEW.maxWidth,
    VIEW_FLOOR.minWidth,
    VIEW_CEILING.maxWidth,
  );
  const quality = num(f.quality, DEFAULT_VIEW.quality, MIN_QUALITY, VIEW_CEILING.quality);
  if (maxFps === null || maxWidth === null || quality === null) return bad;
  return { ok: true, session, params: { maxFps, maxWidth: Math.round(maxWidth), quality } };
}

// ---------- adaptive steps ----------

export interface ViewLevel {
  fps: number;
  width: number;
}

const STEPS = 4;

/** The ladder the stream walks: the requested picture first, then three steps
 *  down to 1 fps and 640 px (or to the request itself, when that is already
 *  lower). Quality stays where the daemon put it. */
export function levelsFor(p: ViewParams): ViewLevel[] {
  const floorFps = Math.min(p.maxFps, VIEW_FLOOR.adaptFps);
  const floorWidth = Math.min(p.maxWidth, VIEW_FLOOR.adaptWidth);
  const out: ViewLevel[] = [];
  for (let i = 0; i < STEPS; i++) {
    const t = i / (STEPS - 1);
    const level = {
      fps: Math.round((p.maxFps + (floorFps - p.maxFps) * t) * 10) / 10,
      width: Math.round(p.maxWidth + (floorWidth - p.maxWidth) * t),
    };
    const last = out[out.length - 1];
    if (!last || last.fps !== level.fps || last.width !== level.width) out.push(level);
  }
  return out;
}

/** How often the adapter closes a window of sends and drops. */
export const WINDOW_MS = 2_000;
/** A window with this share of frames dropped (and at least two) steps down. */
const DROP_SHARE = 0.4;
/** Clean windows needed before a step back up: 10 seconds. */
const CLEAN_WINDOWS_TO_RISE = 5;
/** A step up needs the ack round trip under this share of the higher level's
 *  frame interval, so a daemon that only just keeps up at 1 fps does not bounce
 *  to 2 fps and back. */
const RISE_HEADROOM = 0.6;
const RTT_WEIGHT = 0.3;

/** Walks the ladder from what it sees: frames sent, frames dropped and how long
 *  the daemon takes to ack. It decides, and the stream applies. */
export class ViewAdapter {
  readonly levels: ViewLevel[];
  #index = 0;
  #sent = 0;
  #dropped = 0;
  #clean = 0;
  #rtt: number | null = null;

  constructor(params: ViewParams) {
    this.levels = levelsFor(params);
  }

  get level(): ViewLevel {
    return this.levels[this.#index] as ViewLevel;
  }

  noteSent(): void {
    this.#sent++;
  }

  /** A frame that did not go out: the previous one is still unacked, the socket
   *  is backed up, or the frame is too large for the parts allowed. */
  noteDropped(): void {
    this.#dropped++;
  }

  noteAck(rttMs: number): void {
    this.#rtt = this.#rtt === null ? rttMs : this.#rtt * (1 - RTT_WEIGHT) + rttMs * RTT_WEIGHT;
  }

  /** Close a window and say whether the level moved. Called every `WINDOW_MS`. */
  closeWindow(): "down" | "up" | "same" {
    const sent = this.#sent;
    const dropped = this.#dropped;
    this.#sent = 0;
    this.#dropped = 0;
    const total = sent + dropped;
    if (dropped >= 2 && dropped / total >= DROP_SHARE) {
      this.#clean = 0;
      if (this.#index < this.levels.length - 1) {
        this.#index++;
        return "down";
      }
      return "same";
    }
    if (dropped > 0 || sent === 0) {
      this.#clean = 0;
      return "same";
    }
    this.#clean++;
    const higher = this.levels[this.#index - 1];
    if (
      this.#clean >= CLEAN_WINDOWS_TO_RISE &&
      higher &&
      this.#rtt !== null &&
      this.#rtt < (1000 / higher.fps) * RISE_HEADROOM
    ) {
      this.#clean = 0;
      this.#index--;
      return "up";
    }
    return "same";
  }
}

// ---------- frames ----------

/** Width and height from a JPEG's first start-of-frame marker, read from the
 *  first few KiB. Null when the header is not what Chromium writes. */
export function jpegSize(base64: string): { width: number; height: number } | null {
  const head = Buffer.from(base64.slice(0, 12_000), "base64");
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < head.length) {
    if (head[i] !== 0xff) return null;
    const marker = head[i + 1] as number;
    if (marker === 0xff) {
      i++;
      continue;
    }
    // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: head.readUInt16BE(i + 5), width: head.readUInt16BE(i + 7) };
    }
    i += 2 + head.readUInt16BE(i + 2);
  }
  return null;
}

export interface FrameMeta {
  session: string;
  seq: number;
  at: number;
}

/** One screencast frame as the wire frames that carry it, each under the 64 KiB
 *  line limit. Null when the frame needs more than `MAX_PARTS`. A frame that
 *  fits in one part is a single frame with `part: 0, parts: 1`. */
export function frameParts(meta: FrameMeta, base64: string): Array<Record<string, unknown>> | null {
  const parts = Math.max(1, Math.ceil(base64.length / PART_CHARS));
  if (parts > MAX_PARTS) return null;
  const size = jpegSize(base64);
  const out: Array<Record<string, unknown>> = [];
  for (let part = 0; part < parts; part++) {
    out.push({
      type: "frame",
      session: meta.session,
      seq: meta.seq,
      at: meta.at,
      format: "jpeg",
      ...(size ?? {}),
      part,
      parts,
      data: base64.slice(part * PART_CHARS, (part + 1) * PART_CHARS),
    });
  }
  return out;
}
