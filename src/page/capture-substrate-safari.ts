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
  PdfResult,
  ScreenshotRequest,
  VideoSave,
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

  /** safaridriver's WebDriver Classic lane has no print command, and Safari's
   *  experimental BiDi build ships no `browsingContext.print`.
   *
   *  REACHED ONLY IF `pdf_save` LOSES `deep: true`. Safari declares
   *  `deep: false`, so `assertEngineSupports` refuses the tool before any
   *  substrate is consulted, and this body does not run today. That is the same
   *  standing arrangement as `SafariEmulationSubstrate`'s three refusals, which
   *  sit behind `subInterfaceGate("emulation")`: the gate refuses upstream where
   *  it can say "the check was NOT performed", and the adapter refuses beneath it
   *  so the port is never present-but-throwing (the L5 violation). RFC 0009's
   *  cluster table plans to retire `pdf_save`'s flag and make this the only
   *  refusal; that is a live behaviour change on Firefox and WebKit and it is not
   *  part of P3. */
  async pdf(): Promise<PdfResult> {
    return {
      kind: "refusal",
      error:
        "pdf_save is not supported on the safari engine — safaridriver exposes no print command, and Safari's experimental BiDi build ships no `browsingContext.print`.",
      hint: "Open a chromium session to print the page to PDF.",
    };
  }

  /** Safari records no video: `recordVideo` is a Playwright context-creation
   *  primitive and this engine has no Playwright context. Null means "nothing to
   *  flush", which is what the teardown path already did for a session with no
   *  recorder. */
  async prepareVideoSave(): Promise<VideoSave | null> {
    return null;
  }
}
