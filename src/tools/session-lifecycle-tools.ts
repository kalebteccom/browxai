import {
  parseDialogPolicyArg,
  type DialogPolicy,
} from "../session/dialog.js";
import {
  parsePermissionPolicyArg,
  type PermissionPolicy,
} from "../session/permission.js";
import {
  parseNotificationPolicyArg,
  type NotificationPolicy,
} from "../session/notification.js";
import {
  parseFsPickerPolicyArg,
  type FsPickerPolicy,
} from "../session/fs-picker.js";
import type { SessionEntry } from "../session/registry.js";
import type { RegisterHost, SessionHost, ServerServicesHost } from "./host.js";

/** The parsed policy bundle `open_session` threads into `registry.get`. Extracting
 *  the four parse ternaries into one pure helper keeps the handler under the
 *  complexity budget (RFC 0004 P3 / D3) — same logic, decomposed. */
interface ParsedOpenSessionPolicies {
  dialogPolicy?: DialogPolicy;
  permissionPolicy?: PermissionPolicy;
  notificationPolicy?: NotificationPolicy;
  fsPickerPolicy?: FsPickerPolicy;
}

/** Parse the four optional policy args (throws on a malformed policy string — the
 *  handler's try/catch surfaces it as a structured `ok:false`). Byte-identical to
 *  the prior inline ternaries. */
function parseOpenSessionPolicies(args: {
  dialogPolicy?: string | DialogPolicy;
  permissionPolicy?: string | PermissionPolicy;
  notificationPolicy?: string | NotificationPolicy;
  fsPickerPolicy?: string | FsPickerPolicy;
}): ParsedOpenSessionPolicies {
  return {
    dialogPolicy: args.dialogPolicy ? parseDialogPolicyArg(args.dialogPolicy) : undefined,
    permissionPolicy: args.permissionPolicy
      ? parsePermissionPolicyArg(args.permissionPolicy)
      : undefined,
    notificationPolicy: args.notificationPolicy
      ? parseNotificationPolicyArg(args.notificationPolicy)
      : undefined,
    fsPickerPolicy: args.fsPickerPolicy ? parseFsPickerPolicyArg(args.fsPickerPolicy) : undefined,
  };
}

/** Build the optional `har` / `harsReplay` / `video` fields of the open_session
 *  result envelope from the opened entry. Pure; byte-identical to the prior inline
 *  ternaries. */
function buildOpenSessionResultFields(
  e: SessionEntry,
  hars: string[] | undefined,
): Record<string, unknown> {
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
  return { ...harField, ...replayField, ...videoField };
}

/**
 * Session lifecycle tools: open_session / close_session / close_sessions /
 * list_sessions. Split out of `session-policy-tools` by cohesive family (RFC 0004
 * P3 / D3 SRP); registered through the shared `ToolHost` seam in the same source
 * order. The host owns the closures (register / registry).
 */
export function registerSessionLifecycleTools(
  host: RegisterHost & SessionHost & ServerServicesHost,
): void {
  const { z, register, registry } = host;

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
      let policies: ParsedOpenSessionPolicies;
      try {
        policies = parseOpenSessionPolicies({
          dialogPolicy,
          permissionPolicy,
          notificationPolicy,
          fsPickerPolicy,
        });
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
          dialogPolicy: policies.dialogPolicy,
          permissionPolicy: policies.permissionPolicy,
          notificationPolicy: policies.notificationPolicy,
          fsPickerPolicy: policies.fsPickerPolicy,
          storageState,
          authState,
          har: har,
          hars,
          recordVideo: recordVideo,
        });
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
                  ...buildOpenSessionResultFields(e, hars),
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
      batchable: true,
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

}
