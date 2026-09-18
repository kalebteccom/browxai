// CaptureSubstrate port + result types — the engine-agnostic vocabulary the
// capture tools speak (screenshot today; pdf / video later). A tool handler asks a
// substrate to capture and gets back a universal `CaptureResult`; an
// engine-specific implementation does the work. The handler never names
// Playwright, safaridriver, or an engine — it calls `captureFor(e).screenshot(req)`,
// the same shape as `actionsFor(e).click(args)`.
//
// Dependency direction (architecture doctrine §1): tool handler → CaptureSubstrate
// (this port) → implementation → Playwright | safaridriver. Split out of
// `capture-substrate.ts` so the port module names no vendor type; the two
// implementations live in `capture-substrate-playwright.ts` and
// `capture-substrate-safari.ts`. Re-exported through `./capture-substrate.js` so
// callers import unchanged. (RFC 0009 P1.)

import type { ScreenshotSaveResult } from "./screenshot-save.js";
import type { PdfSaveArgs, PdfSaveResult } from "./pdf-types.js";
import type { VideoRecorderState } from "./video-types.js";

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

/** Normalised `pdf_save` request. `PdfSaveArgs` verbatim, plus the two strings
 *  the default output path is built from. They travel in the request because the
 *  handler already holds both and they are plain data: the sandbox write-root a
 *  path is resolved inside, and the session id the auto-name carries. The BYOB
 *  refusal is NOT here — it is a session-MODE question (`assertPdfSupported`),
 *  which the handler answers before it reaches the port. */
export interface PdfRequest extends PdfSaveArgs {
  workspaceRoot: string;
  sessionId: string;
}

/** The PDF landed on disk. `result` is the `pdf_save` envelope, rendered
 *  verbatim. */
export interface PdfSaved {
  kind: "saved";
  result: PdfSaveResult;
}

/** This engine has no print surface. Same `{error, hint}` shape the capture
 *  refusals already use. */
export interface PdfRefused {
  kind: "refusal";
  error: string;
  hint?: string;
}

export type PdfResult = PdfSaved | PdfRefused;

/** The second half of a video save, run AFTER the session has torn down.
 *
 *  Video finalisation is two-phase because the recorders are: Playwright's
 *  `recordVideo` is a context-creation primitive whose bytes exist only once
 *  `context.close()` has run, so the handle has to be taken while the session is
 *  live and the flush has to happen after it is not. RFC 0008 §5's segmented
 *  native writer has the same two phases. Expressing it as "take the handle, get
 *  back the flush" is what lets the teardown path stay engine-blind across both.
 *
 *  Best-effort by contract: teardown never blocks on a recording. */
export type VideoSave = () => Promise<void>;

/** The capture capability port. One instance wraps one session's engine handle;
 *  the methods carry no engine type, so the handler above this seam is
 *  engine-blind. Mirrors the ActionSubstrate / SnapshotSubstrate shape. */
export interface CaptureSubstrate {
  readonly engine: string;
  screenshot(req: ScreenshotRequest): Promise<CaptureResult>;
  /** Print the current target to a workspace-rooted PDF. `pdf_save` reached
   *  `requirePage(e.session)` for this while the capture port sat unused beside
   *  it (RFC 0009's `pdf` cluster, 16 uses). */
  pdf(req: PdfRequest): Promise<PdfResult>;
  /** Take whatever handle the video flush will need, before the session tears
   *  down, and return the flush — or `null` when this engine records no video.
   *  See `VideoSave` for why it is two-phase. */
  prepareVideoSave(state: VideoRecorderState): Promise<VideoSave | null>;
}
