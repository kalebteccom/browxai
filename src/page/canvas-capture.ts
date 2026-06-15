/// <reference lib="dom" />
// canvas_capture — framebuffer / 2D ImageData / PNG bytes of a `<canvas>`.
// App-agnostic pixel source for the BYO-vision loop (see canvas.ts header).
//
// Bounded: refuses canvases larger than 16384×16384 (CANVAS_MAX_DIMENSION) —
// a multi-megapixel buffer round-tripped through base64 is genuinely a problem.

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

/** Page-side raw-capture return — the loose discriminated union the page
 *  function produces (every field optional so it serializes cleanly across
 *  the CDP boundary). The host side narrows it back into CanvasCaptureResult. */
export interface PageCaptureRaw {
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
}

// The page-side capture is decomposed into per-format helpers so the
// top-level `PAGE_CAPTURE_FN` stays a small dispatcher. EVERY helper is a
// nested declaration of PAGE_CAPTURE_FN — the whole thing must serialize as
// one self-contained function literal across `page.evaluate`, so the helpers
// cannot live at module scope (they would be lost on serialization). The split
// is therefore internal to the one function literal.

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
}): PageCaptureRaw => {
  // --- locate ---
  function locateCanvas(): HTMLCanvasElement | null {
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
    return canvas;
  }

  // --- shared encode helper ---
  // base64-encode a Uint8Array using only DOM-available builtins. btoa wants
  // binary string input; build it in chunks so we don't blow the call stack
  // on huge buffers.
  function bytesToB64(bytes: Uint8Array): string {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
      binary += String.fromCharCode.apply(null, Array.prototype.slice.call(slice));
    }
    return btoa(binary);
  }

  // --- per-format captures ---
  function capturePng(canvas: HTMLCanvasElement, w: number, h: number): PageCaptureRaw {
    try {
      const dataUrl = canvas.toDataURL("image/png");
      const idx = dataUrl.indexOf("base64,");
      if (idx < 0) {
        return { ok: false, error: "toDataURL did not return a base64 payload", code: "encode-failed" };
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

  function captureImageData(canvas: HTMLCanvasElement, w: number, h: number): PageCaptureRaw {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return {
        ok: false,
        error: 'canvas has no 2d context (likely a WebGL/WebGPU canvas — try format:"webgl-framebuffer")',
        code: "no-2d-context",
      };
    }
    try {
      const data = ctx.getImageData(0, 0, w, h);
      const bytes = new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength);
      return { ok: true, format: "2d-imagedata", contentBase64: bytesToB64(bytes), width: w, height: h, channelCount: 4 };
    } catch (e) {
      return {
        ok: false,
        error: "getImageData failed: " + ((e as Error)?.message || String(e)),
        code: "taint-or-read",
      };
    }
  }

  function captureWebgl(canvas: HTMLCanvasElement, w: number, h: number): PageCaptureRaw {
    // Try webgl2 first then webgl. Some apps configure
    // preserveDrawingBuffer:false — readPixels then returns blank because the
    // compositor cleared the buffer; the caller sees zero-bytes on diff in
    // that case and we can't undo it without recreating the context.
    let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
    } catch (_) {
      gl = null;
    }
    if (!gl) {
      try {
        gl = canvas.getContext("webgl", { preserveDrawingBuffer: true });
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
      // WebGL's coordinate origin is bottom-left; flip into top-left order so
      // downstream `canvas_diff` math is consistent with the imagedata format
      // (and with PNG / typical screenshot conventions).
      const flipped = new Uint8Array(w * h * 4);
      const stride = w * 4;
      for (let y = 0; y < h; y++) {
        const src = (h - 1 - y) * stride;
        const dst = y * stride;
        flipped.set(pixels.subarray(src, src + stride), dst);
      }
      return {
        ok: true,
        format: "webgl-framebuffer",
        contentBase64: bytesToB64(flipped),
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
  }

  // --- dispatch ---
  const canvas = locateCanvas();
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
    return { ok: false, error: `canvas dimensions are non-positive (${w}x${h})`, code: "bad-dimensions" };
  }
  if (w > args.maxDimension || h > args.maxDimension) {
    return {
      ok: false,
      error: `canvas dimensions ${w}x${h} exceed the maximum ${args.maxDimension}x${args.maxDimension} cap`,
      code: "too-large",
    };
  }

  if (args.format === "png") return capturePng(canvas, w, h);
  if (args.format === "2d-imagedata") return captureImageData(canvas, w, h);
  return captureWebgl(canvas, w, h);
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
