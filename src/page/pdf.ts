// `pdf_save` — print the current page to a workspace-rooted PDF.
//
// The mirror of `upload_file`: `upload_file` reads workspace-rooted bytes INTO
// the page, `pdf_save` writes the page's print output OUT to workspace-rooted
// bytes. Wraps Playwright's `page.pdf()` (CDP `Page.printToPDF` under the hood)
// — the first-class alternative to "screenshot the page and OCR it back" or to
// driving the browser's print-to-file dialog with `shortcut`.
//
// Workspace-rooted by construction: every path runs through
// `resolveWorkspacePath` (same helper `start_har` / `dump_storage_state` /
// `export_playwright_script` use). A path escaping `$BROWX_WORKSPACE` is
// rejected — no on-disk trace ever lands outside the workspace.
//
// Defaults match what an agent reaching for "save the page as a PDF" expects
// without reading the docs: A4 paper, scale 1, `printBackground:false` (matches
// browser-print's default — caller opts in when background colour/imagery
// matters for the artefact).
//
// **Chromium constraint:** `page.pdf()` is Chromium-only and refuses on
// browser-side `attached` (BYOB) sessions — printing on a human's own Chrome
// would surface a print dialog / mutate the human's window state. The tool
// layer refuses cleanly with a structured error before we ever call into
// Playwright (see `assertPdfSupported`).

import { resolve as resolvePath } from "node:path";
import { statSync } from "node:fs";
import type { Page } from "playwright-core";
import { resolveWorkspacePath } from "../session/storage.js";

/** Paper format presets Playwright's `page.pdf()` accepts. The full Playwright
 *  set; surface every one rather than re-curating — adopters that need
 *  jurisdiction-specific paper get it without a roundtrip back to us. */
export type PdfFormat =
  | "Letter"
  | "Legal"
  | "Tabloid"
  | "Ledger"
  | "A0"
  | "A1"
  | "A2"
  | "A3"
  | "A4"
  | "A5"
  | "A6";

export interface PdfSaveArgs {
  /** Workspace-rooted file path. Default `pdfs/<sessionId>-<ts>.pdf`. Caller
   *  supplies a path → it's resolved inside `$BROWX_WORKSPACE` (escape
   *  rejected); caller omits it → see `defaultPdfPath`. */
  path?: string;
  /** Paper format. Default "A4". */
  format?: PdfFormat;
  /** Render scale. Default 1. Playwright clamps to `[0.1, 2.0]`; values
   *  outside that range are rejected up-front for a clearer error. */
  scale?: number;
  /** Include CSS `background-color` / `background-image` in the rendered
   *  output. Default `false` (matches browser-print's default; caller opts
   *  in when the artefact needs styled backgrounds). */
  printBackground?: boolean;
}

export interface PdfSaveResult {
  ok: true;
  /** Absolute, workspace-rooted path the bytes were written to. */
  path: string;
  /** Final on-disk size, in bytes. */
  bytes: number;
  /** Paper format actually used. */
  format: PdfFormat;
  /** Scale actually used. */
  scale: number;
  /** Whether CSS backgrounds were printed. */
  printBackground: boolean;
}

/** Refusal context — what the tool layer hands `assertPdfSupported`. */
export interface PdfSupportContext {
  /** Session mode (`registry.ts` vocabulary: `persistent` / `incognito` /
   *  `attached`). `attached` is BYOB. */
  mode: "persistent" | "incognito" | "attached";
}

/** Structured refusal — matches the shape `extensionRefusal` returns so the
 *  tool layer can wrap it uniformly. */
export interface PdfRefusal {
  error: string;
  hint: string;
}

/** Refuse PDF generation on session modes Playwright `page.pdf()` doesn't
 *  support. BYOB (`attached`) is the only refusal today: printing on a
 *  human's own Chrome would surface a print dialog / mutate window state, and
 *  `page.pdf()` itself only works against a Chromium we own. Managed
 *  `persistent` and `incognito` sessions are both supported (headed and
 *  headless — the Playwright headless-only constraint applies to legacy
 *  bundles; the bundle browxai ships against handles headed managed Chromium
 *  fine).
 *
 *  Returns `null` when supported; a `{error, hint}` envelope when refused. */
export function assertPdfSupported(ctx: PdfSupportContext): PdfRefusal | null {
  if (ctx.mode === "attached") {
    return {
      error:
        "pdf_save: not supported on attached / BYOB sessions — page.pdf() " +
        "drives Chromium's PrintToPDF and would surface a print dialog / " +
        "mutate the human's Chrome window state",
      hint:
        'open a managed session (open_session({mode:"persistent"}) or ' +
        '{mode:"incognito"}) and re-run pdf_save against that.',
    };
  }
  return null;
}

/** Default output path when the caller doesn't supply one. Workspace-rooted
 *  under `pdfs/<sessionId>-<ts>.pdf` — matches the `perf_stop` /
 *  `start_har` "subdir per artefact kind" convention. */
export function defaultPdfPath(sessionId: string): string {
  // Sanitise sessionId for filesystem use (the registry already constrains
  // ids to a safe character set; this is belt-and-braces against future
  // changes there). Same posture as `defaultTracePath`.
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `pdfs/${safe}-${ts}.pdf`;
}

/** Write `page.pdf()` to a workspace-rooted path. The caller has already
 *  verified the session mode supports PDF (`assertPdfSupported`); this layer
 *  resolves the path, validates inputs, and dispatches to Playwright.
 *
 *  Throws on:
 *  - `path` escaping `$BROWX_WORKSPACE` (via `resolveWorkspacePath`).
 *  - `scale` outside `[0.1, 2.0]`.
 *  - Underlying `page.pdf()` failure (re-thrown with original message). */
export async function pdfSave(
  page: Page,
  workspaceRoot: string,
  sessionId: string,
  args: PdfSaveArgs = {},
): Promise<PdfSaveResult> {
  const format: PdfFormat = args.format ?? "A4";
  const scale = args.scale ?? 1;
  const printBackground = args.printBackground ?? false;

  if (scale < 0.1 || scale > 2.0) {
    throw new Error(
      `pdf_save: scale must be in [0.1, 2.0] — got ${scale}. ` +
        `Playwright's page.pdf() clamps the value at the underlying CDP layer; ` +
        `we reject up-front for a clearer error.`,
    );
  }

  const relPath = args.path ?? defaultPdfPath(sessionId);
  const resolved = resolveWorkspacePath(workspaceRoot, relPath, "pdf_save");
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  // Ensure parent dir exists — `resolved` is rooted in BROWX_WORKSPACE by
  // construction (resolveWorkspacePath rejects escapes); Playwright's
  // `page.pdf({path})` writes synchronously and fails if the dir is missing.
  mkdirSync(dirname(resolved), { recursive: true });

  await page.pdf({
    path: resolved,
    format,
    scale,
    printBackground,
  });

  let bytes = 0;
  try {
    bytes = statSync(resolved).size;
  } catch {
    /* best-effort */
  }
  // Belt-and-braces: re-run resolve to surface the absolute path in the
  // result (the input may have been relative).
  const absolute = resolvePath(resolved);
  return {
    ok: true,
    path: absolute,
    bytes,
    format,
    scale,
    printBackground,
  };
}
