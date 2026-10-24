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
import type { PolicyShape } from "../policy/ask-human-guard.js";
import { askHumanPolicyGate } from "./ask-human-gate.js";
import { SESSION_ARG } from "./schemas.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ConfigHost,
  ServerServicesHost,
} from "./host.js";
import { requirePage } from "../engine/index.js";

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

  const askHumanGate = (
    tool: string,
    current: PolicyShape,
    next: PolicyShape,
    supportedKeys: readonly string[],
  ) => askHumanPolicyGate(gateCheck, tool, current, next, supportedKeys);

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
          .describe(
            'Dialog handling: "accept", "dismiss", "accept-prompt-with" (needs `text`) or "raise" (default).',
          ),
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
        'Change at runtime how the session answers page permission requests: camera, microphone, geolocation, notifications, clipboard, midi, sensors, payment-handler and background-sync (USB, Bluetooth and HID are out of scope). Use `grant_permissions` for a plain bulk grant and `permission_state` to read what is granted. The initial policy comes from `open_session({permissionPolicy})`; this replaces it, persists across navigation and returns the resolved policy. Modes:\n  - "allow": pre-grant through CDP; the page sees a granted permission.\n  - "deny": pre-deny; the page sees a denied permission (`NotAllowedError`).\n  - "raise" (default): deny, record the request, and make the next ActionResult `ok:false` with `failure:{source:"app"}` and a hint to set permissionPolicy. The page never deadlocks and a request cannot change app state unnoticed.\n  - "ask-human": the server waits for a human answer from the DevTools `browxai-…` console context (see `await_human`; page scripts cannot answer), then allows or denies.\nLeaving `ask-human` (through `mode` or `perPermission`) is refused with `requiredCapability:"human-gate-override"` unless the operator enabled that capability (off by default); changes that keep it are accepted. Fired requests appear on `ActionResult.permissionRequests[]`.',
      inputSchema: {
        mode: z
          .enum(["allow", "deny", "raise", "ask-human"])
          .describe('Policy mode: "allow", "deny", "raise" (default) or "ask-human".'),
        perPermission: z
          .record(z.string(), z.enum(["allow", "deny", "raise", "ask-human"]))
          .optional()
          .describe(
            "Per-permission overrides of `mode`, keyed by permission name: camera, microphone, geolocation, notifications, clipboard-read, clipboard-write, midi, midi-sysex, payment-handler, background-sync, accelerometer, gyroscope, magnetometer. Unknown names are rejected.",
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
        const cur = e.permission.current();
        const refused = askHumanGate(
          "set_permission_policy",
          { mode: cur.mode, overrides: cur.perPermission },
          { mode: next.mode, overrides: next.perPermission },
          SUPPORTED_PERMISSIONS,
        );
        if (refused) return refused;
        const resolved = e.permission.set(next);
        // Re-apply the CDP baseline so the new mapping is in effect for the
        // very next page-side check (the wrapper script reads policy live; CDP
        // baseline must also be refreshed so `navigator.permissions.query`
        // / native code paths see the new state).
        await applyPermissionCdpBaseline(requirePage(e.session).context(), e.permission).catch(
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
        'Change at runtime how the session answers File System Access picker calls (`showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`). Without a policy a headless page deadlocks on the picker. The initial policy comes from `open_session({fsPickerPolicy})`; this replaces it, persists across navigation and returns the resolved policy. Modes:\n  - "allow": the page gets synthetic file handles built from files you stage with `fs_picker_respond`, before the action that opens the picker or in parallel (the queue is per API). Save pickers write to a workspace-rooted `path`; open pickers read inline `contents` or a workspace-rooted `path`. The directory picker returns a handle with `.name` set and nothing to iterate.\n  - "deny": the picker throws `NotAllowedError`.\n  - "raise" (default): throw `NotAllowedError`, record the call, and make the next ActionResult `ok:false` with `failure:{source:"app"}` and a hint to set fsPickerPolicy.\n  - "ask-human": the server waits for the human\'s file list from the DevTools `browxai-…` console context (see `await_human`; page scripts cannot answer), then resolves with it or denies.\nLeaving `ask-human` (through `mode` or `perAPI`) is refused with `requiredCapability:"human-gate-override"` unless the operator enabled that capability (off by default), so the agent cannot switch to `allow` and answer itself. Changes that keep `ask-human` are accepted. Fired pickers appear on `ActionResult.fsPickerRequests[]`.',
      inputSchema: {
        mode: z
          .enum(["allow", "deny", "raise", "ask-human"])
          .describe('Policy mode: "allow", "deny", "raise" (default) or "ask-human".'),
        perAPI: z
          .record(z.string(), z.enum(["allow", "deny", "raise", "ask-human"]))
          .optional()
          .describe(
            "Per-picker overrides of `mode`, keyed by showOpenFilePicker, showSaveFilePicker or showDirectoryPicker. Unknown keys are rejected.",
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
        const cur = e.fsPicker.current();
        const refused = askHumanGate(
          "set_fs_picker_policy",
          { mode: cur.mode, overrides: cur.perAPI },
          { mode: next.mode, overrides: next.perAPI },
          SUPPORTED_FS_PICKER_APIS,
        );
        if (refused) return refused;
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
