// PlaywrightCaptureSubstrate — the CaptureSubstrate implementation for the
// Playwright engines (chromium / firefox / webkit / android). It wraps the
// existing screenshot logic verbatim (viewport / fullPage / element-scoped via
// locator, jpeg + quality + scale, the `path` disk-write envelope, the `describe`
// caption) — byte-identical to the pre-split path, so the four engines' keystones
// stay green unchanged.
//
// Dependency direction (architecture doctrine §1): tool handler → CaptureSubstrate
// (the port in `capture-substrate-types.ts`) → this implementation → Playwright
// Page/Locator. This file never imports back from the `capture-substrate.js`
// barrel that re-exports it.

import type { Locator, Page } from "playwright-core";
import type { RefRegistry } from "./refs.js";
import type { ElementSubstrate } from "./element-substrate-types.js";
import type { ScreenshotSaveResult } from "./screenshot-save.js";
import type {
  CaptureResult,
  CaptureSubstrate,
  PdfRequest,
  PdfResult,
  ScreenshotRequest,
  VideoSave,
} from "./capture-substrate-types.js";
import type { VideoRecorderState } from "./video-types.js";
import { pdfSave } from "./pdf.js";
import { finalizeVideoOnClose } from "./video.js";

/** Build the Locator for an element-scoped capture. Lazily imported so the
 *  page-layer locator core is pulled only when a target is actually present —
 *  the handler did the same `await import("./locator.js")` inline. */
async function locatorForTarget(
  page: Page,
  refs: RefRegistry,
  target: { ref: string } | { selector: string; contextRef?: string },
): Promise<Locator> {
  const { locatorFor } = await import("./locator.js");
  return locatorFor(page, refs, target);
}

/** Playwright engines — the existing screenshot logic, verbatim. The `page` and
 *  `describe`/`save` collaborators are injected so this adapter stays free of the
 *  server's handler closures (the caption + disk-write helpers live in server.ts
 *  and are passed through unchanged). No behaviour change. */
export class PlaywrightCaptureSubstrate implements CaptureSubstrate {
  readonly engine: string;
  constructor(
    private readonly page: () => Page,
    private readonly refs: RefRegistry,
    private readonly elements: ElementSubstrate,
    private readonly deps: {
      describeTarget: (
        elements: ElementSubstrate,
        refs: RefRegistry,
        target: { ref: string } | { selector: string } | { coords: { x: number; y: number } },
      ) => Promise<string>;
      save: (
        buf: Buffer,
        args: { path: string; format: "png" | "jpeg"; fullPage: boolean },
      ) => ScreenshotSaveResult;
    },
    engine = "chromium",
  ) {
    this.engine = engine;
  }

  /** Capture the screenshot bytes + caption for either the element-scoped target
   *  (deferred `asTarget` resolution) or the whole page. */
  private async captureBytes(
    page: Page,
    req: ScreenshotRequest,
    fmt: "png" | "jpeg",
  ): Promise<{ buf: Buffer; caption: string }> {
    if (req.resolveTarget) {
      // Deferred: only now does the `asTarget` chokepoint run. A malformed target
      // throws here — past the `fullPage` refusal, matching the pre-seam handler.
      const target = req.resolveTarget();
      const loc = await locatorForTarget(page, this.refs, target);
      // Locator.screenshot doesn't accept `scale`; pass type/quality only there.
      const locOpts: { type: "png" | "jpeg"; quality?: number } = { type: fmt };
      if (fmt === "jpeg") locOpts.quality = req.quality ?? 80;
      const buf = await loc.screenshot(locOpts);
      // The caption is measured through the element port, not off the `Locator`
      // this adapter just used for the bytes. The two resolve the same recipe —
      // `locatorForTarget` and the port both go through `locatorFor` — so the
      // caption describes the element that was captured.
      const caption = req.describe
        ? await this.deps.describeTarget(this.elements, this.refs, target)
        : "";
      return { buf, caption };
    }
    const opts: { type: "png" | "jpeg"; quality?: number; scale?: "css" | "device" } = {
      type: fmt,
    };
    if (fmt === "jpeg") opts.quality = req.quality ?? 80;
    if (req.scale) opts.scale = req.scale;
    const buf = await page.screenshot({ fullPage: req.fullPage, ...opts });
    const caption = req.describe ? `${req.fullPage ? "fullPage" : "viewport"} (${page.url()})` : "";
    return { buf, caption };
  }

  async screenshot(req: ScreenshotRequest): Promise<CaptureResult> {
    const page = this.page();
    const fmt = req.format;
    const mimeType = fmt === "jpeg" ? "image/jpeg" : "image/png";
    const fullPage = req.fullPage;
    if (fullPage && req.resolveTarget) {
      return {
        kind: "refusal",
        error:
          "screenshot: `fullPage:true` is mutually exclusive with `ref`/`selector`/`named` — element-scoped captures are already bounded by the element's box",
        hint: "Drop `fullPage` for an element capture, or drop the target for a whole-document capture.",
      };
    }
    const { buf, caption } = await this.captureBytes(page, req, fmt);
    // `path` mode: write bytes to a workspace-rooted file and return the save
    // envelope instead of inline base64. The `file-io` capability check already
    // ran (handler gate); a path escaping the workspace or a failed write throws
    // out of `screenshotSave` and becomes a structured `save-error` here — never
    // a crashed handler, matching the deleted try/catch.
    if (req.path !== undefined) {
      try {
        const result = this.deps.save(buf, { path: req.path, format: fmt, fullPage });
        return { kind: "saved", result, caption: caption || undefined };
      } catch (err) {
        return { kind: "save-error", error: err instanceof Error ? err.message : String(err) };
      }
    }
    return {
      kind: "image",
      data: buf.toString("base64"),
      mimeType,
      caption: caption || undefined,
      // The secrets sweep reads the document's visible text (innerText falls
      // back to "" on failure — the page may be navigating). Bounded so a giant
      // page doesn't make the scan O(n^2-pathological).
      pageText: () =>
        page
          .evaluate(() => {
            const w = globalThis as unknown as { document?: { body?: { innerText?: string } } };
            return (w.document?.body?.innerText ?? "").slice(0, 200_000);
          })
          .catch(() => ""),
    };
  }

  /** `page.pdf()` through the existing `pdfSave` — path resolution, the scale
   *  bounds check and the workspace-escape rejection all unchanged, including
   *  which of them throw. The handler's `catch` renders a throw here exactly as
   *  it did when it called `pdfSave` itself. */
  async pdf(req: PdfRequest): Promise<PdfResult> {
    const page = this.page();
    const result = await pdfSave(page, req.workspaceRoot, req.sessionId, {
      path: req.path,
      format: req.format,
      scale: req.scale,
      printBackground: req.printBackground,
    });
    return { kind: "saved", result };
  }

  /** Split at the seam the teardown path already had: the `Page` is resolved
   *  NOW, while the session is live, and `page.video()` plus `saveAs` run in the
   *  returned thunk, after `context.close()` has flushed the .webm. Both halves
   *  are the verbatim bodies of the two lines this replaced. */
  async prepareVideoSave(state: VideoRecorderState): Promise<VideoSave | null> {
    // The accessor runs FIRST, before the state is inspected — the same order the
    // element adapter uses, so a dead BYOB target rejects instead of being
    // reported as "nothing to save".
    const page = this.page();
    if (!state.active || !state.targetPath) return null;
    return () => finalizeVideoOnClose(page, state);
  }
}
