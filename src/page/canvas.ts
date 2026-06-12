/// <reference lib="dom" />
// Canvas-app automation primitives — capability `canvas`.
//
// The substrate. Five MCP tools + a pure-math diff:
//
//   - `canvas_capture`           — framebuffer / 2D ImageData / PNG bytes
//                                  of a `<canvas>` element. App-agnostic.
//   - `canvas_diff`              — pixel/region delta between two RGBA
//                                  captures. Pure function over bytes;
//                                  no page contact.
//   - `gesture_chain`            — multi-step pointer program (down /
//                                  move / wheel / wait / up). Custom
//                                  paint strokes, lasso paths, gestures
//                                  the canned `drag` / `gesture_swipe`
//                                  family doesn't cover.
//   - `canvas_world_to_screen` + `canvas_screen_to_world` —
//                                  affine transform helpers, two modes:
//                                  explicit (caller passes transform)
//                                  or discovery (probe common app-side
//                                  globals — Figma / Tldraw / Excalidraw
//                                  shapes; documented as heuristic).
//   - `canvas_query`             — dispatcher to a canvas-app adapter
//                                  plugin. The router lives in
//                                  server.ts (it has the plugin handler
//                                  map); only the structured no-adapter
//                                  error shape lives here.
//
// Design principle (project-wide, see CLAUDE.md
// `feedback_design_for_problem_class`): the primitives are app-agnostic.
// Discovery probes common globals — those are HEURISTIC; the structured
// failure path tells the caller to pass `transform` explicitly OR install
// a canvas-app adapter plugin.
//
// BYO-vision pattern (docs only this cycle, see docs/tool-reference.md
// "Canvas-app automation — BYO vision pattern"): browxai does NOT bundle
// OCR or a hosted vision API. `canvas_capture` is the pixel source;
// composition with the host agent's own multimodal vision is the loop.
//
// Bounded:
//   - canvas_capture refuses canvases larger than 16384×16384 pixels
//     (a defensive cap — most editors cap their own canvas allocation
//     well below this; a multi-megapixel buffer round-tripped through
//     base64 is genuinely a problem).
//   - gesture_chain caps at 200 steps, floors `move` step delays at 5 ms,
//     bounds `wait` steps at 5000 ms.

// ---------- canvas_capture ----------

export type CanvasFormat = "png" | "webgl-framebuffer" | "2d-imagedata";

export interface CanvasCaptureArgs {
  /** Stable ref of the target `<canvas>` element (from snapshot/find).
   *  Omit to capture the first `<canvas>` in the document. */
  ref?: string;
  /** Optional CSS selector used as a fallback when `ref` lookup fails
   *  (or for callers who want a raw selector path). Honoured by the
   *  page-side capture function. */
  selector?: string;
  /** Output format. */
  format: CanvasFormat;
}

export interface CanvasCapturePngResult {
  ok: true;
  format: "png";
  /** Base64-encoded PNG bytes. */
  contentBase64: string;
  byteLength: number;
  width: number;
  height: number;
}

export interface CanvasCaptureRgbaResult {
  ok: true;
  format: "2d-imagedata" | "webgl-framebuffer";
  /** Base64-encoded RGBA byte array (row-major, top-left origin for
   *  2d-imagedata; for webgl-framebuffer, the page-side capture flips
   *  the readPixels result into top-left order to match imagedata's
   *  convention, so downstream `canvas_diff` math is consistent). */
  contentBase64: string;
  width: number;
  height: number;
  channelCount: 4;
  /** Only set for `webgl-framebuffer` so the caller can tell the two
   *  RGBA formats apart on result. */
  isWebGL?: true;
}

export type CanvasCaptureResult =
  | CanvasCapturePngResult
  | CanvasCaptureRgbaResult
  | { ok: false; error: string; code?: string };

/** Max canvas dimensions accepted by `canvas_capture`. Larger canvases
 *  refuse with a structured error rather than allocating a giant byte
 *  payload. 16384 matches Chromium's `max_texture_size` for most
 *  hardware — a `<canvas>` larger than this would not paint correctly
 *  anyway. */
export const CANVAS_MAX_DIMENSION = 16384;

/** Page-side capture function — REAL function literal (NOT stringified).
 *  Playwright's `page.evaluate(fn, arg)` serializes the source + invokes
 *  in-page with the arg. Mirror of the pattern used in `dom_export` /
 *  `element_export` / `overflow_detect` — a stringified arrow function
 *  evaluates to the function value uncalled, which CDP can't serialize.
 *
 *  Returns a structured discriminated union (mirror of CanvasCaptureResult)
 *  so the host side can pass it straight back. */
export const PAGE_CAPTURE_FN = (args: {
  ref?: string;
  selector?: string;
  format: CanvasFormat;
  maxDimension: number;
}): {
  ok: boolean;
  format?: CanvasFormat;
  contentBase64?: string;
  byteLength?: number;
  width?: number;
  height?: number;
  channelCount?: number;
  isWebGL?: boolean;
  error?: string;
  code?: string;
} => {
  // Locate the target canvas. Try selector first when supplied, then the
  // ref via the page's stable-ref data attribute, then the first <canvas>.
  let canvas: HTMLCanvasElement | null = null;
  if (args.selector) {
    try {
      const found = document.querySelector(args.selector);
      if (found && found.tagName.toLowerCase() === "canvas") {
        canvas = found as HTMLCanvasElement;
      }
    } catch (_) {
      /* ignore — fall through */
    }
  }
  if (!canvas && args.ref) {
    try {
      const found = document.querySelector(`[data-browx-ref="${args.ref}"]`);
      if (found && found.tagName.toLowerCase() === "canvas") {
        canvas = found as HTMLCanvasElement;
      }
    } catch (_) {
      /* ignore */
    }
  }
  if (!canvas) {
    const all = document.getElementsByTagName("canvas");
    if (all.length > 0) canvas = all[0] as HTMLCanvasElement;
  }
  if (!canvas) {
    return {
      ok: false,
      error:
        "no <canvas> element found on the page (ref/selector did not match and no fallback canvas exists)",
      code: "no-canvas",
    };
  }
  const w = canvas.width;
  const h = canvas.height;
  if (w <= 0 || h <= 0) {
    return {
      ok: false,
      error: `canvas dimensions are non-positive (${w}x${h})`,
      code: "bad-dimensions",
    };
  }
  if (w > args.maxDimension || h > args.maxDimension) {
    return {
      ok: false,
      error: `canvas dimensions ${w}x${h} exceed the maximum ${args.maxDimension}x${args.maxDimension} cap`,
      code: "too-large",
    };
  }

  if (args.format === "png") {
    try {
      const dataUrl = canvas.toDataURL("image/png");
      const idx = dataUrl.indexOf("base64,");
      if (idx < 0) {
        return {
          ok: false,
          error: "toDataURL did not return a base64 payload",
          code: "encode-failed",
        };
      }
      const b64 = dataUrl.slice(idx + 7);
      // Byte length of decoded PNG ≈ b64.length * 3/4 (minus padding).
      let pad = 0;
      if (b64.endsWith("==")) pad = 2;
      else if (b64.endsWith("=")) pad = 1;
      const byteLength = Math.floor((b64.length * 3) / 4) - pad;
      return { ok: true, format: "png", contentBase64: b64, byteLength, width: w, height: h };
    } catch (e) {
      // toDataURL throws SecurityError on tainted canvases (cross-origin
      // images without CORS). Surface a clean shape.
      return {
        ok: false,
        error: "canvas.toDataURL failed: " + ((e as Error)?.message || String(e)),
        code: "taint-or-encode",
      };
    }
  }

  // Helper — base64-encode a Uint8Array using only DOM-available builtins.
  // btoa wants binary string input; build it in chunks so we don't blow
  // the call stack on huge buffers.
  function bytesToB64(bytes: Uint8Array): string {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
      // String.fromCharCode.apply with a typed-array view is supported
      // in every modern engine; the chunk keeps argv small.
      binary += String.fromCharCode.apply(null, Array.prototype.slice.call(slice));
    }
    return btoa(binary);
  }

  if (args.format === "2d-imagedata") {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return {
        ok: false,
        error:
          'canvas has no 2d context (likely a WebGL/WebGPU canvas — try format:"webgl-framebuffer")',
        code: "no-2d-context",
      };
    }
    try {
      const data = ctx.getImageData(0, 0, w, h);
      const bytes = new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength);
      const b64 = bytesToB64(bytes);
      return {
        ok: true,
        format: "2d-imagedata",
        contentBase64: b64,
        width: w,
        height: h,
        channelCount: 4,
      };
    } catch (e) {
      return {
        ok: false,
        error: "getImageData failed: " + ((e as Error)?.message || String(e)),
        code: "taint-or-read",
      };
    }
  }

  // webgl-framebuffer — read the backbuffer via gl.readPixels.
  // Try webgl2 first then webgl.
  let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  // Some apps configure preserveDrawingBuffer:false — readPixels then
  // returns blank because the compositor cleared the buffer. The caller
  // sees zero-bytes on diff in that case; we can't undo it without
  // recreating the context.
  try {
    gl = canvas.getContext("webgl2", {
      preserveDrawingBuffer: true,
    });
  } catch (_) {
    gl = null;
  }
  if (!gl) {
    try {
      gl = canvas.getContext("webgl", {
        preserveDrawingBuffer: true,
      });
    } catch (_) {
      gl = null;
    }
  }
  if (!gl) {
    return {
      ok: false,
      error: 'canvas has no webgl/webgl2 context (try format:"2d-imagedata" for a 2D canvas)',
      code: "no-webgl-context",
    };
  }
  try {
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    // WebGL's coordinate origin is bottom-left; flip into top-left order
    // so downstream `canvas_diff` math is consistent with the imagedata
    // format (and with PNG / typical screenshot conventions).
    const flipped = new Uint8Array(w * h * 4);
    const stride = w * 4;
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * stride;
      const dst = y * stride;
      flipped.set(pixels.subarray(src, src + stride), dst);
    }
    const b64 = bytesToB64(flipped);
    return {
      ok: true,
      format: "webgl-framebuffer",
      contentBase64: b64,
      width: w,
      height: h,
      channelCount: 4,
      isWebGL: true,
    };
  } catch (e) {
    return {
      ok: false,
      error: "webgl readPixels failed: " + ((e as Error)?.message || String(e)),
      code: "webgl-read-failed",
    };
  }
};

/** Thin adapter so unit tests can stub `page.evaluate` without launching
 *  Chromium. */
export interface CanvasCapturePage {
  evaluate<T, Arg>(fn: (arg: Arg) => T | Promise<T>, args?: Arg): Promise<T>;
}

export async function canvasCapture(
  page: CanvasCapturePage,
  args: CanvasCaptureArgs,
): Promise<CanvasCaptureResult> {
  const r = await page.evaluate(PAGE_CAPTURE_FN, {
    ref: args.ref,
    selector: args.selector,
    format: args.format,
    maxDimension: CANVAS_MAX_DIMENSION,
  });
  if (!r.ok)
    return {
      ok: false,
      error: r.error ?? "canvas_capture failed",
      ...(r.code ? { code: r.code } : {}),
    };
  if (r.format === "png") {
    return {
      ok: true,
      format: "png",
      contentBase64: r.contentBase64!,
      byteLength: r.byteLength!,
      width: r.width!,
      height: r.height!,
    };
  }
  const out: CanvasCaptureRgbaResult = {
    ok: true,
    format: r.format as "2d-imagedata" | "webgl-framebuffer",
    contentBase64: r.contentBase64!,
    width: r.width!,
    height: r.height!,
    channelCount: 4,
  };
  if (r.isWebGL) out.isWebGL = true;
  return out;
}

// ---------- canvas_diff ----------

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

// ---------- gesture_chain ----------

export type GestureChainStepKind = "down" | "move" | "up" | "wait" | "wheel";

export interface GestureChainStep {
  kind: GestureChainStepKind;
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  ms?: number;
  pointerId?: number;
}

export interface GestureChainArgs {
  steps: GestureChainStep[];
}

export interface GestureChainResult {
  ok: boolean;
  stepsExecuted: number;
  totalDurationMs: number;
  warnings: string[];
  error?: string;
  code?: string;
}

export const GESTURE_CHAIN_MAX_STEPS = 200;
export const GESTURE_CHAIN_MIN_MOVE_MS = 5;
export const GESTURE_CHAIN_MAX_WAIT_MS = 5000;

/** Validate + clamp a gesture-chain step list. Pure function — returns
 *  the normalised step list + any warnings the runtime should surface.
 *  Hard caps (max steps) refuse loudly; soft caps (min move ms, max wait
 *  ms) clamp + warn. */
export function validateGestureChain(steps: GestureChainStep[]): {
  ok: boolean;
  steps: GestureChainStep[];
  warnings: string[];
  error?: string;
  code?: string;
} {
  const warnings: string[] = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    return {
      ok: false,
      steps: [],
      warnings,
      error: "gesture_chain: `steps` must be a non-empty array",
      code: "no-steps",
    };
  }
  if (steps.length > GESTURE_CHAIN_MAX_STEPS) {
    return {
      ok: false,
      steps: [],
      warnings,
      error: `gesture_chain: ${steps.length} steps exceeds the maximum ${GESTURE_CHAIN_MAX_STEPS}; split the program across multiple calls`,
      code: "too-many-steps",
    };
  }
  const out: GestureChainStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (!s || typeof s.kind !== "string") {
      return {
        ok: false,
        steps: [],
        warnings,
        error: `gesture_chain: step[${i}] missing kind`,
        code: "bad-step",
      };
    }
    const clamped: GestureChainStep = { kind: s.kind };
    if (s.kind === "down" || s.kind === "up" || s.kind === "move") {
      if (typeof s.x !== "number" || typeof s.y !== "number") {
        return {
          ok: false,
          steps: [],
          warnings,
          error: `gesture_chain: step[${i}] kind="${s.kind}" requires numeric x + y`,
          code: "bad-step",
        };
      }
      clamped.x = s.x;
      clamped.y = s.y;
      if (s.pointerId !== undefined) clamped.pointerId = s.pointerId;
      if (s.kind === "move") {
        const ms = typeof s.ms === "number" ? s.ms : GESTURE_CHAIN_MIN_MOVE_MS;
        if (ms < GESTURE_CHAIN_MIN_MOVE_MS) {
          warnings.push(
            `gesture_chain: step[${i}] move ms=${ms} floored to ${GESTURE_CHAIN_MIN_MOVE_MS}ms — tighter pacing rarely changes app behaviour and starves the renderer`,
          );
          clamped.ms = GESTURE_CHAIN_MIN_MOVE_MS;
        } else {
          clamped.ms = ms;
        }
      }
    } else if (s.kind === "wait") {
      const ms = typeof s.ms === "number" ? s.ms : 0;
      if (ms < 0) {
        return {
          ok: false,
          steps: [],
          warnings,
          error: `gesture_chain: step[${i}] wait ms must be non-negative`,
          code: "bad-step",
        };
      }
      if (ms > GESTURE_CHAIN_MAX_WAIT_MS) {
        warnings.push(
          `gesture_chain: step[${i}] wait ms=${ms} clamped to max ${GESTURE_CHAIN_MAX_WAIT_MS}ms — a single chained wait should not exceed 5s; split across calls`,
        );
        clamped.ms = GESTURE_CHAIN_MAX_WAIT_MS;
      } else {
        clamped.ms = ms;
      }
    } else if (s.kind === "wheel") {
      const dx = typeof s.deltaX === "number" ? s.deltaX : 0;
      const dy = typeof s.deltaY === "number" ? s.deltaY : 0;
      if (dx === 0 && dy === 0) {
        return {
          ok: false,
          steps: [],
          warnings,
          error: `gesture_chain: step[${i}] wheel requires non-zero deltaX or deltaY`,
          code: "bad-step",
        };
      }
      clamped.deltaX = dx;
      clamped.deltaY = dy;
      if (typeof s.x === "number") clamped.x = s.x;
      if (typeof s.y === "number") clamped.y = s.y;
    } else {
      return {
        ok: false,
        steps: [],
        warnings,
        error: `gesture_chain: step[${i}] unknown kind "${String(s.kind)}"`,
        code: "bad-step",
      };
    }
    out.push(clamped);
  }
  return { ok: true, steps: out, warnings };
}

/** Thin adapter so unit tests can stub Playwright's `page.mouse`. */
export interface GestureChainPage {
  mouse: {
    down(options?: { button?: "left" | "right" | "middle" }): Promise<void>;
    move(x: number, y: number, options?: { steps?: number }): Promise<void>;
    up(options?: { button?: "left" | "right" | "middle" }): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
}

/** Execute a validated step list against a Playwright page mouse. */
export async function runGestureChain(
  page: GestureChainPage,
  args: GestureChainArgs,
): Promise<GestureChainResult> {
  const v = validateGestureChain(args.steps);
  if (!v.ok) {
    return {
      ok: false,
      stepsExecuted: 0,
      totalDurationMs: 0,
      warnings: v.warnings,
      ...(v.error ? { error: v.error } : {}),
      ...(v.code ? { code: v.code } : {}),
    };
  }
  const started = Date.now();
  let executed = 0;
  for (const s of v.steps) {
    if (s.kind === "down") {
      // Position the pointer at the down point so the press lands where
      // the caller asked. Playwright's mouse.down() acts at the current
      // pointer position only.
      await page.mouse.move(s.x!, s.y!);
      await page.mouse.down();
    } else if (s.kind === "up") {
      await page.mouse.move(s.x!, s.y!);
      await page.mouse.up();
    } else if (s.kind === "move") {
      await page.mouse.move(s.x!, s.y!);
      if (s.ms && s.ms > 0) {
        await new Promise((r) => setTimeout(r, s.ms));
      }
    } else if (s.kind === "wait") {
      if (s.ms && s.ms > 0) {
        await new Promise((r) => setTimeout(r, s.ms));
      }
    } else if (s.kind === "wheel") {
      if (typeof s.x === "number" && typeof s.y === "number") {
        await page.mouse.move(s.x, s.y);
      }
      await page.mouse.wheel(s.deltaX ?? 0, s.deltaY ?? 0);
    }
    executed++;
  }
  return {
    ok: true,
    stepsExecuted: executed,
    totalDurationMs: Date.now() - started,
    warnings: v.warnings,
  };
}

// ---------- canvas_world_to_screen / canvas_screen_to_world ----------

export interface CanvasTransform {
  scale: number;
  panX: number;
  panY: number;
  /** Optional origin offsets — added after the scale/pan. Default 0. */
  originX?: number;
  originY?: number;
}

export type CanvasAdapterHint = "figma" | "tldraw" | "excalidraw" | "generic";

export interface CanvasWorldToScreenArgs {
  worldX: number;
  worldY: number;
  ref?: string;
  selector?: string;
  transform?: CanvasTransform;
}

export interface CanvasScreenToWorldArgs {
  screenX: number;
  screenY: number;
  ref?: string;
  selector?: string;
  transform?: CanvasTransform;
}

export interface CanvasWorldToScreenResult {
  ok: boolean;
  screenX?: number;
  screenY?: number;
  transformDiscovered?: CanvasTransform;
  adapterHint?: CanvasAdapterHint;
  warnings?: string[];
  error?: string;
  code?: string;
}

export interface CanvasScreenToWorldResult {
  ok: boolean;
  worldX?: number;
  worldY?: number;
  transformDiscovered?: CanvasTransform;
  adapterHint?: CanvasAdapterHint;
  warnings?: string[];
  error?: string;
  code?: string;
}

/** Pure math — apply an affine transform to a world point.
 *  `screen = (world + pan) * scale + origin`. Documented this way (rather
 *  than the matrix form) because that's the shape the discovery probes
 *  return for the three named editors. */
export function applyWorldToScreen(
  world: { x: number; y: number },
  t: CanvasTransform,
): { x: number; y: number } {
  const ox = t.originX ?? 0;
  const oy = t.originY ?? 0;
  return {
    x: (world.x + t.panX) * t.scale + ox,
    y: (world.y + t.panY) * t.scale + oy,
  };
}

/** Inverse: `world = (screen - origin) / scale - pan`. Round-trips with
 *  `applyWorldToScreen` to within fp precision. */
export function applyScreenToWorld(
  screen: { x: number; y: number },
  t: CanvasTransform,
): { x: number; y: number } {
  if (t.scale === 0 || !Number.isFinite(t.scale)) {
    return { x: NaN, y: NaN };
  }
  const ox = t.originX ?? 0;
  const oy = t.originY ?? 0;
  return {
    x: (screen.x - ox) / t.scale - t.panX,
    y: (screen.y - oy) / t.scale - t.panY,
  };
}

/** Page-side discovery probe — REAL function literal. Returns the best
 *  candidate transform found by walking known app-side global shapes,
 *  plus an adapter hint naming which shape matched. Order matters:
 *  Figma/Excalidraw shape is the most common; Tldraw's distinct shape
 *  is tried next; finally the generic 3x3 matrix path. */
export const PAGE_DISCOVER_TRANSFORM_FN = (): {
  ok: boolean;
  transform?: CanvasTransform;
  adapterHint?: CanvasAdapterHint;
} => {
  // Helper — pull a finite number out of `obj[path]` (dot-path); returns
  // undefined if any segment misses or the leaf is non-finite.
  function get(obj: unknown, path: string): number | undefined {
    const parts = path.split(".");
    let cur: unknown = obj;
    for (const p of parts) {
      if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return undefined;
      }
    }
    return typeof cur === "number" && Number.isFinite(cur) ? cur : undefined;
  }

  const w = window as unknown as Record<string, unknown>;

  // 1) Figma / Excalidraw shape — `app.viewport.zoom` + `app.viewport.center.{x,y}`.
  const zoom = get(w.app, "viewport.zoom");
  const cx = get(w.app, "viewport.center.x");
  const cy = get(w.app, "viewport.center.y");
  if (zoom !== undefined && cx !== undefined && cy !== undefined) {
    return {
      ok: true,
      transform: { scale: zoom, panX: -cx, panY: -cy, originX: 0, originY: 0 },
      adapterHint: "figma",
    };
  }

  // 2) Tldraw-like shape — `app.scale` + `app.offset.{x,y}`.
  const tlScale = get(w.app, "scale");
  const tlOffsetX = get(w.app, "offset.x");
  const tlOffsetY = get(w.app, "offset.y");
  if (tlScale !== undefined && tlOffsetX !== undefined && tlOffsetY !== undefined) {
    return {
      ok: true,
      transform: { scale: tlScale, panX: tlOffsetX, panY: tlOffsetY, originX: 0, originY: 0 },
      adapterHint: "tldraw",
    };
  }

  // 3) Generic matrix shape — `app.transform.matrix` as a 6-element
  //    affine (a,b,c,d,e,f → [[a,c,e],[b,d,f],[0,0,1]]) or as a uniform
  //    scale matrix.
  const m = (w.app as Record<string, unknown> | undefined)?.transform as
    | Record<string, unknown>
    | undefined;
  const mat = m?.matrix;
  if (
    Array.isArray(mat) &&
    mat.length >= 6 &&
    mat.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    const a = mat[0] as number;
    const e = mat[4] as number;
    const f = mat[5] as number;
    return {
      ok: true,
      transform: { scale: a, panX: 0, panY: 0, originX: e, originY: f },
      adapterHint: "generic",
    };
  }

  return { ok: false };
};

/** Thin adapter interface — server.ts owns the page-side evaluate call. */
export interface CanvasDiscoverPage {
  evaluate<T, Arg>(fn: (arg: Arg) => T | Promise<T>, args?: Arg): Promise<T>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
}

export async function canvasWorldToScreen(
  page: CanvasDiscoverPage,
  args: CanvasWorldToScreenArgs,
): Promise<CanvasWorldToScreenResult> {
  if (args.transform) {
    const p = applyWorldToScreen({ x: args.worldX, y: args.worldY }, args.transform);
    return { ok: true, screenX: p.x, screenY: p.y };
  }
  const discovered = await page.evaluate(PAGE_DISCOVER_TRANSFORM_FN);
  if (!discovered.ok || !discovered.transform) {
    return {
      ok: false,
      error:
        "no transform discoverable — pass `transform` explicitly OR use a canvas-app adapter plugin",
      code: "no-transform",
    };
  }
  const p = applyWorldToScreen({ x: args.worldX, y: args.worldY }, discovered.transform);
  return {
    ok: true,
    screenX: p.x,
    screenY: p.y,
    transformDiscovered: discovered.transform,
    ...(discovered.adapterHint ? { adapterHint: discovered.adapterHint } : {}),
    warnings: [
      "discovery probes are HEURISTIC — they match common app-side global shapes (Figma/Excalidraw `app.viewport.{zoom,center}`, Tldraw `app.{scale,offset}`, generic `app.transform.matrix`). Confirm the transform on a known landmark before relying on the result; for production, pass `transform` explicitly or install a canvas-app adapter plugin.",
    ],
  };
}

export async function canvasScreenToWorld(
  page: CanvasDiscoverPage,
  args: CanvasScreenToWorldArgs,
): Promise<CanvasScreenToWorldResult> {
  if (args.transform) {
    const p = applyScreenToWorld({ x: args.screenX, y: args.screenY }, args.transform);
    return { ok: true, worldX: p.x, worldY: p.y };
  }
  const discovered = await page.evaluate(PAGE_DISCOVER_TRANSFORM_FN);
  if (!discovered.ok || !discovered.transform) {
    return {
      ok: false,
      error:
        "no transform discoverable — pass `transform` explicitly OR use a canvas-app adapter plugin",
      code: "no-transform",
    };
  }
  const p = applyScreenToWorld({ x: args.screenX, y: args.screenY }, discovered.transform);
  return {
    ok: true,
    worldX: p.x,
    worldY: p.y,
    transformDiscovered: discovered.transform,
    ...(discovered.adapterHint ? { adapterHint: discovered.adapterHint } : {}),
    warnings: [
      "discovery probes are HEURISTIC — they match common app-side global shapes (Figma/Excalidraw `app.viewport.{zoom,center}`, Tldraw `app.{scale,offset}`, generic `app.transform.matrix`). Confirm the transform on a known landmark before relying on the result; for production, pass `transform` explicitly or install a canvas-app adapter plugin.",
    ],
  };
}

// ---------- canvas_query ----------

export interface CanvasQueryArgs {
  adapter: string;
  op: string;
  args?: Record<string, unknown>;
}

export interface CanvasQueryNoAdapterError {
  ok: false;
  error: string;
  code: "no-adapter";
  requestedAdapter: string;
  requestedOp: string;
}

/** Build the structured `no-adapter` error returned when `canvas_query`
 *  cannot find a plugin registered under the requested namespace. The
 *  shape is kept stable so adopters can match on `code:"no-adapter"`. */
export function noAdapterError(adapter: string, op: string): CanvasQueryNoAdapterError {
  return {
    ok: false,
    error: `no canvas adapter registered for ${adapter}; install @browxai/plugin-${adapter} or pass a registered adapter namespace`,
    code: "no-adapter",
    requestedAdapter: adapter,
    requestedOp: op,
  };
}
