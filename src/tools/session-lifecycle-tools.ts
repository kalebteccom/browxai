import type { SessionEntry } from "../session/registry.js";
import type { TargetSubstrate } from "../page/target-substrate.js";
import {
  validateEngine,
  IMPLEMENTED_ENGINES,
  requirePage,
  type EngineKind,
} from "../engine/index.js";
import { askHumanProfileRefusal } from "./ask-human-gate.js";
import { byobAttachRefusal } from "./byob-attach-gate.js";
import { resolveOpenSessionPolicies } from "./open-session-policies.js";
import { isValidProfileName, PROFILE_NAME_RULE } from "../util/profile-name.js";
import { openSessionPrecheck } from "./open-session-precheck.js";
import type {
  GateHost,
  RegisterHost,
  SessionHost,
  ServerServicesHost,
  TargetHost,
  ToolResponse,
} from "./host.js";

/** Wrap a JSON-serialisable body as a tool text response — the shared shape the
 *  session-lifecycle handlers return. */
function lifecycleJson(body: object): ToolResponse {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
}

/** The standard `ok:false` lifecycle envelope for an unknown throw — the message
 *  lifted from an Error or stringified. */
function lifecycleError(err: unknown): ToolResponse {
  return lifecycleJson({ ok: false, error: err instanceof Error ? err.message : String(err) });
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

/** The URL a freshly-opened session landed on. Read through the target port, so
 *  the engine that has no Playwright Page answers from its own client without a
 *  branch here. Best-effort: a session that cannot answer reports "", which is
 *  what the WebDriver leg returned before the port existed. */
function openedUrlFor(target: TargetSubstrate): Promise<string> {
  return target.url().catch(() => "");
}

/** Validate the optional per-session `engine`. Returns the validated EngineKind
 *  (or undefined when omitted), or a structured `unknown-engine` error response.
 *  Lives in the handler path (not only in Zod) because direct / in-process (SDK)
 *  callers bypass the MCP schema parse — the boundary check must be here. */
function resolveOpenSessionEngine(
  engine: string | undefined,
): { ok: true; engine: EngineKind | undefined } | { ok: false; response: ToolResponse } {
  if (engine === undefined) return { ok: true, engine: undefined };
  try {
    return { ok: true, engine: validateEngine(engine) };
  } catch (err) {
    return {
      ok: false,
      response: lifecycleJson({
        ok: false,
        code: "unknown-engine",
        engine,
        implementedEngines: IMPLEMENTED_ENGINES,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

/**
 * Session lifecycle tools: open_session / close_session / close_sessions /
 * list_sessions. Split out of `session-policy-tools` by cohesive family (RFC 0004
 * P3 / D3 SRP); registered through the shared `ToolHost` seam in the same source
 * order. The host owns the closures (register / registry).
 */
export function registerSessionLifecycleTools(
  host: RegisterHost & GateHost & SessionHost & ServerServicesHost & TargetHost,
): void {
  const { z, register, registry, targetFor, gateCheck } = host;
  // Session creation throws these two gate errors; open_session reports them
  // in the standard capability-refusal shape.
  const gateRefusalFor = (err: unknown) =>
    askHumanProfileRefusal(gateCheck, err) ?? byobAttachRefusal(gateCheck, err);

  register(
    "open_session",
    {
      description:
        'Create an isolated session (own browser context, cookie jar and refs) up front. Optional: any tool with a `session` argument creates that id on first use, so call this to fail fast or to set `mode`, `engine`, `profile` and policies at creation. A live id cannot be reopened: `close_session` it first. Ids are plain names (letters, digits, `.`, `_`, `-`; start with a letter or digit; at most 128 characters), else `invalid-name`.\n\n`mode`:\n  - `persistent` (default unless the server attaches): profile under `<workspace>/profiles/`, cookies survive runs. One live session per profile, else `profile-in-use`: pass another `profile` or use `incognito`.\n  - `incognito`: nothing persisted.\n  - `attached`: your own Chrome via BROWX_ATTACH_CDP. Requires the `byob-attach` capability (off by default), else refused with `requiredCapability:"byob-attach"`.\n\nA reopened id keeps `ask-human` on `permissionPolicy`, `fsPickerPolicy` and `notificationPolicy` if its last session held it; moving a held key off `ask-human` is refused with `requiredCapability:"human-gate-override"` unless the operator enabled it. A session that wedges (calls keep timing out) is replaced, not retried: `close_session`, then open a fresh one here.',
      inputSchema: {
        session: z
          .string()
          .refine(isValidProfileName, PROFILE_NAME_RULE)
          .describe(
            'Session id to create (e.g. "agent-a", "user-2"). A plain name: letters, digits, `.`, `_`, `-`, starting with a letter or digit, at most 128 characters.',
          ),
        mode: z
          .enum(["persistent", "incognito", "attached"])
          .optional()
          .describe(
            "Session mode. Default: the server's launch mode (`attached` if BROWX_ATTACH_CDP is set, else `persistent`). `attached` requires the `byob-attach` capability (off by default).",
          ),
        engine: z
          .enum([
            "chromium",
            "firefox",
            "webkit",
            "android",
            "safari",
            "ios-app",
            "android-app",
            "electron",
          ])
          .optional()
          .describe(
            'Browser engine for this session; omit to inherit the server default (`--engine`, `BROWX_ENGINE`, else chromium). One server can run sessions on different engines. `android` (Chrome on Android over adb, defaults to `attached`) and `electron` (a running desktop Electron app over its `--remote-debugging-port`) are attach-only and need the `byob-attach` capability (off by default). `firefox` and `webkit` refuse attach; `safari` has no `incognito` and no attach. `ios-app` and `android-app` are native app engines: they need the `native-device` capability (off by default) and have no `incognito`. `ios-app` reads BROWX_IOS_DEVICE, BROWX_IOS_APP_ID or BROWX_IOS_APP_PATH and needs a WebDriverAgent at BROWX_IOS_WDA_URL; `android-app` leases one adb device per session (BROWX_ANDROID_APP_SERIAL picks it when several are ready). `electron` refuses `navigate`, and the desktop attach lane usually detects it, so you rarely name it. An unimplemented engine is refused with `code:"unknown-engine"` and the `implementedEngines` list.',
          ),
        profile: z
          .string()
          .refine(isValidProfileName, PROFILE_NAME_RULE)
          .optional()
          .describe(
            "`persistent` mode only: a named profile directory under <workspace>/profiles/, a plain name (letters, digits, `.`, `_`, `-`; start with a letter or digit; at most 128 characters). Default: the workspace's default profile (BROWX_DEFAULT_PROFILE when set, else <workspace>/profile), whatever the session id. One live session per profile: a second is refused with `profile-in-use`, so pass a distinct `profile` or use mode `incognito`.",
          ),
        channel: z
          .string()
          .optional()
          .describe(
            'Playwright browser channel for a chromium session ("chrome", "msedge", "chrome-beta", "chrome-dev", "msedge-beta", "chromium", …). Default (unset here, in config `channel` and in `BROWX_CHANNEL`): the operator\'s INSTALLED Google Chrome, falling back to Playwright\'s bundled Chromium with a logged warning when Chrome is not installed. "chromium" forces the bundled build. Any other channel launches that installed browser and fails if it is missing (there is no download step). A launch with extensions and no channel stays on the bundled build. Ignored on `attached` (already launched) and on firefox/webkit/safari/android (firefox has its own `BROWX_FIREFOX_CHANNEL`). The browser version tracks the operator\'s install, not the version browxai pins.',
          ),
        backgroundThrottling: z
          .enum(["default", "disabled"])
          .optional()
          .describe(
            'Background-tab lifecycle for a chromium session. "default" (DEFAULT) keeps Chrome\'s own behaviour: `requestAnimationFrame` pauses in a background tab, timers throttle to once a minute after five minutes, and a hidden+occluded tab can be frozen. "disabled" launches with `--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding` so a backgrounded session keeps running at full rate — recommended for pooled multi-agent attached work, where an agent polling a backgrounded tab otherwise stalls to its deadline and the stall reads as a page bug. Left at "default" because the opposite need is equally real: reproducing a lifecycle bug requires a genuinely throttled tab. Ignored on `attached` (launch-time flags).',
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
            "Explicit viewport in CSS px, `{width, height}`. Overrides a `device` preset's viewport. Falls back to config `defaultViewport`.",
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
              perPermission: z
                .record(z.string(), z.enum(["allow", "deny", "raise", "ask-human"]))
                .optional(),
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
              perAPI: z
                .record(z.string(), z.enum(["allow", "deny", "raise", "ask-human"]))
                .optional(),
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
                "Workspace-rooted HAR file path. Default: `<workspace>/har/<session-id>-<ISO>.har`. A path outside `$BROWX_WORKSPACE` is rejected, and a .zip path is refused (use .har).",
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
                "Body persistence: `omit` (default) drops bodies, `embed` inlines them, `attach` writes sidecar files. `embed` and `attach` need the `network-body` capability.",
              ),
            urlFilter: z
              .string()
              .optional()
              .describe("Optional glob/regex URL filter — only matching requests are stored."),
          })
          .optional()
          .describe(
            "Record a HAR for the lifetime of this session through Playwright's `recordHar`. The file is written when the session closes (there is no mid-session flush); use `start_har` and `stop_har` for runtime control. On close it is rewritten with `Cookie`, `Set-Cookie` and `Authorization` values emptied and registered secrets masked; without the `network-body` capability request bodies are emptied too. Honoured on `persistent` and `incognito`; ignored on `attached`.",
          ),
        hars: z
          .array(z.string())
          .optional()
          .describe(
            'Replay HAR file(s), workspace-rooted paths. Each is wired with `context.routeFromHAR(file, {notFound:"fallback"})` right after context creation: matching requests are served from the archive and the rest go to the live network. A path outside $BROWX_WORKSPACE (including through a symlink) is rejected, and a missing file errors. A HAR recorded without bodies replays empty bodies. Several HARs layer fixtures.',
          ),
        recordVideo: z
          .object({
            path: z
              .string()
              .optional()
              .describe(
                "Workspace-rooted .webm file path. Default: `<workspace>/videos/<session-id>-<ISO>.webm`. A path outside `$BROWX_WORKSPACE` is rejected.",
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
            "Record session video for the lifetime of this session through Playwright's `recordVideo`. The .webm is written when the session closes; `stop_video` reserves the path and `get_video` reads the file after `close_session` (both need the `file-io` capability, off by default). Honoured on `persistent` and `incognito`; refused on `attached`.",
          ),
      },
    },
    async ({
      session,
      mode,
      engine,
      profile,
      channel,
      backgroundThrottling,
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
      const early = openSessionPrecheck(registry.has(session), session, profile);
      if (early) return lifecycleJson(early);
      const engineResult = resolveOpenSessionEngine(engine);
      if (!engineResult.ok) return engineResult.response;
      const resolved = resolveOpenSessionPolicies(
        gateCheck,
        session,
        registry.heldAskHuman(session),
        {
          dialogPolicy,
          permissionPolicy,
          notificationPolicy,
          fsPickerPolicy,
          harContent: har?.content,
        },
      );
      if (!resolved.ok) return resolved.response;
      const policies = resolved.policies;
      try {
        const e = await registry.get(session, {
          mode,
          engine: engineResult.engine,
          profile,
          channel,
          backgroundThrottling,
          device,
          viewport,
          ...policies,
          storageState,
          authState,
          har: har,
          hars,
          recordVideo: recordVideo,
        });
        return lifecycleJson({
          ok: true,
          session: e.id,
          mode: e.mode,
          engine: e.session.engine,
          url: await openedUrlFor(targetFor(e)),
          openedAt: new Date(e.openedAt).toISOString(),
          ...buildOpenSessionResultFields(e, hars),
        });
      } catch (err) {
        return gateRefusalFor(err) ?? lifecycleError(err);
      }
    },
  );

  register(
    "close_session",
    {
      description:
        "Close a session: detach the bridge and close its browser context (an `attached` session only detaches and never closes your Chrome). The `default` session can be closed too and is recreated on the next call. Closing an id that is not open is a no-op (`wasOpen:false`). HAR and video files finalize on close. This is also the recovery for a wedged session: when calls keep timing out (a `sessionWedged` result, or snapshot, navigate and screenshot all timing out), close it and `open_session` a fresh one; re-navigating or retrying does not recover it.",
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
        "Close many sessions at once, for multi-agent cleanup; use `close_session` for one id. Select by `prefix` (ids starting with it, such as `agentA-`), `all`, and/or `idleMs` (no use in the last N ms). Selectors combine with AND and at least one is required (`all:true` closes everything). Returns the closed ids. Use it to reclaim sessions a sub-agent stranded when it wedged or died.",
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
        "List live sessions with id, mode, engine, current url, page count and openedAt, for multi-session coordination and cleanup. Takes no arguments. Open one with `open_session`, close one with `close_session`.",
      inputSchema: {},
    },
    async () => {
      const rows = await Promise.all(
        registry.list().map(async (e) => ({
          id: e.id,
          mode: e.mode,
          engine: e.session.engine,
          // Read through the target port: an engine with no Playwright Page
          // reports its real URL instead of the `null` the old `page()` throw
          // produced. Still best-effort — a target mid-teardown reports null.
          url: await targetFor(e)
            .url()
            .catch(() => null),
          // Multi-tab has no non-Playwright analogue; RFC 0009 leaves the
          // target pool behind the Playwright handle, so this one stays.
          pages: (() => {
            try {
              return requirePage(e.session).context().pages().length;
            } catch {
              return null;
            }
          })(),
          openedAt: new Date(e.openedAt).toISOString(),
        })),
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ sessions: rows }, null, 2) }],
      };
    },
  );
}
