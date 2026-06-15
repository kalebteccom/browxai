// The CaptureSubstrate interface — the engine-agnostic seam beneath the capture
// tools (screenshot today; pdf / video later). It is the capture side of the
// engine-decoupling seam: the `screenshot` handler asks a substrate to capture and gets back a
// universal `CaptureResult`; an engine-specific implementation does the work. The
// handler never names Playwright, safaridriver, or an engine — it calls
// `captureFor(e).screenshot(args)`, the same shape as `actionsFor(e).click(args)`
// / `snapshotSubstrateFor(e.session).compose(...)`.
//
// Dependency direction (architecture doctrine §1): tool handler → CaptureSubstrate
// (this interface) → implementation → Playwright | safaridriver. Two impls today:
//   - PlaywrightCaptureSubstrate (chromium / firefox / webkit / android): wraps the
//     existing screenshot logic verbatim (viewport / fullPage / element-scoped via
//     locator, jpeg + quality + scale, the `path` disk-write envelope, the
//     `describe` caption) — byte-identical to the pre-seam handler, so the four
//     engines' keystones stay green unchanged.
//   - SafariCaptureSubstrate (safari): wraps `webDriver.screenshot` (full-document
//     PNG; safaridriver has no Playwright Page). The element-scoped / `path` / jpeg
//     variants refuse cleanly IN THE ADAPTER as they did in the handler's deleted
//     `if (safariShotHandle)` branch — so the gating lives here, not as an engine
//     check in the handler.

import type { Locator, Page } from "playwright-core";
import type { RefRegistry } from "./refs.js";
import type { SafariSessionHandle } from "../engine/index.js";
import type { ScreenshotSaveResult } from "./screenshot-save.js";

/** Normalised screenshot request — the handler's already-validated args, engine-
 *  blind. `resolveTarget`, when present, marks an element-scoped capture and is the
 *  DEFERRED `asTarget` resolution: an adapter calls it only after its own refusals
 *  pass, so a malformed target (multi-target / unbound `named`) surfaces as the
 *  engine/`fullPage` refusal it sat behind pre-seam, not as a preempting throw. Its
 *  absence means a viewport (or `fullPage`) capture. `path`, when set, swaps the
 *  inline image for a workspace-rooted disk write (the handler has already enforced
 *  the `file-io` capability). */
export interface ScreenshotRequest {
  format: "png" | "jpeg";
  quality?: number;
  scale?: "css" | "device";
  fullPage: boolean;
  describe: boolean;
  resolveTarget?: () => { ref: string } | { selector: string; contextRef?: string };
  path?: string;
}

/** Inline-image outcome: the encoded bytes + mime, an optional `describe`
 *  caption, and an optional page-text source the handler's secrets sweep reads
 *  (only the Playwright path can offer it — Safari has no Page to evaluate, the
 *  same as before the seam, where the Safari branch returned before the sweep). */
export interface CaptureImage {
  kind: "image";
  data: string;
  mimeType: string;
  caption?: string;
  pageText?: () => Promise<string>;
}

/** Disk-write outcome (`path` mode): the `screenshot-save` envelope plus the
 *  optional caption the handler folds into the JSON body. */
export interface CaptureSaved {
  kind: "saved";
  result: ScreenshotSaveResult;
  caption?: string;
}

/** Disk-write FAILURE (`path` mode): the workspace path escaped the root, or the
 *  write itself failed. Carries the bare message the handler renders as the same
 *  `{ ok:false, error, tokensEstimate }` envelope the deleted try/catch produced —
 *  a throw here was a returned JSON envelope, never a crashed handler. */
export interface CaptureSaveError {
  kind: "save-error";
  error: string;
}

/** Structured refusal — an engine that cannot honour the request (Safari for
 *  element-scoped / `path` / jpeg), or a request the capability itself rejects
 *  (`fullPage` + a target). The handler renders `error`/`hint` as the same JSON
 *  envelope the deleted branches produced. */
export interface CaptureRefusal {
  kind: "refusal";
  error: string;
  hint?: string;
}

export type CaptureResult = CaptureImage | CaptureSaved | CaptureSaveError | CaptureRefusal;

/** The capture capability port. One instance wraps one session's engine handle;
 *  the methods carry no engine type, so the handler above this seam is
 *  engine-blind. Mirrors the ActionSubstrate / SnapshotSubstrate shape. */
export interface CaptureSubstrate {
  readonly engine: string;
  screenshot(req: ScreenshotRequest): Promise<CaptureResult>;
}

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
    private readonly deps: {
      describeTarget: (
        loc: Locator,
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
      const caption = req.describe ? await this.deps.describeTarget(loc, this.refs, target) : "";
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
}

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
