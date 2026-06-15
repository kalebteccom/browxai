import { requireCdp } from "../engine/index.js";
import { withDeadline } from "../util/deadline.js";
import { estimateTokens } from "../util/tokens.js";
import { assetExport } from "../page/asset-export.js";
import { pdfSave, assertPdfSupported } from "../page/pdf.js";
import { pageArchive } from "../page/archive.js";
import { SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

/**
 * Capture + report — page-level artefact export. `asset_export` (persist the
 * session's network ring to disk), `pdf_save`, and `page_archive` (a
 * self-contained whole-document capture). Workspace-rooted output by
 * construction; registered through the shared `ToolHost` seam.
 */
export function registerCaptureReportExportTools(host: ToolHost): void {
  const { z, register, gateCheck, engineGate, entryFor, cfgActionTimeout, workspace } = host;

  // `asset_export` — filter the session's network ring and persist matching
  // responses to a workspace-rooted dir. Mirrors `download_get`'s file-io
  // posture (read session-buffered state, write bytes under $BROWX_WORKSPACE).
  // CORS caveat: when a response body has aged out of the renderer cache the
  // tool falls back to an in-page `fetch()` against the original URL —
  // cross-origin URLs without permissive CORS headers will land in
  // `droppedCount`, not a crash.
  register(
    "asset_export",
    {
      capability: "file-io",
      description:
        'Filter every resource the session has loaded (the always-on `NetworkBuffer` ring) and persist matching responses to a workspace-rooted directory — the first-class alternative to scraping `<img src>` / `<link href>` then re-fetching each one through `eval_js`. Filter shape: `{mime?: string[], urlPattern?: string, minBytes?: number, maxBytes?: number, status?: number[]}`. `mime` is substring match against the captured response `Content-Type` (case-insensitive, any one match wins; e.g. `["image/", "video/"]`). `urlPattern` is a RegExp source matched case-insensitively against the URL (e.g. `"\\\\.(woff2?|ttf|otf)$"`). `minBytes`/`maxBytes` bound the encoded response size when known. `status` defaults to 2xx (200..299). Filenames are derived from the URL path basename, **sanitised** (no path separators / NULs / leading dots / control bytes; length-capped), and collision-resolved with `-N` suffix. `intoDir` defaults to `$BROWX_WORKSPACE/assets/<sessionId>-<ISO>/`; an explicit value is resolved INSIDE `$BROWX_WORKSPACE` (escape rejected). Per-call caps: `maxCount` (default 10000) + `maxBytes` (default 500 MiB) bound runaway exports — callers can raise both up to hard ceilings. **CORS caveat**: when the response body has been discarded by the renderer (bodies are short-lived) the tool falls back to an in-page `fetch()` against the original URL — cross-origin URLs without permissive CORS headers land in `droppedCount`, never a crash. → `{ ok, intoDir, totalCount, matchedCount, persistedCount, droppedCount, manifest: [{url, mime?, status?, sizeBytes, savedAs}], warnings, tokensEstimate }`. The manifest is also written to `<intoDir>/_manifest.json`. `tokensEstimate` sizes the result envelope (the manifest blob), NOT the exported files. Gated by the off-by-default **`file-io`** capability — same posture as `download_get`.',
      inputSchema: {
        filter: z
          .object({
            mime: z
              .array(z.string())
              .optional()
              .describe(
                "Substring match against response Content-Type (case-insensitive). Any one match wins.",
              ),
            urlPattern: z
              .string()
              .optional()
              .describe("RegExp source matched case-insensitively against the URL."),
            minBytes: z
              .number()
              .int()
              .nonnegative()
              .optional()
              .describe("Inclusive lower bound on encoded response byte size (when known)."),
            maxBytes: z
              .number()
              .int()
              .nonnegative()
              .optional()
              .describe("Inclusive upper bound on encoded response byte size (when known)."),
            status: z
              .array(z.number().int())
              .optional()
              .describe("Allow-list of HTTP status codes. Default: 200..299."),
          })
          .describe("Filter applied to every entry in the session's network ring."),
        intoDir: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted output directory. Default `assets/<sessionId>-<ISO>/`. Rejected if it escapes $BROWX_WORKSPACE.",
          ),
        maxCount: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Override the per-call file count cap (default 10000; clamped to hard ceiling 50000).",
          ),
        maxBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Override the per-call total byte cap (default 500 MiB; clamped to hard ceiling 2 GiB).",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("asset_export");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const result = await withDeadline(
          assetExport(
            {
              cdp: requireCdp(e.session),
              page: e.session.page(),
              buffer: e.network,
              workspaceRoot: workspace.root,
              sessionId: e.id,
            },
            {
              filter: args.filter ?? {},
              intoDir: args.intoDir,
              maxCount: args.maxCount,
              maxBytes: args.maxBytes,
            },
          ),
          cfgActionTimeout(),
          "asset_export",
        );
        const json = JSON.stringify(result);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...result, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // `pdf_save` — print the current page to a workspace-rooted PDF via
  // Playwright `page.pdf()` (CDP `Page.printToPDF`). The mirror of
  // `upload_file`: file-io OUT instead of IN. Chromium-only (every browxai
  // session is Chromium so that's fine); refuses cleanly on `attached`/BYOB
  // sessions where driving PrintToPDF would surface a print dialog / mutate
  // the human's window state. Workspace-rooted by construction.
  register(
    "pdf_save",
    {
      capability: "action",
      deep: true,
      description:
        "Print the current page to a workspace-rooted PDF via Playwright `page.pdf()` (CDP `Page.printToPDF`). The first-class alternative to screenshot-and-OCR or driving the browser's print-to-file dialog with `shortcut`. → `{ ok, path, bytes, format, scale, printBackground }`. Defaults: `format:\"A4\"`, `scale:1`, `printBackground:false` (matches browser-print's default — opt in when background colour/imagery matters). Output `path` is resolved INSIDE `$BROWX_WORKSPACE` (a path escaping the workspace is rejected); omit it for a default `pdfs/<sessionId>-<ts>.pdf`. **Refuses on `attached`/BYOB sessions** — `page.pdf()` drives Chromium's PrintToPDF and would mutate the human's window state; open a managed (`persistent`/`incognito`) session and re-run there. Capability `action`.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted file path for the PDF. Default `pdfs/<sessionId>-<ts>.pdf`. Rejected if it escapes $BROWX_WORKSPACE.",
          ),
        format: z
          .enum(["Letter", "Legal", "Tabloid", "Ledger", "A0", "A1", "A2", "A3", "A4", "A5", "A6"])
          .optional()
          .describe('Paper format. Default "A4".'),
        scale: z
          .number()
          .min(0.1)
          .max(2.0)
          .optional()
          .describe(
            "Render scale. Default 1. Bounded to [0.1, 2.0] (Playwright's CDP-layer clamp).",
          ),
        printBackground: z
          .boolean()
          .optional()
          .describe(
            "Include CSS background-color / background-image. Default false (matches browser-print default).",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("pdf_save");
      if (g) return g;
      const e = await entryFor(args.session);
      const eg = engineGate("pdf_save", e);
      if (eg) return eg;
      try {
        const refused = assertPdfSupported({ mode: e.mode });
        if (refused) {
          const body = { ok: false, error: refused.error, hint: refused.hint };
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const r = await withDeadline(
          pdfSave(e.session.page(), workspace.root, e.id, {
            path: args.path,
            format: args.format,
            scale: args.scale,
            printBackground: args.printBackground,
          }),
          cfgActionTimeout(),
          "pdf_save",
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // `page_archive` — save the current page (HTML + linked resources) as a
  // self-contained artefact, either as a directory (`index.html` + `assets/`
  // sidecar) or as a single-file inlined HTML. Workspace-rooted by
  // construction (same `resolveWorkspacePath` posture as `pdf_save` /
  // `start_har`). Under the off-by-default `file-io` capability — a deliberate
  // filesystem egress, not a routine action. The agent is expected to
  // navigate + settle the page BEFORE calling: the tool does not inject its
  // own wait. The output is faithfully UNMASKED — see archive.ts header for
  // the secrets-masking deliberate-gap rationale.
  register(
    "page_archive",
    {
      capability: "file-io",
      description:
        "Save the current page as a self-contained archive. Two formats: `directory` (default) writes `<path>/index.html` + `<path>/assets/` sidecar with every linked resource (images, fonts, scripts, stylesheets, CSS background-images surfaced via getComputedStyle); HTML refs rewritten to relative `assets/...` paths. `single-file` writes one HTML at `<path>` with every resource inlined as a `data:` URI (browsers struggle past ~150 MB — large pages should prefer `directory`). `path` is resolved INSIDE `$BROWX_WORKSPACE` (escape rejected); omit for `archives/<sessionId>-<ISO>` (directory) or `archives/<sessionId>-<ISO>.html` (single-file). `maxSizeMb` caps the total archive (default 200) — resources past the budget land in `droppedCount`. Resource fetching runs `await fetch(url)` IN-page (subject to the page's CSP `connect-src` — cross-origin blocks are caught, dropped, and counted). → `{ ok, format, path, sizeBytes, resourceCount, droppedCount, warnings[] }`. **Secrets-masking caveat**: the archive is intentionally UNMASKED — running the egress masking layer would corrupt inline JSON/CSS/binary bytes; treat the archive as sensitive (same posture as `dump_storage_state`). Caller must navigate + settle the page BEFORE calling; `page_archive` does not inject its own wait. Capability `file-io`.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted output path (directory for `directory` format; .html file for `single-file`). Default `archives/<sessionId>-<ISO>[.html]`. Rejected if it escapes $BROWX_WORKSPACE.",
          ),
        format: z
          .enum(["directory", "single-file"])
          .optional()
          .describe(
            "`directory` (default) → index.html + assets/ sidecar; `single-file` → one HTML with data:-URI-inlined resources.",
          ),
        maxSizeMb: z
          .number()
          .positive()
          .max(10_000)
          .optional()
          .describe(
            "Total archive size cap (MB). Default 200. Resources past the budget are dropped + counted.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("page_archive");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const r = await withDeadline(
          pageArchive(e.session.page(), workspace.root, e.id, {
            path: args.path,
            format: args.format,
            maxSizeMb: args.maxSizeMb,
          }),
          cfgActionTimeout(),
          "page_archive",
        );
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}
