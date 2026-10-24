import { confirmByobAction } from "../policy/confirm.js";
import { withDeadline } from "../util/deadline.js";
import { estimateTokens } from "../util/tokens.js";
import { uploadFile } from "../page/upload.js";
import { dropFiles, type DropFileInput } from "../page/drop-files.js";
import { readCapturedBytes } from "../page/downloads.js";
import { REF_OR_SELECTOR, SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";
import { requirePage } from "../engine/index.js";

/**
 * Capture + report — file ingress & download egress. `upload_file` / `drop_files`
 * (file ingress into the page), `downloads_capture` / `download_get` (capture and
 * read browser-initiated downloads under the workspace root). Registered through
 * the shared `ToolHost` seam.
 */
export function registerCaptureReportUploadTools(host: ToolHost): void {
  const {
    z,
    register,
    gateCheck,
    entryFor,
    confirmCtxFor,
    denyContent,
    asTarget,
    cfgActionTimeout,
    workspace,
  } = host;

  register(
    "upload_file",
    {
      capability: "file-io",
      description:
        "Set a file on a file `<input>` (hidden inputs work) with Playwright `setInputFiles`. Use `drop_files` for drop zones that have no `<input type=file>`. Target the input with `ref`, `selector` or `named`. The file is exactly one of `content` (base64, with `name` and `mimeType`; no filesystem read) or `path` (inside `$BROWX_WORKSPACE` only, symlinks resolved; stage the file there first). Requires the `file-io` capability (off by default).",
      inputSchema: {
        ...REF_OR_SELECTOR,
        name: z
          .string()
          .optional()
          .describe('Filename presented to the page (content-mode; default "upload").'),
        mimeType: z
          .string()
          .optional()
          .describe("MIME type (content-mode; default application/octet-stream)."),
        content: z
          .string()
          .optional()
          .describe("base64 file content. Mutually exclusive with `path`."),
        path: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted file path, resolved through symlinks. A path that leaves $BROWX_WORKSPACE is rejected. Mutually exclusive with `content`.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("upload_file");
      if (g) return g;
      const e = await entryFor(args.session);
      const c = await confirmByobAction("upload_file", confirmCtxFor(e));
      if (!c.ok) return denyContent("upload_file", c);
      try {
        const target = asTarget(args, "upload_file", e.refs);
        if ("coords" in target) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: false,
                    error:
                      "upload_file: target must be a ref/selector for the file input, not coords",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const r = await withDeadline(
          uploadFile(requirePage(e.session), e.refs, workspace.root, {
            target,
            name: args.name,
            mimeType: args.mimeType,
            content: args.content,
            path: args.path,
          }),
          cfgActionTimeout(),
          "upload_file",
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

  // `drop_files` — sibling to `upload_file` for drop-zone uploaders. Modern
  // SaaS file pickers listen for `dragenter`/`dragover`/`drop` with a
  // populated `DataTransfer.files` and never expose an `<input type=file>` —
  // `setInputFiles` can't drive them. drop_files synthesizes the standard
  // HTML5 drop sequence with `File` objects built in-page from the bytes the
  // caller supplies (`path` mode reads from $BROWX_WORKSPACE; `contents`
  // mode is inline base64). Same `file-io` capability as upload_file.
  register(
    "drop_files",
    {
      capability: "file-io",
      description:
        "Simulate an HTML5 file drag-and-drop on a page element, for drop-zone uploaders that expose no `<input type=file>`. Use `upload_file` when an input exists. Target with `ref`, `selector`, `named` or `coords`. `files[]` holds one or more entries, each exactly one of `{path, name?, mimeType?}` (inside `$BROWX_WORKSPACE`, as for `upload_file`) or `{contents, name, mimeType?}` (base64, no filesystem read). It builds a `DataTransfer` of `File` objects and dispatches `dragenter`, `dragover` and `drop` once for all files, at the element's box centre (or the literal coords). Returns `{ ok, target, files: [{name, mode, bytes, mimeType}], totalBytes, fileCount, eventsFired, dropDispatched, tokensEstimate }`. Requires the `file-io` capability (off by default).",
      inputSchema: {
        ...REF_OR_SELECTOR,
        files: z
          .array(
            z.object({
              path: z
                .string()
                .optional()
                .describe("Workspace-rooted file path. Mutually exclusive with `contents`."),
              contents: z
                .string()
                .optional()
                .describe("base64 file content. Mutually exclusive with `path`."),
              name: z
                .string()
                .optional()
                .describe(
                  "Filename presented to the page. Required in `contents`-mode; defaults to the basename of `path` in `path`-mode.",
                ),
              mimeType: z
                .string()
                .optional()
                .describe('MIME type. Default "application/octet-stream".'),
            }),
          )
          .min(1)
          .describe(
            "Files to drop. Each entry is exactly one of `{path}` or `{contents}` (plus optional `name`/`mimeType`).",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("drop_files");
      if (g) return g;
      const e = await entryFor(args.session);
      const c = await confirmByobAction("drop_files", confirmCtxFor(e));
      if (!c.ok) return denyContent("drop_files", c);
      try {
        const target = asTarget(args, "drop_files", e.refs);
        const r = await withDeadline(
          dropFiles(requirePage(e.session), e.refs, workspace.root, {
            target,
            files: args.files as DropFileInput[],
          }),
          cfgActionTimeout(),
          "drop_files",
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

  // Download capture — the reverse of `upload_file`. Off by default per
  // session; toggled by `downloads_capture`. When on, any download fired
  // during a subsequent action lands on `ActionResult.downloads[]` and can
  // be read back via `download_get`. Workspace-rooted paths only.
  register(
    "downloads_capture",
    {
      capability: "file-io",
      description:
        "Turn download capture on or off for the session. With `on:true`, each download fired during a later action is saved to `$BROWX_WORKSPACE/.downloads/<sessionId>/<prefix>-<sanitised-name>` and listed on `ActionResult.downloads[{id, suggestedFilename, mimeType, sizeBytes, path}]`; read it with `download_get({id})`. With `on:false` (the default) downloads are discarded, so a session that never opted in leaves no file on disk. The page-supplied file name is sanitised (no path separators, NULs, leading dots or control bytes; length-capped). Pass `clear:true` with `on:false` to also delete every captured file. Returns `{ ok, captureOn, storageDir, captured: [{id, suggestedFilename, sizeBytes, path, mimeType?}], tokensEstimate }`. Requires the `file-io` capability (off by default).",
      inputSchema: {
        on: z.boolean().describe("Turn capture on (true) or off (false). Off by default."),
        clear: z
          .boolean()
          .optional()
          .describe(
            "When toggling off, also delete every previously-captured file from disk. No-op when `on:true`.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("downloads_capture");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        e.downloads.captureOn = !!args.on;
        if (!args.on && args.clear) {
          // best-effort cleanup of previously-captured files. Every entry's
          // `path` is rooted under BROWX_WORKSPACE/.downloads/<sessionId>/
          // by construction (see SessionEntry factory + page/downloads.ts).
          const { unlinkSync } = await import("node:fs");
          for (const d of e.downloads.list()) {
            try {
              unlinkSync(d.path);
            } catch {
              /* best-effort */
            }
          }
        }
        const captured = e.downloads.list().map((d) => {
          const out: {
            id: string;
            suggestedFilename: string;
            sizeBytes: number;
            path: string;
            mimeType?: string;
          } = {
            id: d.id,
            suggestedFilename: d.suggestedFilename,
            sizeBytes: d.sizeBytes,
            path: d.path,
          };
          if (d.mimeType !== undefined) out.mimeType = d.mimeType;
          return out;
        });
        const body = {
          ok: true,
          captureOn: e.downloads.captureOn,
          storageDir: e.downloads.storageDir,
          captured,
        };
        const json = JSON.stringify(body);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...body, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
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

  register(
    "download_get",
    {
      capability: "file-io",
      description:
        "Return the bytes (base64) of a captured download; pass the `id` from `ActionResult.downloads[]` or `downloads_capture({on:true}).captured[]`. Set `pathOnly:true` to skip the base64 and return only the path and metadata, which suits large files you hand on by path. A file over 16 MiB is never returned inline: the call fails with an error naming the limit and the saved path, and `pathOnly:true` still works. Returns `{ ok, id, suggestedFilename, mimeType?, sizeBytes, path, content?: base64, tokensEstimate }`. Requires the `file-io` capability (off by default).",
      inputSchema: {
        id: z.string().describe("Download id from ActionResult.downloads[].id."),
        pathOnly: z
          .boolean()
          .optional()
          .describe("When true, omit the base64 `content` field and return only path/metadata."),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("download_get");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const r = readCapturedBytes(e.downloads, args.id, { pathOnly: args.pathOnly });
        const body: Record<string, unknown> = {
          ok: true,
          id: args.id,
          suggestedFilename: r.suggestedFilename,
          sizeBytes: r.bytes,
          path: r.path,
        };
        if (r.mimeType !== undefined) body.mimeType = r.mimeType;
        if (r.base64 !== undefined) body.content = r.base64;
        const json = JSON.stringify(body);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...body, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
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
}
