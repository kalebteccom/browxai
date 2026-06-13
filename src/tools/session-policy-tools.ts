import { readFileSync } from "node:fs";
import { basename as pathBasename } from "node:path";

import { estimateTokens } from "../util/tokens.js";
import { parseDialogPolicyArg, type DialogPolicy } from "../session/dialog.js";
import {
  applyCdpBaseline as applyPermissionCdpBaseline,
  parsePermissionPolicyArg,
  readPermissionStates,
  SUPPORTED_PERMISSIONS,
  BYOB_PERMISSION_WARNING,
  type PermissionPolicy,
  type SupportedPermission,
} from "../session/permission.js";
import {
  parseNotificationPolicyArg,
  propagateSyncDecision as propagateNotificationSyncDecision,
  type NotificationPolicy,
} from "../session/notification.js";
import {
  parseFsPickerPolicyArg,
  resolveWorkspaceFsPath,
  SUPPORTED_FS_PICKER_APIS,
  type FsPickerPolicy,
  type FsPickerFile,
} from "../session/fs-picker.js";
import { SUPPORTED_DEVICE_APIS } from "../session/device-emu.js";
import { SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

/**
 * Session lifecycle + per-session policy tools — open / close / list sessions and
 * the runtime policy mutators a session is driven with: dialog, permission,
 * file-system-picker, and notification policies, plus the permission-state read
 * and the device-request read companion. Every block is registered through the
 * shared `ToolHost` seam; the host owns the closures (register / gate / entry /
 * registry / workspace), this module owns the registrations.
 */
export function registerSessionPolicyTools(host: ToolHost): void {
  const { z, register, gateCheck, entryFor, registry, workspace } = host;

  // ---------- session lifecycle ----------

  register(
    "open_session",
    {
      description:
        "Eagerly create an isolated session (own browser context / cookie jar / refs). Optional — any tool with a `session` arg lazily creates the id on first use (inheriting the server's launch mode); call this to launch up-front, fail fast, or pick a `mode`. Re-opening a live id is an error (close it first). Different ids = full isolation, so two sessions logged in as different users on the same app don't bleed. This is also the second half of wedged-session recovery: after `close_session` discards a dead session, open a fresh one here (a fresh id, or the same id reused) and restart the wedged work in it.\n\n`mode`:\n  - `persistent` (default off-attach) — own profile dir under the workspace; cookies survive across runs. `profile` names the dir (default = the session id).\n  - `incognito` — ephemeral; nothing persisted, all state discarded on close.\n  - `attached` — BYOB; requires the server started with BROWX_ATTACH_CDP.\n\nOptionally seed the new context with a storage state at creation. `storageState` accepts either an inline blob (as returned by `dump_storage_state`) or a workspace-rooted JSON path. `authState` references a named slot from `auth_save`. Mutually exclusive. Native primitive on `incognito`; on `persistent` it post-seeds AND clears the profile's existing cookies/localStorage first (loud-warned). Ignored on `attached`.",
      inputSchema: {
        session: z.string().describe('Session id to create (e.g. "agent-a", "user-2").'),
        mode: z
          .enum(["persistent", "incognito", "attached"])
          .optional()
          .describe(
            "Session mode. Default: the server's launch mode (attached if BROWX_ATTACH_CDP is set, else persistent).",
          ),
        profile: z
          .string()
          .optional()
          .describe(
            "persistent mode only: named profile dir under <workspace>/profiles/. Default = the session id. Lets two ids share a profile, or one id pin a stable profile name.",
          ),
        device: z
          .string()
          .optional()
          .describe(
            'Playwright device-preset name (e.g. "iPhone 14", "Pixel 7", "Desktop Chrome") → viewport + DPR + isMobile + hasTouch + UA. Falls back to config `defaultDevice`. Best-effort on `attached`.',
          ),
        viewport: z
          .object({ width: z.number().int().positive(), height: z.number().int().positive() })
          .optional()
          .describe(
            "explicit viewport; overrides a preset's viewport. Falls back to config `defaultViewport`.",
          ),
        dialogPolicy: z
          .string()
          .optional()
          .describe(
            'How the session handles `alert`/`confirm`/`prompt` dialogs. One of: "accept" (auto-OK), "dismiss" (auto-cancel), "accept-prompt-with:<text>" (prompts answered with `<text>`; alert/confirm accepted), "raise" (DEFAULT — dialog dismissed server-side so the page never deadlocks, but the next action returns ok:false with a structured failure so a dialog never silently changes app state under an unaware caller). Mutate at runtime with `set_dialog_policy`.',
          ),
        permissionPolicy: z
          .union([
            z.string(),
            z.object({
              mode: z.enum(["allow", "deny", "raise", "ask-human"]),
              perPermission: z.record(z.enum(["allow", "deny", "raise", "ask-human"])).optional(),
            }),
          ])
          .optional()
          .describe(
            'How the session handles page-side permission requests (camera, microphone, geolocation, notifications, clipboard, sensors). String form sets the top-level mode ("allow"|"deny"|"raise"|"ask-human"); object form takes `{mode, perPermission?:{<name>:<mode>}}` for per-permission overrides. DEFAULT "raise" — request rejected page-side so the page never deadlocks, but the next action returns ok:false with a structured failure so a permission request never silently changes app state under an unaware caller. Mutate at runtime with `set_permission_policy`. NOTE: governs the *permission check* (`Notification.requestPermission`) only — the `new Notification(...)` constructor surface is governed separately by `notificationPolicy`.',
          ),
        notificationPolicy: z
          .union([z.string(), z.object({ mode: z.enum(["allow", "deny", "raise", "ask-human"]) })])
          .optional()
          .describe(
            'How the session handles `new Notification(title, opts)` constructor calls. String form sets the mode; object form is `{mode}`. Modes mirror permissionPolicy. DEFAULT "allow" (browser default — constructor proceeds, OS displays per its settings) — but every call is still captured on `ActionResult.notifications[]` for observability. Distinct from `permissionPolicy.notifications` (which gates the W3C permission check); the two policies compose. Mutate at runtime with `set_notification_policy`.',
          ),
        fsPickerPolicy: z
          .union([
            z.string(),
            z.object({
              mode: z.enum(["allow", "deny", "raise", "ask-human"]),
              perAPI: z.record(z.enum(["allow", "deny", "raise", "ask-human"])).optional(),
            }),
          ])
          .optional()
          .describe(
            'How the session handles page-side File System Access picker calls (showOpenFilePicker, showSaveFilePicker, showDirectoryPicker). String form sets the top-level mode ("allow"|"deny"|"raise"|"ask-human"); object form takes `{mode, perAPI?:{<api>:<mode>}}` for per-API overrides. DEFAULT "raise" — picker rejected page-side so the page never deadlocks, but the next action returns ok:false with a structured failure so a picker call never silently changes app state under an unaware caller. Pair `allow` with `fs_picker_respond` to stage agent-supplied files. Mutate at runtime with `set_fs_picker_policy`.',
          ),
        storageState: z
          .union([
            z.string(),
            z
              .object({
                cookies: z.array(z.any()),
                origins: z.array(z.any()),
              })
              .passthrough(),
          ])
          .optional()
          .describe(
            "Bulk-seed: inline state blob (`{cookies, origins}` from dump_storage_state) OR a workspace-rooted JSON path. Mutually exclusive with `authState`. Native on incognito; on persistent it post-seeds AND clears the profile (loud-warned); ignored on attached.",
          ),
        authState: z
          .string()
          .optional()
          .describe(
            "Named-state seed: load a slot from `$BROWX_WORKSPACE/.auth-states/<name>.json` (written by `auth_save`). Mutually exclusive with `storageState`.",
          ),
        har: z
          .object({
            path: z
              .string()
              .optional()
              .describe(
                "Workspace-rooted HAR file path. Default: `<workspace>/har/<session-id>-<ISO>.har`. Path traversal outside `$BROWX_WORKSPACE` is rejected.",
              ),
            mode: z
              .enum(["full", "minimal"])
              .optional()
              .describe(
                "`full` (default — full HAR with sizes/timing/cookies) or `minimal` (just enough to replay via `routeFromHAR`).",
              ),
            content: z
              .enum(["embed", "attach", "omit"])
              .optional()
              .describe(
                "Body persistence: `embed` (default for `.har`) inlines bodies, `attach` writes sidecar files (default for `.zip`), `omit` drops bodies.",
              ),
            urlFilter: z
              .string()
              .optional()
              .describe("Optional glob/regex URL filter — only matching requests are stored."),
          })
          .optional()
          .describe(
            "Record HAR for the lifetime of this session via Playwright's native `recordHar` context option. The file is finalized when the session closes (Playwright constraint — there is no mid-session flush on the native path). For runtime start/stop granularity use the `start_har`/`stop_har` tools instead. Honoured on `persistent` + `incognito` (we own the context); ignored on `attached` (consumer's Chrome is not-owned).",
          ),
        hars: z
          .array(z.string())
          .optional()
          .describe(
            'REPLAY HAR file(s) — workspace-rooted paths. Each is wired via `context.routeFromHAR(file, {notFound:"fallback"})` immediately after context creation: requests in the archive are served from it, anything missing falls through to the live network. Path traversal rejected; a missing file errors (no silent fallback on a typo). Compose multiple HARs to layer fixtures.',
          ),
        recordVideo: z
          .object({
            path: z
              .string()
              .optional()
              .describe(
                "Workspace-rooted .webm file path. Default: `<workspace>/videos/<session-id>-<ISO>.webm`. Path traversal outside `$BROWX_WORKSPACE` is rejected.",
              ),
            size: z
              .object({ width: z.number().int().positive(), height: z.number().int().positive() })
              .optional()
              .describe(
                "Recorded video frame size. Defaults to the viewport scaled to fit 800x800 (Playwright default).",
              ),
          })
          .optional()
          .describe(
            "Record session video for the lifetime of this session via Playwright's native `recordVideo` context option. The .webm is finalized when the session closes (Playwright constraint — there is no mid-context flush). `stop_video` signals intent + reserves the target path; `get_video` reads the file after `close_session`. Honoured on `persistent` + `incognito` (we own the context); refused on `attached` (consumer's Chrome is not-owned). Capability `file-io` on the stop/get tools.",
          ),
      },
    },
    async ({
      session,
      mode,
      profile,
      device,
      viewport,
      dialogPolicy,
      permissionPolicy,
      notificationPolicy,
      fsPickerPolicy,
      storageState,
      authState,
      har,
      hars,
      recordVideo,
    }) => {
      if (registry.has(session)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: `session "${session}" already open; close_session first` },
                null,
                2,
              ),
            },
          ],
        };
      }
      let parsedDialogPolicy: DialogPolicy | undefined;
      let parsedPermissionPolicy: PermissionPolicy | undefined;
      let parsedNotificationPolicy: NotificationPolicy | undefined;
      let parsedFsPickerPolicy: FsPickerPolicy | undefined;
      try {
        parsedDialogPolicy = dialogPolicy ? parseDialogPolicyArg(dialogPolicy) : undefined;
        parsedPermissionPolicy = permissionPolicy
          ? parsePermissionPolicyArg(permissionPolicy)
          : undefined;
        parsedNotificationPolicy = notificationPolicy
          ? parseNotificationPolicyArg(notificationPolicy)
          : undefined;
        parsedFsPickerPolicy = fsPickerPolicy ? parseFsPickerPolicyArg(fsPickerPolicy) : undefined;
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
      try {
        const e = await registry.get(session, {
          mode,
          profile,
          device,
          viewport,
          dialogPolicy: parsedDialogPolicy,
          permissionPolicy: parsedPermissionPolicy,
          notificationPolicy: parsedNotificationPolicy,
          fsPickerPolicy: parsedFsPickerPolicy,
          storageState,
          authState,
          har: har,
          hars,
          recordVideo: recordVideo,
        });
        const harField = e.har.path
          ? {
              har: {
                path: e.har.path,
                mode: e.har.mode,
                content: e.har.content,
                nativeRecord: !!e.har.nativeRecord,
                finalizesOn: "close_session" as const,
              },
            }
          : {};
        const replayField = hars && hars.length ? { harsReplay: hars.length } : {};
        const videoField =
          e.video.active && e.video.targetPath
            ? {
                video: {
                  path: e.video.targetPath,
                  size: e.video.size,
                  finalizesOn: "close_session" as const,
                },
              }
            : {};
        // safari has no Playwright Page — read the opened URL from its WebDriver
        // Classic client instead.
        const safariOpened = e.session.safari?.();
        const openedUrl = safariOpened
          ? await safariOpened.webDriver.currentUrl(safariOpened.sessionId).catch(() => "")
          : e.session.page().url();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: true,
                  session: e.id,
                  mode: e.mode,
                  url: openedUrl,
                  openedAt: new Date(e.openedAt).toISOString(),
                  ...harField,
                  ...replayField,
                  ...videoField,
                },
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
    "close_session",
    {
      description:
        "Tear down a session: detaches the bridge and closes the browser context (a BYOB/attached session detaches only — never closes the user's Chrome). The \"default\" session may be closed too; it'll be lazily re-created on the next call. No-op-safe. This is also the RECOVERY path for a wedged session: when calls time out repeatedly (a `sessionWedged` result, or snapshot/navigate/screenshot all timing out), close the session and `open_session` a fresh one — a wedged session is NOT recoverable in place by re-navigating or retrying.",
      inputSchema: { session: z.string().describe("Session id to close.") },
    },
    async ({ session }) => {
      const closed = await registry.close(session);
      // Diagnostics JSONL is intentionally KEPT across close_session — the
      // recovery path for a (real OR falsely-flagged) wedge IS close_session,
      // and the notes / calls filed right before the close are the most
      // valuable feedback the curator gets. Retention sweep (default 30d)
      // handles long-term cleanup; per-session removal is the wrong scope.
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, session, wasOpen: closed }, null, 2),
          },
        ],
      };
    },
  );

  register(
    "close_sessions",
    {
      description:
        "Bulk session teardown for multi-agent cleanup. Select by `prefix` (id starts-with — e.g. one agent's `agentA-*`), `all`, and/or `idleMs` (no use in the last N ms). Filters AND together; at least one selector is required (`all:true` to close everything). Returns the closed ids. Use to reclaim memory + state when a sub-agent wedged or was killed and stranded its sessions.",
      inputSchema: {
        prefix: z.string().optional().describe("Close sessions whose id starts with this."),
        all: z
          .boolean()
          .optional()
          .describe("Close every live session. Required if neither prefix nor idleMs is given."),
        idleMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Close sessions with no activity in the last N ms (idle-age reap)."),
      },
    },
    async ({ prefix, all, idleMs }) => {
      if (prefix === undefined && idleMs === undefined && all !== true) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error:
                    "close_sessions: pass `prefix`, `idleMs`, and/or `all:true` — refusing to close nothing/everything implicitly",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const closed = await registry.closeMatching({ prefix, all, idleMs });
      // Diagnostics JSONL is intentionally KEPT across session teardown —
      // notes filed pre-close are exactly the valuable feedback. Retention
      // sweep (default 30d) handles long-term cleanup.
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, closed, count: closed.length }, null, 2),
          },
        ],
      };
    },
  );

  register(
    "list_sessions",
    {
      description:
        "List live sessions: id, mode, engine, current url, page count, openedAt. Audit / coordination helper for multi-session work.",
      inputSchema: {},
    },
    async () => {
      const rows = registry.list().map((e) => ({
        id: e.id,
        mode: e.mode,
        engine: e.session.engine,
        url: (() => {
          try {
            return e.session.page().url();
          } catch {
            return null;
          }
        })(),
        pages: (() => {
          try {
            return e.session.page().context().pages().length;
          } catch {
            return null;
          }
        })(),
        openedAt: new Date(e.openedAt).toISOString(),
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ sessions: rows }, null, 2) }],
      };
    },
  );

  register(
    "set_dialog_policy",
    {
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

  register(
    "permission_state",
    {
      description:
        'Read the current permission state(s) for an origin via the W3C Permissions API (`navigator.permissions.query` — which reflects the CDP-applied baseline). Returns `{ [permission]: "granted" | "denied" | "prompt" | "unknown" }` per requested name. Defaults the `origin` to the current page\'s origin when omitted. Read-only — does not mutate state. Supported permission names (v1): ' +
        SUPPORTED_PERMISSIONS.join(", ") +
        ". Sibling of `set_permission_policy`.",
      inputSchema: {
        permissions: z
          .array(z.string())
          .min(1)
          .describe(
            'Canonical permission names to query — see tool description for the supported set. Unknown names map to `"unknown"` in the result.',
          ),
        origin: z
          .string()
          .optional()
          .describe(
            'Origin to query (e.g. "https://example.com"). Omit to use the current page\'s origin.',
          ),
        ...SESSION_ARG,
      },
    },
    async ({ permissions, origin, session }) => {
      const g = gateCheck("permission_state");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const supported = permissions.filter((p): p is SupportedPermission =>
          (SUPPORTED_PERMISSIONS as readonly string[]).includes(p),
        );
        const states = await readPermissionStates(
          e.session.page().context(),
          e.session.page(),
          supported,
          origin,
        );
        const out: Record<string, string> = { ...states };
        for (const p of permissions) {
          if (!(p in out)) out[p] = "unknown";
        }
        const body = {
          ok: true,
          session: e.id,
          origin:
            origin ??
            (() => {
              try {
                return new URL(e.session.page().url()).origin;
              } catch {
                return null;
              }
            })(),
          states: out,
          tokensEstimate: estimateTokens(JSON.stringify(out)),
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

  register(
    "set_notification_policy",
    {
      description:
        "Mutate the session's notification policy at runtime. Governs `new Notification(title, opts)` *constructor* calls — the page actually attempting to display a notification. Distinct from `set_permission_policy` (which gates `Notification.requestPermission` and the `Notification.permission` state); the two policies compose. Modes:\n" +
        '  - "allow"     — DEFAULT (browser default). Constructor proceeds; the OS displays per its own settings. Every call is still captured on `ActionResult.notifications[]` for observability.\n' +
        '  - "deny"      — Constructor throws `NotAllowedError` (the same exception the browser raises when permission is denied). Use to suppress OS notifications while still observing what the page would have shown.\n' +
        '  - "raise"     — Constructor throws AND RECORDS; the next ActionResult flips `ok:false` with `failure:{source:"app", hint:"unhandled notification — set notificationPolicy"}`. Useful when notifications should be a hard signal that the action triggered an unexpected user-facing event.\n' +
        '  - "ask-human" — server blocks on `__browx.confirm(true|false)` (the `await_human({kind:"confirm"})` mechanism), then resolves to allow/deny per the human\'s answer. The constructor returns a stub synchronously (the spec requires a sync return); the real OS notification fires once the human-decision resolves.\n' +
        "Persists across navigation: the init-script is re-injected on every new document within the session. Returns the resolved policy. Captured calls surface on `ActionResult.notifications[] = [{title, body?, icon?, tag?, timestamp, origin?, handledAs}]`.",
      inputSchema: {
        mode: z
          .enum(["allow", "deny", "raise", "ask-human"])
          .describe("Policy mode — see tool description."),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("set_notification_policy");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const next: NotificationPolicy = { mode: args.mode };
        const resolved = e.notification.set(next);
        // Push the new sync-decision hint to every live page so the
        // constructor's throw timing tracks the policy without a reload.
        await propagateNotificationSyncDecision(e.session.page().context(), e.notification).catch(
          () => undefined,
        );
        const tokensEstimate = estimateTokens(JSON.stringify(resolved));
        const body = { ok: true, session: e.id, policy: resolved, tokensEstimate };
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
    "device_requests",
    {
      description:
        'Read-side companion to `emulate_bluetooth` / `emulate_usb` / `emulate_hid`. Returns the buffer of `requestDevice()` calls the page has made on this session — one entry per page-side call, each with `{api, handledAs, returned, filters?, ts}`. Useful for diagnosing "did the page even ask?" when a flow gated on hardware appears stuck. `handledAs`:\n' +
        '  - `"resolved"`  — catalog non-empty; picker resolved with the synthetic device (Bluetooth/USB) or device list (HID).\n' +
        '  - `"rejected"` — catalog empty for Bluetooth/USB; picker rejected with `NotFoundError` (user-dismissed shape).\n' +
        '  - `"empty"`    — catalog empty for HID; picker resolved with `[]` (HID\'s user-dismissed shape).\n' +
        '  - `"refused"`  — capability `device-emulation` was OFF at the time of the call; the wrapper short-circuited. Recorded so the read surfaces "the page asked for hardware and you didn\'t have the capability on".\n' +
        "**Gated behind the off-by-default `device-emulation` capability** — a server without the capability can't even read whether the page tried to ask (same posture class as `eval` / `network-body` / `secrets`). Read-only — does not mutate state.",
      inputSchema: {
        since: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "epoch ms — return only records with `ts >= since`. Default 0 (return everything in the buffer).",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ since, session }) => {
      const g = gateCheck("device_requests");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const records = e.webDeviceEmulation.since(typeof since === "number" ? since : 0);
        const body: Record<string, unknown> = {
          ok: true,
          session: e.id,
          supportedApis: [...SUPPORTED_DEVICE_APIS],
          requests: records,
        };
        body.tokensEstimate = estimateTokens(JSON.stringify(body));
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
