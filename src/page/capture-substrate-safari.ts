// SafariCaptureSubstrate — the CaptureSubstrate implementation over WebDriver
// Classic (safaridriver, no Playwright Page). safaridriver captures the whole
// document as PNG; the element-scoped / `path` variants need a Playwright Page
// Safari lacks, so they refuse cleanly here — the gating is in the adapter, not
// the handler.
//
// Dependency direction (architecture doctrine §1): tool handler → CaptureSubstrate
// (the port in `capture-substrate-types.ts`) → this implementation → safaridriver.
// This file never imports back from the `capture-substrate.js` barrel.

import type { SafariSessionHandle } from "../engine/index.js";
import type {
  CaptureResult,
  CaptureSubstrate,
  ScreenshotRequest,
} from "./capture-substrate-types.js";

/** Safari — the WebDriver-Classic capture path. safaridriver captures the whole
 *  document as PNG; the element-scoped / `path` variants need a Playwright Page
 *  Safari lacks, so they refuse cleanly here (the gating is in the adapter, not
 *  the handler). The `format`/`scale`/`fullPage`/`describe` args are inert as they
 *  were before the seam — the WebDriver client always returns a full-document PNG. */
export class SafariCaptureSubstrate implements CaptureSubstrate {
  readonly engine = "safari";
  constructor(private readonly handle: SafariSessionHandle) {}

  async screenshot(req: ScreenshotRequest): Promise<CaptureResult> {
    // Refuse on the raw element-scoped / `path` signals WITHOUT invoking the
    // deferred `asTarget` resolver — a malformed target must surface as this
    // engine refusal, exactly as the pre-seam Safari branch (which never reached
    // `asTarget`) returned it.
    if (req.resolveTarget || req.path !== undefined) {
      return {
        kind: "refusal",
        error:
          "the Safari engine supports only the default inline PNG screenshot — element-scoped (`ref`/`selector`/`named`) and `path` captures need a chromium/firefox/webkit session.",
      };
    }
    const data = await this.handle.webDriver.screenshot(this.handle.sessionId);
    return { kind: "image", data, mimeType: "image/png" };
  }
}
