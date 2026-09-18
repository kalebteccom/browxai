// `IosCaptureSubstrate` — screenshots for the ios-app engine, through
// `xcrun simctl io <udid> screenshot`. That is the one read on this engine that
// needs no WebDriverAgent: a session whose XCUITest driver is down can still be
// photographed, which is exactly when a human wants the picture.
//
// WHAT IT REFUSES AND WHY. Element-scoped and region captures crop a frame, and
// cropping a PNG means decoding it. browxai bundles no media binaries, by
// standing policy, so a crop would mean either a new dependency or a wrong
// answer. RFC 0008 §2 anticipates cropping from hierarchy bounds; it needs a
// decoder this branch does not add, so the refusal is honest and named rather
// than a full-screen frame returned as though it were the element.
//
// Dependency direction (architecture doctrine §1): tool handler → CaptureSubstrate
// (the port in `capture-substrate-types.ts`) → this implementation → simctl. This
// file never imports back from the `capture-substrate.js` barrel.

import type { NativeSessionHandle } from "../engine/native-types.js";
import type { ScreenshotSaveResult } from "./screenshot-save.js";
import type {
  CaptureResult,
  CaptureSubstrate,
  PdfResult,
  ScreenshotRequest,
  VideoSave,
} from "./capture-substrate-types.js";

/** The workspace-rooted write the handler already gated on `file-io`. Taken as a
 *  dependency rather than reached for, so this file performs no path resolution
 *  of its own — `resolveWorkspacePath` stays the one chokepoint. */
export type SaveScreenshot = (
  buf: Buffer,
  args: { path: string; format: "png" | "jpeg"; fullPage: boolean },
) => ScreenshotSaveResult;

export class IosCaptureSubstrate implements CaptureSubstrate {
  readonly engine = "ios-app";

  constructor(
    private readonly handle: NativeSessionHandle,
    private readonly save: SaveScreenshot,
  ) {}

  async screenshot(req: ScreenshotRequest): Promise<CaptureResult> {
    if (req.resolveTarget) {
      return {
        kind: "refusal",
        error:
          "element-scoped capture is not available on the ios-app engine — cropping the frame to " +
          "an element's bounds needs a PNG decoder, and browxai bundles no media binaries.",
        hint:
          "Take the full-screen capture and read the element's bounds separately: `inspect` and " +
          "the verify_* family resolve the same ref through the element substrate.",
      };
    }
    if (req.format === "jpeg") {
      return {
        kind: "refusal",
        error:
          "`format: \"jpeg\"` is not available on the ios-app engine — `simctl io screenshot` " +
          "encodes PNG and re-encoding would need a media binary browxai does not bundle.",
        hint: 'Request `format: "png"`, which is the default.',
      };
    }
    const png = await this.handle.driver.screenshot();
    if (req.path !== undefined) {
      try {
        return { kind: "saved", result: this.save(png, { path: req.path, format: "png", fullPage: true }) };
      } catch (err) {
        return { kind: "save-error", error: err instanceof Error ? err.message : String(err) };
      }
    }
    // No `pageText`: there is no page to read text off, and offering an empty
    // string would tell the handler's secrets sweep it had swept something.
    return { kind: "image", data: png.toString("base64"), mimeType: "image/png" };
  }

  async pdf(): Promise<PdfResult> {
    return {
      kind: "refusal",
      error: "pdf_save is not supported on the ios-app engine — a native app has no print surface.",
      hint: "Open a chromium session to print a page to PDF.",
    };
  }

  /** Segmented simulator video (`simctl io recordVideo`, RFC 0008 §5) is that
   *  RFC's P3, not this engine's first landing. Null is "nothing to flush", which
   *  is what the teardown path already did for a session with no recorder —
   *  never a claim that a recording was made. */
  async prepareVideoSave(): Promise<VideoSave | null> {
    return null;
  }
}
