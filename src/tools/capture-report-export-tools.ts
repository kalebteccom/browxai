import { requireCdp, requirePage } from "../engine/index.js";
import { withDeadline } from "../util/deadline.js";
import { estimateTokens } from "../util/tokens.js";
import { assetExport } from "../page/asset-export.js";
import { assertPdfSupported } from "../page/pdf.js";
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
  const { z, register, gateCheck, engineGate, entryFor, captureFor, cfgActionTimeout, workspace } =
    host;

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
        'Save the resources the session has loaded (responses in its network buffer) that match a filter into a workspace-rooted directory, for example every image or font a page used. Use `page_archive` for a self-contained copy of the page and `download_get` for files the page downloaded. `filter` is `{mime?: string[], urlPattern?: string, minBytes?: number, maxBytes?: number, status?: number[]}`, and every given field must match: `mime` is a case-insensitive substring of the `Content-Type` (any one wins, such as `["image/","video/"]`), `urlPattern` a case-insensitive RegExp source, `status` defaults to 2xx. File names come from the URL basename, sanitised and de-duplicated with a `-N` suffix; existing files are never overwritten. `intoDir` must resolve inside `$BROWX_WORKSPACE` (default `assets/<sessionId>-<ISO>/`). When the renderer has dropped a body the tool re-fetches the URL from the page, and cross-origin URLs without permissive CORS count in `droppedCount`. Returns `{ ok, intoDir, totalCount, matchedCount, persistedCount, droppedCount, manifest: [{url, mime?, status?, sizeBytes, savedAs}], warnings, tokensEstimate }`; the manifest is also written to `<intoDir>/_manifest.json`. Requires the `file-io` capability (off by default).',
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
          .describe(
            "Which entries of the session's network buffer to save: `{mime?: string[], urlPattern?: string, minBytes?: number, maxBytes?: number, status?: number[]}`. `minBytes` and `maxBytes` bound the encoded response size in bytes. All given fields must match.",
          ),
        intoDir: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted output directory. Default `assets/<sessionId>-<ISO>/`. A path that leaves $BROWX_WORKSPACE is rejected.",
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
              page: requirePage(e.session),
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
        'Print the current page to a workspace-rooted PDF (`page.pdf()`, CDP `Page.printToPDF`), when you need text and layout as a document rather than an image. Defaults: `format:"A4"`, `scale:1`, `printBackground:false` (the browser-print default; turn it on when background colour or imagery matters). `path` must resolve inside `$BROWX_WORKSPACE` (default `pdfs/<sessionId>-<ts>.pdf`). Refused on `attached` sessions, because printing would change your own Chrome window: open a `persistent` or `incognito` session and run it there. Returns `{ ok, path, bytes, format, scale, printBackground }`.',
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
        // Through the capture port. This handler held a `requirePage` purely to
        // hand the `Page` to `pdfSave` while `captureFor(e)` sat unused beside it
        // — RFC 0009's `pdf` bypass cluster. The engine gate above still runs
        // first (`pdf_save` keeps `deep: true`), so what changes for a Playwright
        // engine is which module calls `page.pdf()`, and nothing else.
        const r = await withDeadline(
          captureFor(e).pdf({
            workspaceRoot: workspace.root,
            sessionId: e.id,
            path: args.path,
            format: args.format,
            scale: args.scale,
            printBackground: args.printBackground,
          }),
          cfgActionTimeout(),
          "pdf_save",
        );
        const body =
          r.kind === "saved"
            ? r.result
            : { ok: false, error: r.error, ...(r.hint ? { hint: r.hint } : {}) };
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
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
        'Save the current page as a self-contained archive, to keep or share a page. Use `dom_export` for the DOM only and `element_export` for one subtree. `format:"directory"` (default) writes `<path>/index.html` plus `<path>/assets/` with every linked resource (images, fonts, scripts, stylesheets, CSS background images), with HTML references rewritten to relative `assets/...` paths. `"single-file"` writes one HTML at `<path>` with resources inlined as `data:` URIs; browsers struggle past about 150 MB, so prefer `directory` for large pages. `path` must resolve inside `$BROWX_WORKSPACE` (default `archives/<sessionId>-<ISO>`, or `.html` for single-file). `maxSizeMb` caps the archive (default 200); resources past it count in `droppedCount`. Resources are fetched from inside the page, so its CSP `connect-src` applies and blocked ones are dropped and counted. Load and settle the page first; the tool does not wait. The output is not masked, so treat it as sensitive. Returns `{ ok, format, path, sizeBytes, resourceCount, droppedCount, warnings[] }`. Requires the `file-io` capability (off by default).',
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
          pageArchive(requirePage(e.session), workspace.root, e.id, {
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
