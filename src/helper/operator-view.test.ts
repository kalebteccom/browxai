import { describe, it, expect } from "vitest";
import { MAX_FRAME_BYTES } from "./operator-protocol.js";
import {
  MAX_PARTS,
  PART_CHARS,
  ViewAdapter,
  frameParts,
  jpegSize,
  levelsFor,
  parseViewStart,
} from "./operator-view.js";

/** A JPEG header with a SOF0 marker for `w` x `h`, then padding. */
function jpegOf(w: number, h: number, extra = 0): string {
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    h >> 8,
    h & 255,
    w >> 8,
    w & 255,
    0x01,
    0x01,
    0x11,
    0x00,
  ]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(extra)]).toString(
    "base64",
  );
}

describe("parseViewStart", () => {
  it("takes 5 fps, 960 px and quality 60 when the daemon names nothing", () => {
    expect(parseViewStart({ session: "default" })).toEqual({
      ok: true,
      session: "default",
      params: { maxFps: 5, maxWidth: 960, quality: 60 },
    });
  });

  it("clamps what the daemon asks for to the ceiling and the floor", () => {
    const high = parseViewStart({ session: "s", maxFps: 60, maxWidth: 4000, quality: 100 });
    expect(high).toMatchObject({ params: { maxFps: 5, maxWidth: 1280, quality: 80 } });
    const low = parseViewStart({ session: "s", maxFps: 0, maxWidth: 1, quality: -5 });
    expect(low).toMatchObject({ params: { maxFps: 0.2, maxWidth: 160, quality: 10 } });
  });

  it("keeps a request under the ceiling as asked", () => {
    expect(
      parseViewStart({ session: "s", maxFps: 2, maxWidth: 800, quality: 50, format: "jpeg" }),
    ).toMatchObject({ ok: true, params: { maxFps: 2, maxWidth: 800, quality: 50 } });
  });

  it("refuses a missing or oversized session, a wrong type and a format other than jpeg", () => {
    const bad = { ok: false, code: "invalid-view" };
    expect(parseViewStart({})).toEqual(bad);
    expect(parseViewStart({ session: "" })).toEqual(bad);
    expect(parseViewStart({ session: "x".repeat(129) })).toEqual(bad);
    expect(parseViewStart({ session: "s", maxFps: "5" })).toEqual(bad);
    expect(parseViewStart({ session: "s", maxWidth: Number.NaN })).toEqual(bad);
    expect(parseViewStart({ session: "s", quality: Infinity })).toEqual(bad);
    expect(parseViewStart({ session: "s", format: "png" })).toEqual(bad);
  });
});

describe("levelsFor", () => {
  it("walks from the request to 1 fps and 640 px", () => {
    const levels = levelsFor({ maxFps: 5, maxWidth: 960, quality: 60 });
    expect(levels[0]).toEqual({ fps: 5, width: 960 });
    expect(levels[levels.length - 1]).toEqual({ fps: 1, width: 640 });
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]!.fps).toBeLessThan(levels[i - 1]!.fps);
      expect(levels[i]!.width).toBeLessThan(levels[i - 1]!.width);
    }
  });

  it("does not go below a request that is already under the floor", () => {
    expect(levelsFor({ maxFps: 0.5, maxWidth: 400, quality: 60 })).toEqual([
      { fps: 0.5, width: 400 },
    ]);
  });
});

describe("ViewAdapter", () => {
  const params = { maxFps: 5, maxWidth: 960, quality: 60 };

  function window(a: ViewAdapter, sent: number, dropped: number): string {
    for (let i = 0; i < sent; i++) a.noteSent();
    for (let i = 0; i < dropped; i++) a.noteDropped();
    return a.closeWindow();
  }

  it("steps down when a window drops 40% of its frames, and stops at the floor", () => {
    const a = new ViewAdapter(params);
    expect(a.level).toEqual({ fps: 5, width: 960 });
    expect(window(a, 5, 5)).toBe("down");
    expect(a.level.fps).toBeLessThan(5);
    for (let i = 0; i < 10; i++) window(a, 1, 9);
    expect(a.level).toEqual({ fps: 1, width: 640 });
    expect(window(a, 1, 9)).toBe("same");
  });

  it("holds a window with one stray drop", () => {
    const a = new ViewAdapter(params);
    expect(window(a, 4, 1)).toBe("same");
    expect(window(a, 0, 2)).toBe("down");
  });

  it("steps back up only after ten clean seconds and with room in the ack round trip", () => {
    const a = new ViewAdapter(params);
    window(a, 1, 9);
    a.noteAck(40);
    for (let i = 0; i < 4; i++) expect(window(a, 6, 0)).toBe("same");
    expect(window(a, 6, 0)).toBe("up");
    expect(a.level).toEqual({ fps: 5, width: 960 });
  });

  it("stays down while the ack round trip is too slow for the level above", () => {
    const a = new ViewAdapter(params);
    window(a, 1, 9);
    a.noteAck(900);
    for (let i = 0; i < 12; i++) expect(window(a, 2, 0)).toBe("same");
    expect(a.level.fps).toBeLessThan(5);
  });

  it("restarts the clean count after a drop", () => {
    const a = new ViewAdapter(params);
    window(a, 1, 9);
    a.noteAck(40);
    for (let i = 0; i < 4; i++) window(a, 6, 0);
    window(a, 5, 1);
    for (let i = 0; i < 4; i++) expect(window(a, 6, 0)).toBe("same");
  });
});

describe("jpegSize", () => {
  it("reads the frame size from the start-of-frame marker", () => {
    expect(jpegSize(jpegOf(960, 540))).toEqual({ width: 960, height: 540 });
  });

  it("answers null for data that is not a JPEG", () => {
    expect(jpegSize(Buffer.from("not an image").toString("base64"))).toBeNull();
    expect(jpegSize("")).toBeNull();
  });
});

describe("frameParts", () => {
  const meta = { session: "default", seq: 7, at: 1_790_000_000_000 };

  it("sends a small frame as one part with its size", () => {
    const data = jpegOf(800, 600, 1_000);
    expect(frameParts(meta, data)).toEqual([
      {
        type: "frame",
        session: "default",
        seq: 7,
        at: 1_790_000_000_000,
        format: "jpeg",
        width: 800,
        height: 600,
        part: 0,
        parts: 1,
        data,
      },
    ]);
  });

  it("splits a large frame into parts that join back to it, each under the line limit", () => {
    const data = jpegOf(960, 700, 100_000);
    const parts = frameParts({ ...meta, session: '"'.repeat(128) }, data)!;
    expect(parts.length).toBe(Math.ceil(data.length / PART_CHARS));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((p) => p.data).join("")).toBe(data);
    for (const [i, p] of parts.entries()) {
      expect(p).toMatchObject({ part: i, parts: parts.length, seq: 7 });
      expect(Buffer.byteLength(JSON.stringify({ v: 1, ...p }))).toBeLessThan(MAX_FRAME_BYTES);
      // Each part decodes alone.
      expect(Buffer.from(p.data as string, "base64").toString("base64")).toBe(p.data);
    }
  });

  it("holds the worst case under the line limit: a full part, the longest session, escaped", () => {
    const parts = frameParts(
      { session: '"'.repeat(128), seq: Number.MAX_SAFE_INTEGER, at: Date.now() },
      "A".repeat(PART_CHARS * 2),
    )!;
    const line = JSON.stringify({ v: 1, ...parts[0] });
    expect(Buffer.byteLength(line)).toBeLessThan(MAX_FRAME_BYTES - 20_000);
  });

  it("drops a frame that would need more than the parts allowed", () => {
    expect(frameParts(meta, "A".repeat(PART_CHARS * MAX_PARTS))).not.toBeNull();
    expect(frameParts(meta, "A".repeat(PART_CHARS * MAX_PARTS + 4))).toBeNull();
  });
});
