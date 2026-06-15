// canvas_diff — pixel/region delta between two RGBA captures. Pure function
// over bytes; no page contact. (See canvas.ts header for the tool overview.)

export interface CanvasDiffRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasDiffArgs {
  /** Base64 RGBA bytes (or PNG — see note below) from a prior capture. */
  beforeBase64: string;
  /** Base64 RGBA bytes (or PNG) from a later capture. */
  afterBase64: string;
  /** Optional sub-rectangle (in pixels, top-left origin). When omitted,
   *  the diff covers the whole image. */
  region?: CanvasDiffRegion;
  /** Pixel dimensions of the two captures. Required when both inputs are
   *  RGBA bytes — the byte buffer alone does not carry width/height. */
  width?: number;
  height?: number;
  /** Tag the inputs explicitly when known. Defaults to `rgba`; pass
   *  `png` to surface the PNG-decode caveat in the warnings. */
  inputFormat?: "rgba" | "png";
}

export interface CanvasDiffResult {
  ok: boolean;
  /** Number of pixels with any RGBA channel differing between before/
   *  after within the region. For PNG inputs (no decode this cycle),
   *  reports 0 when the base64 strings match byte-for-byte, otherwise
   *  the total pixel count of the region and surfaces a warning. */
  changedPixelCount: number;
  /** Sum of absolute per-channel differences across all changed pixels
   *  (cap-summed at 4 channels per pixel). Useful for "how much
   *  changed", not just "did anything". */
  changedBytes: number;
  /** Ratio of changed pixels to total pixels in the region (0..1). */
  percentageChanged: number;
  /** Tight bounding box of the changed area, in image coordinates. Null
   *  when no pixels changed. */
  bboxOfChanges: { x: number; y: number; w: number; h: number } | null;
  warnings: string[];
  error?: string;
  code?: string;
}

/** Pure function — pixel diff math on two RGBA byte buffers. Exposed for
 *  unit tests; the MCP handler in server.ts unwraps the base64. */
export function diffRgba(
  before: Uint8Array,
  after: Uint8Array,
  width: number,
  height: number,
  region?: CanvasDiffRegion,
): Omit<CanvasDiffResult, "warnings" | "error" | "code"> {
  const expected = width * height * 4;
  if (before.length !== expected || after.length !== expected) {
    return {
      ok: false,
      changedPixelCount: 0,
      changedBytes: 0,
      percentageChanged: 0,
      bboxOfChanges: null,
    };
  }
  const r = region ?? { x: 0, y: 0, w: width, h: height };
  // Clamp the region to image bounds (an over-flow region collapses
  // into the available pixel rectangle rather than throwing).
  const x0 = Math.max(0, Math.min(width, Math.floor(r.x)));
  const y0 = Math.max(0, Math.min(height, Math.floor(r.y)));
  const x1 = Math.max(0, Math.min(width, Math.floor(r.x + r.w)));
  const y1 = Math.max(0, Math.min(height, Math.floor(r.y + r.h)));
  if (x1 <= x0 || y1 <= y0) {
    return {
      ok: true,
      changedPixelCount: 0,
      changedBytes: 0,
      percentageChanged: 0,
      bboxOfChanges: null,
    };
  }

  let changed = 0;
  let bytes = 0;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const totalPixels = (x1 - x0) * (y1 - y0);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = (y * width + x) * 4;
      const r0 = before[idx]!,
        g0 = before[idx + 1]!,
        b0 = before[idx + 2]!,
        a0 = before[idx + 3]!;
      const r1 = after[idx]!,
        g1 = after[idx + 1]!,
        b1 = after[idx + 2]!,
        a1 = after[idx + 3]!;
      const d = Math.abs(r1 - r0) + Math.abs(g1 - g0) + Math.abs(b1 - b0) + Math.abs(a1 - a0);
      if (d !== 0) {
        changed++;
        bytes += d;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  return {
    ok: true,
    changedPixelCount: changed,
    changedBytes: bytes,
    percentageChanged: totalPixels === 0 ? 0 : changed / totalPixels,
    bboxOfChanges:
      changed === 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

export function canvasDiff(args: CanvasDiffArgs): CanvasDiffResult {
  const warnings: string[] = [];
  const inputFormat = args.inputFormat ?? "rgba";

  // PNG path (deferred — just compare base64 byte equality this cycle).
  // The roadmap note in the spec: "for PNG format inputs: document that
  // PNG-decoded-pixel diff is a follow-up (just compare base64 byte
  // equality for now and surface a warning when inputs are PNG instead
  // of RGBA)."
  if (inputFormat === "png") {
    warnings.push(
      "PNG-decoded pixel diff is a follow-up — this cycle compares base64 byte equality only. " +
        "For per-pixel + bbox math, recapture with format:'2d-imagedata' or format:'webgl-framebuffer'.",
    );
    const same = args.beforeBase64 === args.afterBase64;
    return {
      ok: true,
      changedPixelCount: same ? 0 : 1,
      changedBytes: same ? 0 : 1,
      percentageChanged: same ? 0 : 1,
      bboxOfChanges: null,
      warnings,
    };
  }

  if (args.width === undefined || args.height === undefined) {
    return {
      ok: false,
      changedPixelCount: 0,
      changedBytes: 0,
      percentageChanged: 0,
      bboxOfChanges: null,
      warnings,
      error:
        "canvas_diff with format:'rgba' inputs requires width + height — the byte buffer does not carry dimensions",
      code: "missing-dimensions",
    };
  }

  let before: Uint8Array;
  let after: Uint8Array;
  try {
    before = Buffer.from(args.beforeBase64, "base64");
    after = Buffer.from(args.afterBase64, "base64");
  } catch (e) {
    return {
      ok: false,
      changedPixelCount: 0,
      changedBytes: 0,
      percentageChanged: 0,
      bboxOfChanges: null,
      warnings,
      error:
        "canvas_diff: failed to base64-decode an input — " +
        (e instanceof Error ? e.message : String(e)),
      code: "decode-failed",
    };
  }

  const expected = args.width * args.height * 4;
  if (before.length !== expected || after.length !== expected) {
    return {
      ok: false,
      changedPixelCount: 0,
      changedBytes: 0,
      percentageChanged: 0,
      bboxOfChanges: null,
      warnings,
      error: `canvas_diff: RGBA byte length mismatch — got before=${before.length}, after=${after.length}, expected ${expected} (width*height*4)`,
      code: "shape-mismatch",
    };
  }

  const r = diffRgba(before, after, args.width, args.height, args.region);
  return { ...r, warnings };
}
