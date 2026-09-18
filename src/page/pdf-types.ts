// The `pdf_save` argument and result vocabulary, above the adapter that drives
// it.
//
// Split out of `pdf.ts` for the reason `actions-types.ts` was split out of
// `actions.ts` in RFC 0009 P1: `pdf.ts` imports `Page` and calls `page.pdf()`, so
// it is the Playwright adapter body, and `CaptureSubstrate.pdf` names these
// shapes. They are plain data — a string union, four optional scalars, a result
// record — so they live where the port can reach them without reaching
// playwright-core. `pdf.ts` re-exports every name, so existing importers are
// unchanged. (RFC 0009 P3.)

/** Paper format presets Playwright's `page.pdf()` accepts. The full Playwright
 *  set; surface every one rather than re-curating — adopters that need
 *  jurisdiction-specific paper get it without a roundtrip back to us. */
export type PdfFormat =
  "Letter" | "Legal" | "Tabloid" | "Ledger" | "A0" | "A1" | "A2" | "A3" | "A4" | "A5" | "A6";

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

export interface PdfRefusal {
  error: string;
  hint: string;
}
