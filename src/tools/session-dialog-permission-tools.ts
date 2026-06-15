import { readFileSync } from "node:fs";
import { basename as pathBasename } from "node:path";

import { estimateTokens } from "../util/tokens.js";
import { type DialogPolicy } from "../session/dialog.js";
import {
  applyCdpBaseline as applyPermissionCdpBaseline,
  SUPPORTED_PERMISSIONS,
  BYOB_PERMISSION_WARNING,
  type PermissionPolicy,
} from "../session/permission.js";
import {
  resolveWorkspaceFsPath,
  SUPPORTED_FS_PICKER_APIS,
  type FsPickerPolicy,
  type FsPickerFile,
} from "../session/fs-picker.js";
import { SESSION_ARG } from "./schemas.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ConfigHost,
  ServerServicesHost,
} from "./host.js";

/**
 * Dialog / permission / file-system-picker policy tools: set_dialog_policy /
 * set_permission_policy / set_fs_picker_policy / fs_picker_respond. Split out of
 * `session-policy-tools` by cohesive family (RFC 0004 P3 / D3 SRP); registered
 * through the shared `ToolHost` seam in the same source order. The host owns the
 * closures (register / gate / entry / workspace).
 */
export function registerSessionDialogPermissionTools(
  host: RegisterHost & GateHost & SessionHost & ConfigHost & ServerServicesHost,
): void {
  const { z, register, gateCheck, entryFor, workspace } = host;

  register(
    "set_dialog_policy",
    {
      capability: "action",
      description:
        "Mutate the session's dialog policy at runtime. Governs how `alert` / `confirm` / `prompt` / `beforeunload` dialogs are handled when fired by the page — without a policy installed, a dialog blocks every subsequent browser event and the session deadlocks. Modes:\n" +
        '  - "accept"               — accept every dialog (confirm/prompt → OK; prompt answers with the empty string).\n' +
        '  - "dismiss"              — dismiss every dialog (confirm/prompt → Cancel).\n' +
        '  - "accept-prompt-with"   — accept; prompts answer with `text` (required). Alert/confirm just accept.\n' +
        '  - "raise"                — DEFAULT. Dialog is dismissed server-side so the page never deadlocks, but the next action returns ok:false with `failure:{source:"app", hint:"unhandled dialog — set dialogPolicy"}` so a dialog can\'t silently change app state under a caller that didn\'t opt in.\n' +
        "Persists across navigation: the handler is re-installed on every new page within the session. The initial policy is set at `open_session({dialogPolicy})`; this tool replaces it. Returns the resolved policy. Fired dialogs surface on `ActionResult.dialogs[]`.",
      inputSchema: {
        mode: z
          .enum(["accept", "dismiss", "raise", "accept-prompt-with"])
          .describe("Policy mode — see tool description."),
        text: z
          .string()
          .optional()
          .describe(
            'Required when mode="accept-prompt-with" — the answer text to send for prompts. Ignored for other modes.',
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("set_dialog_policy");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const next: DialogPolicy =
          args.mode === "accept-prompt-with"
            ? { mode: "accept-prompt-with", text: args.text ?? "" }
            : { mode: args.mode };
        if (next.mode === "accept-prompt-with" && args.text === undefined) {
          throw new Error('set_dialog_policy: mode "accept-prompt-with" requires `text`');
        }
        const resolved = e.dialog.set(next);
        const tokensEstimate = estimateTokens(JSON.stringify(resolved));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: true, session: e.id, policy: resolved, tokensEstimate },
                null,
                2,
              ),
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
    "set_permission_policy",
    {
      capability: "action",
      description:
        "Mutate the session's permission policy at runtime. Governs how page-side permission requests — `getUserMedia` (camera/microphone), `getCurrentPosition`/`watchPosition` (geolocation), `Notification.requestPermission`, `clipboard.read`/`write`, and the sensor permissions — are handled. Without a policy installed, requests either fire silently (Chromium auto-denies in headless) or — if a prior `grant_permissions` pre-granted — change app behavior under an unaware caller. Modes:\n" +
        '  - "allow"     — pre-grant via CDP `Browser.setPermission`; in-page wrappers call through. The app sees a granted permission.\n' +
        '  - "deny"      — pre-deny via CDP; in-page wrappers reject with `NotAllowedError`. The app sees a denied permission.\n' +
        '  - "raise"     — DEFAULT. Pre-deny + in-page wrappers reject AND RECORD; the next ActionResult flips `ok:false` with `failure:{source:"app", hint:"unhandled permission request — set permissionPolicy"}`. The page never deadlocks (the request is rejected), but a permission request can\'t silently change app state under a caller that didn\'t opt in.\n' +
        '  - "ask-human" — server blocks on `__browx.confirm(true|false)` (the `await_human({kind:"confirm"})` mechanism), then resolves to allow/deny per the human\'s answer.\n' +
        'Per-permission overrides (`perPermission: { camera: "allow", notifications: "deny", … }`) win over the top-level `mode`. Persists across navigation: the init-script is re-injected on every new document within the session. The initial policy is set at `open_session({permissionPolicy})`; this tool replaces it. Returns the resolved policy. Fired requests surface on `ActionResult.permissionRequests[]`. Supported permission names (v1): ' +
        SUPPORTED_PERMISSIONS.join(", ") +
        ". USB / Bluetooth / HID are out of scope for v1.\n" +
        'Sibling to `grant_permissions` — that tool remains as the bulk-grant shortcut for the `mode:"allow"` case; this tool is the full policy surface.',
      inputSchema: {
        mode: z
          .enum(["allow", "deny", "raise", "ask-human"])
          .describe("Top-level policy mode — see tool description."),
        perPermission: z
          .record(z.enum(["allow", "deny", "raise", "ask-human"]))
          .optional()
          .describe(
            "Per-permission overrides. Keys: one of the supported permission names (see tool description). Each value overrides the top-level `mode` for that permission. Unknown names are rejected.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("set_permission_policy");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const next: PermissionPolicy = {
          mode: args.mode,
          ...(args.perPermission
            ? {
                perPermission: args.perPermission,
              }
            : {}),
        };
        const resolved = e.permission.set(next);
        // Re-apply the CDP baseline so the new mapping is in effect for the
        // very next page-side check (the wrapper script reads policy live; CDP
        // baseline must also be refreshed so `navigator.permissions.query`
        // / native code paths see the new state).
        await applyPermissionCdpBaseline(e.session.page().context(), e.permission).catch(
          () => undefined,
        );
        const warnings: string[] = [];
        if (e.mode === "attached") warnings.push(BYOB_PERMISSION_WARNING);
        const tokensEstimate = estimateTokens(JSON.stringify(resolved));
        const body: Record<string, unknown> = {
          ok: true,
          session: e.id,
          policy: resolved,
          tokensEstimate,
        };
        if (warnings.length) body.warnings = warnings;
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

  register(
    "set_fs_picker_policy",
    {
      capability: "action",
      description:
        "Mutate the session's File System Access picker policy at runtime. Governs how `showOpenFilePicker` / `showSaveFilePicker` / `showDirectoryPicker` calls are handled. Without a policy installed, modern web editors deadlock on the picker dialog the headless session can't drive. Modes:\n" +
        '  - "allow"     — page-side stubs return synthetic FileSystem*Handle objects built from agent-supplied files (call `fs_picker_respond` BEFORE the action that triggers the picker, OR in parallel — the queue is drained per-API on the next matching call). For `showSaveFilePicker`, the agent supplies a workspace-rooted `path` and `createWritable()` writes from the page persist there. For `showOpenFilePicker`, the agent supplies inline `contents` (base64) or a workspace-rooted `path` (server inlines the bytes); the page reads via `getFile()`.\n' +
        '  - "deny"      — stubs throw `NotAllowedError`. The page sees the user-dismissed-picker branch.\n' +
        '  - "raise"     — DEFAULT. Stubs throw `NotAllowedError` AND RECORD; the next ActionResult flips `ok:false` with `failure:{source:"app", hint:"unhandled File System Access picker — set fsPickerPolicy"}`. The page never deadlocks (the picker rejects immediately), but a picker call can\'t silently change app state under a caller that didn\'t opt in.\n' +
        '  - "ask-human" — server blocks on `__browx.respond({kind:"fs_picker_respond", value:{files:[…]}})` (the `await_human` mechanism), then resolves with the human-approved file list or denies.\n' +
        'Per-API overrides (`perAPI: { showSaveFilePicker: "allow", showOpenFilePicker: "deny", … }`) win over the top-level `mode`. Persists across navigation: the init-script is re-injected on every new document within the session. The initial policy is set at `open_session({fsPickerPolicy})`; this tool replaces it. Returns the resolved policy. Fired pickers surface on `ActionResult.fsPickerRequests[]`. Supported APIs (v1): ' +
        SUPPORTED_FS_PICKER_APIS.join(", ") +
        ". Directory picker returns a minimal handle (`.name` set; iteration empty) — most editors will fall back to per-file pickers when iteration yields nothing.",
      inputSchema: {
        mode: z
          .enum(["allow", "deny", "raise", "ask-human"])
          .describe("Top-level policy mode — see tool description."),
        perAPI: z
          .record(z.enum(["allow", "deny", "raise", "ask-human"]))
          .optional()
          .describe(
            "Per-API overrides. Keys: one of " +
              SUPPORTED_FS_PICKER_APIS.join(", ") +
              ". Each value overrides the top-level `mode` for that picker. Unknown keys are rejected.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("set_fs_picker_policy");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const next: FsPickerPolicy = {
          mode: args.mode,
          ...(args.perAPI
            ? {
                perAPI: args.perAPI,
              }
            : {}),
        };
        const resolved = e.fsPicker.set(next);
        const tokensEstimate = estimateTokens(JSON.stringify(resolved));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: true, session: e.id, policy: resolved, tokensEstimate },
                null,
                2,
              ),
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
    "fs_picker_respond",
    {
      capability: "file-io",
      description:
        'Stage agent-supplied files for the next File System Access picker call on this session — paired with `set_fs_picker_policy({mode:"allow"})` (or a `perAPI` override). The queue is per-API: a response staged for `showSaveFilePicker` won\'t satisfy a `showOpenFilePicker` call. Each file is either inline `{contents, name?, mimeType?}` (base64 — no filesystem read) or workspace-rooted `{path}` (resolved inside `$BROWX_WORKSPACE` only; path escape rejected). For `showSaveFilePicker`, the supplied `path` becomes the destination for `createWritable()`-driven writes from the page — `write()` / `truncate()` / `close()` from the page-side stream are persisted there. For `showOpenFilePicker`, the server reads `path` once at respond-time and inlines the bytes (the page reads via `getFile()`). Capability `file-io` — same posture as `upload_file`. Returns `{ok, session, queued:{api, fileCount}, tokensEstimate}`.',
      inputSchema: {
        api: z
          .enum(SUPPORTED_FS_PICKER_APIS)
          .describe(
            "The picker API this response is for. Must match the call the page will make next.",
          ),
        files: z
          .array(
            z.object({
              path: z
                .string()
                .optional()
                .describe(
                  "Workspace-rooted file path. Mutually exclusive with `contents`. For save-pickers: write destination. For open-pickers: source file bytes are inlined at respond-time. For directory-picker: basename becomes the handle's `.name`.",
                ),
              contents: z
                .string()
                .optional()
                .describe(
                  "base64 file content. Mutually exclusive with `path`. Open-picker only — for save-pickers the writable stream needs a destination path, not source bytes.",
                ),
              name: z
                .string()
                .optional()
                .describe(
                  'Filename presented to the page when `contents` is used. Default `"browxai-virtual"`. Ignored when `path` is used (basename of `path` is taken).',
                ),
              mimeType: z
                .string()
                .optional()
                .describe(
                  'MIME type for the synthetic `File` exposed to the page. Default `"application/octet-stream"`.',
                ),
            }),
          )
          .describe(
            "Files to hand back to the page. `showSaveFilePicker` consumes only the first entry; `showOpenFilePicker` consumes all (the page sees an Array<FileSystemFileHandle>); `showDirectoryPicker` consumes only the first entry and reads its basename as the directory `.name`.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("fs_picker_respond");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        for (const f of args.files as FsPickerFile[]) {
          if (f.path !== undefined && f.contents !== undefined) {
            throw new Error(
              "fs_picker_respond: each file must pass exactly one of `path` or `contents`",
            );
          }
          if (f.path === undefined && f.contents === undefined) {
            throw new Error("fs_picker_respond: each file must pass `path` or `contents`");
          }
          if (f.path !== undefined) {
            // Validate workspace-rooted; throws on escape. The actual file
            // I/O for save-picker writes happens later when the page calls
            // `createWritable()`; for open-picker the read happens at the
            // binding layer when the page calls `getFile()` (we inline at
            // respond-time below).
            resolveWorkspaceFsPath(workspace.root, f.path);
          }
        }
        // For open-pickers + showDirectoryPicker: when the agent supplied
        // `{path}` (no inline contents), read the file once now and inline
        // its bytes so the page-side `getFile()` resolves without another
        // server round-trip. Save-pickers keep `path` as the WRITE target
        // (no read).
        const api = args.api;
        const prepared: FsPickerFile[] = (args.files as FsPickerFile[]).map((f) => {
          if (api === "showSaveFilePicker") return f;
          if (f.path === undefined || f.contents !== undefined) return f;
          try {
            const resolved = resolveWorkspaceFsPath(workspace.root, f.path);
            const bytes = readFileSync(resolved);
            return {
              ...f,
              contents: bytes.toString("base64"),
              name: f.name ?? pathBasename(resolved),
            };
          } catch (err) {
            throw new Error(
              `fs_picker_respond: failed to read \`path\` ${JSON.stringify(f.path)} — ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        });
        e.fsPicker.pushResponse(api, prepared);
        const body = {
          ok: true,
          session: e.id,
          queued: { api, fileCount: prepared.length },
          tokensEstimate: estimateTokens(JSON.stringify({ api, fileCount: prepared.length })),
        };
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

}
