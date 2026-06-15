import { confirmByobAction } from "../policy/confirm.js";
import { withDeadline } from "../util/deadline.js";
import { estimateTokens } from "../util/tokens.js";
import { uploadFile } from "../page/upload.js";
import { dropFiles, type DropFileInput } from "../page/drop-files.js";
import { readCapturedBytes } from "../page/downloads.js";
import { REF_OR_SELECTOR, SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

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
        "Set a file on a file `<input>` (works on hidden inputs) via Playwright `setInputFiles` — the first-class alternative to injecting `File`/`DataTransfer` through `eval_js`. Target the input by `ref`/`selector`. File source is exactly one of: `content` (base64 inline — no filesystem read; pass `name`/`mimeType`) OR `path` (resolved **inside `$BROWX_WORKSPACE` only** — a path escaping the workspace is rejected; stage the file there). Gated by the off-by-default **`file-io`** capability.",
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
          .describe("Workspace-rooted file path. Mutually exclusive with `content`."),
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
          uploadFile(e.session.page(), e.refs, workspace.root, {
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
        "Synthesize an HTML5 file drag-drop on a page element — the first-class alternative to driving DataTransfer through `eval_js` for drop-zone uploaders that don't expose an `<input type=file>` (modern SaaS file pickers). Target via the standard target shapes (`ref`/`selector`/`named`/`coords`). `files[]` carries one or more file entries; each entry is exactly one of: `{path, name?, mimeType?}` (workspace-rooted file — escape-rejected, same posture as `upload_file`'s `path`) OR `{contents, name, mimeType?}` (base64 inline — no filesystem read). Builds an in-page `DataTransfer` populated with `File` objects and dispatches `dragenter` → `dragover` → `drop` on the target with realistic `clientX`/`clientY` (element box centre for ref/selector; literal coords). Drops every file in a single sequence — passing multiple entries simulates the multi-file drop most uploaders support natively. → `{ ok, target, files: [{name, mode, bytes, mimeType}], totalBytes, fileCount, eventsFired, dropDispatched, tokensEstimate }`. Gated by the off-by-default **`file-io`** capability.",
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
          dropFiles(e.session.page(), e.refs, workspace.root, {
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
        "Per-session download capture — toggle interception of Playwright `download` events. When `on:true`, every download fired during a subsequent action is persisted to `$BROWX_WORKSPACE/.downloads/<sessionId>/<prefix>-<sanitised-name>` and surfaced on `ActionResult.downloads[{id, suggestedFilename, mimeType, sizeBytes, path}]`. When `on:false` (the default) the artifact is silently discarded so a session that never opted in leaves no on-disk trace. The page-supplied filename is sanitised (no path separators / NULs / leading dots / control bytes; length-capped) before composing the on-disk name — workspace-escape rejected. Read captured bytes with `download_get({id})`. Gated by the off-by-default **`file-io`** capability — same posture as `upload_file`. → `{ ok, captureOn, storageDir, captured: [{id, suggestedFilename, sizeBytes, path, mimeType?}], tokensEstimate }`. Pass `clear:true` alongside `on:false` to ALSO delete every captured file on disk.",
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
        "Return the bytes (base64) of a previously-captured download. Pass the `id` from `ActionResult.downloads[]` (or `downloads_capture({on:true}).captured[]`). Set `pathOnly:true` to skip the base64 payload and return just the workspace-rooted path metadata (useful for very large artifacts an agent only needs to forward to another tool by path). → `{ ok, id, suggestedFilename, mimeType?, sizeBytes, path, content?: base64, tokensEstimate }`. Gated by the off-by-default **`file-io`** capability.",
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
        const r = readCapturedBytes(e.downloads, args.id);
        const body: Record<string, unknown> = {
          ok: true,
          id: args.id,
          suggestedFilename: r.suggestedFilename,
          sizeBytes: r.bytes,
          path: r.path,
        };
        if (r.mimeType !== undefined) body.mimeType = r.mimeType;
        if (!args.pathOnly) body.content = r.base64;
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
