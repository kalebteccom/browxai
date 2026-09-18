// NativeCaptureSubstrate — screenshots over `adb exec-out screencap -p`.
//
// A full-frame PNG is the only thing the platform hands back, so everything else
// this port offers is derived from it or refused:
//
//   - viewport / `fullPage` — the same frame. A device screen has no scrollback,
//     so "the viewport" and "the whole page" are the same pixels and `fullPage`
//     is honoured rather than refused.
//   - element-scoped — cropped from the full frame using the bounds the element
//     substrate just read, which is what RFC 0008 §2 specifies.
//   - `jpeg` — REFUSED. `screencap` emits PNG and browxai bundles no image
//     encoder; re-encoding would mean a codec dependency for a format nobody
//     needs on a QA screenshot.
//   - `pdf` / video — refused, with video pointing at RFC 0008 P3 where the
//     segmented `screenrecord` writer lands.
//
// Cropping is done by a tiny PNG re-chunker rather than a decode/re-encode, for
// the same reason: `sharp` is Apache-2.0 but it is a native binary, and
// `jimp` pulls a tree. The crop is exact and lossless because a PNG's pixel data
// is not position-dependent once inflated.

import type {
  CaptureResult,
  CaptureSubstrate,
  PdfResult,
  ScreenshotRequest,
  VideoSave,
} from "./capture-substrate-types.js";
import type { ElementSubstrate, Rect } from "./element-substrate-types.js";
import { cropPng } from "./native-png-crop.js";

/** The device reads this substrate needs. */
export interface NativeCaptureIO {
  screenshot(): Promise<Buffer>;
}

/** Where a `path:` capture writes. The same sink the Playwright adapter is given
 *  by the composition root, so the workspace-rooting rule holds identically. */
export interface NativeCaptureDeps {
  save: (
    buf: Buffer,
    args: { path: string; format: "png" | "jpeg"; fullPage: boolean },
  ) => import("./screenshot-save.js").ScreenshotSaveResult;
  describeTarget?: (
    elements: ElementSubstrate,
    target: { ref: string } | { selector: string },
  ) => Promise<string>;
}

function refusal(error: string, hint: string): CaptureResult {
  return { kind: "refusal", error, hint };
}

export class NativeCaptureSubstrate implements CaptureSubstrate {
  readonly engine: string;

  constructor(
    private readonly io: NativeCaptureIO,
    private readonly elements: ElementSubstrate,
    private readonly deps: NativeCaptureDeps,
    engine = "android-app",
  ) {
    this.engine = engine;
  }

  async screenshot(req: ScreenshotRequest): Promise<CaptureResult> {
    if (req.format === "jpeg") {
      return refusal(
        `the "${this.engine}" engine captures PNG only`,
        "`adb exec-out screencap` emits PNG, and browxai bundles no image encoder to transcode " +
          'it. Request `format:"png"`.',
      );
    }
    const full = await this.io.screenshot();
    const cropped = await this.cropIfTargeted(req, full);
    if ("refusal" in cropped) return cropped.refusal;
    return req.path ? this.saveTo(req.path, cropped.buf) : this.inline(cropped.buf);
  }

  /** Element-scoped capture: crop the full frame to the bounds the element
   *  substrate reads NOW. The bounds come from the same re-resolution path an
   *  action uses, so a cropped screenshot and a tap agree on where the element
   *  is. */
  private async cropIfTargeted(
    req: ScreenshotRequest,
    full: Buffer,
  ): Promise<{ buf: Buffer } | { refusal: CaptureResult }> {
    if (!req.resolveTarget) return { buf: full };
    const target = req.resolveTarget();
    const query =
      "ref" in target
        ? ({ kind: "ref", ref: target.ref } as const)
        : ({ kind: "selector", selector: target.selector } as const);
    const resolved = await this.elements.resolve(query);
    if (resolved.kind === "refusal") {
      return { refusal: refusal(resolved.error, resolved.hint ?? "") };
    }
    const bounds = await this.elements.bounds(resolved.el);
    if (bounds.kind === "refusal") {
      return { refusal: refusal(bounds.error, bounds.hint ?? "") };
    }
    if (!bounds.rect || bounds.rect.width <= 0 || bounds.rect.height <= 0) {
      return {
        refusal: refusal(
          "the element has no rendered box, so there is nothing to capture",
          "It may be off-screen or collapsed. `scroll` it into view, then retry.",
        ),
      };
    }
    return this.crop(full, bounds.rect);
  }

  private crop(full: Buffer, rect: Rect): { buf: Buffer } | { refusal: CaptureResult } {
    try {
      return { buf: cropPng(full, rect) };
    } catch (err) {
      return {
        refusal: refusal(
          `the element screenshot could not be cropped: ${err instanceof Error ? err.message : String(err)}`,
          "Capture the full screen instead (omit the target) and crop outside browxai.",
        ),
      };
    }
  }

  private saveTo(path: string, buf: Buffer): CaptureResult {
    try {
      return {
        kind: "saved",
        result: this.deps.save(buf, { path, format: "png", fullPage: true }),
      };
    } catch (err) {
      return { kind: "save-error", error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** No print surface. An Android app renders to a display, and the platform's
   *  own print pipeline needs a `PrintDocumentAdapter` the app itself must
   *  implement. */
  async pdf(): Promise<PdfResult> {
    return {
      kind: "refusal",
      error:
        "pdf_save is not supported on the android-app engine — a native app has no print surface, " +
        "and Android's print pipeline needs a PrintDocumentAdapter the app itself must implement.",
      hint: "Use `screenshot` for a visual record of a native screen.",
    };
  }

  /** No video yet. `screenrecord` is real, and RFC 0008 §5 designs the SEGMENTED
   *  writer it needs: Android's recorder stops at 180 seconds, so a QA session
   *  produces several files plus the `capture/segment` events that record the gap
   *  between them. That lands with the native capture path (RFC 0008 P3). `null`
   *  means "nothing to flush", which is exactly what teardown already does for a
   *  session with no recorder — it is no claim that a recording was made. */
  async prepareVideoSave(): Promise<VideoSave | null> {
    return null;
  }

  private inline(buf: Buffer): CaptureResult {
    // No `pageText` — there is no page to evaluate, so the handler's secrets
    // sweep over page text has nothing to read. That is the same position the
    // Safari adapter is in, and it is an ABSENT field rather than an empty
    // string, so the handler can tell "nothing to sweep" from "swept, found
    // nothing".
    return { kind: "image", data: buf.toString("base64"), mimeType: "image/png" };
  }
}
