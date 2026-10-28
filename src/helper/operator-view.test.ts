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
  const bad = { ok: false, code: "invalid-view" };

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    [
      "takes 5 fps, 960 px and quality 60 when the daemon names nothing",
      { session: "default" },
      { ok: true, session: "default", params: { maxFps: 5, maxWidth: 960, quality: 60 } },
    ],
    [
      "clamps what the daemon asks for to the ceiling",
      { session: "s", maxFps: 60, maxWidth: 4000, quality: 100 },
      { params: { maxFps: 5, maxWidth: 1280, quality: 80 } },
    ],
    [
      "clamps what the daemon asks for to the floor",
      { session: "s", maxFps: 0, maxWidth: 1, quality: -5 },
      { params: { maxFps: 0.2, maxWidth: 160, quality: 10 } },
    ],
    ["refuses a missing session", {}, bad],
    ["refuses an oversized session", { session: "x".repeat(129) }, bad],
    ["refuses a string fps", { session: "s", maxFps: "5" }, bad],
    ["refuses a NaN width", { session: "s", maxWidth: Number.NaN }, bad],
    ["refuses a format other than jpeg", { session: "s", format: "png" }, bad],
  ])("%s", (_label, input, expected) => {
    // Rows that name `ok` pin the whole result; the clamp rows pin `params` only.
    if (expected.ok !== undefined) expect(parseViewStart(input)).toEqual(expected);
    else expect(parseViewStart(input)).toMatchObject(expected);
  });
});

describe("levelsFor", () => {
  it.each<
    [
      string,
      { maxFps: number; maxWidth: number; quality: number },
      Array<{ fps: number; width: number }>,
    ]
  >([
    [
      "walks from the request to 1 fps and 640 px",
      { maxFps: 5, maxWidth: 960, quality: 60 },
      [
        { fps: 5, width: 960 },
        { fps: 1, width: 640 },
      ],
    ],
    [
      "does not go below a request that is already under the floor",
      { maxFps: 0.5, maxWidth: 400, quality: 60 },
      [{ fps: 0.5, width: 400 }],
    ],
  ])("%s", (_label, request, ends) => {
    const levels = levelsFor(request);
    expect(levels[0]).toEqual(ends[0]);
    expect(levels[levels.length - 1]).toEqual(ends[ends.length - 1]);
    if (ends.length === 1) expect(levels).toEqual(ends);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]!.fps).toBeLessThan(levels[i - 1]!.fps);
      expect(levels[i]!.width).toBeLessThan(levels[i - 1]!.width);
    }
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
  it.each<[string, string, { width: number; height: number } | null]>([
    [
      "reads the frame size from the start-of-frame marker",
      jpegOf(960, 540),
      { width: 960, height: 540 },
    ],
    [
      "answers null for text that is not a JPEG",
      Buffer.from("not an image").toString("base64"),
      null,
    ],
    ["answers null for empty data", "", null],
  ])("%s", (_label, data, expected) => {
    expect(jpegSize(data)).toEqual(expected);
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

  it("drops a frame that would need more than the parts allowed", () => {
    expect(frameParts(meta, "A".repeat(PART_CHARS * MAX_PARTS))).not.toBeNull();
    expect(frameParts(meta, "A".repeat(PART_CHARS * MAX_PARTS + 4))).toBeNull();
  });
});
