import { withDeadline } from "../util/deadline.js";
import { confirmByobAction } from "../policy/confirm.js";
import {
  startHar,
  stopHar,
  readHarIfSmall,
  harWritesBodies,
  HAR_INLINE_CAP_BYTES,
} from "../page/har.js";
import { stopVideo, readVideoIfReady, VIDEO_INLINE_CAP_BYTES } from "../page/video.js";
import { SESSION_ARG } from "./schemas.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ConfigHost,
  EnvelopeHost,
  StorageHost,
  ActionHost,
  ServerServicesHost,
} from "./host.js";
import { requirePage } from "../engine/index.js";

/**
 * Per-session artifact KV + HAR record/replay + video recording tools:
 * artifact_save / artifact_get / artifact_list, start_har / stop_har, stop_video /
 * get_video. Split out of `storage-tools` by cohesive family (RFC 0004 P3 / D3
 * SRP); registered through the shared `ToolHost` seam in the same source order.
 */
export function registerStorageArtifactHarVideoTools(
  host: RegisterHost &
    GateHost &
    SessionHost &
    ConfigHost &
    EnvelopeHost &
    StorageHost &
    ActionHost &
    ServerServicesHost,
): void {
  const {
    z,
    register,
    gateCheck,
    entryFor,
    okText,
    errText,
    confirmCtxFor,
    denyContent,
    workspace,
    cfgActionTimeout,
  } = host;

  // ---- per-session artifact KV ----------------------------------------------
  //
  // Session-scoped workspace primitives. First-class save/get/list of string
  // or binary payloads (the "build your own library over time" loop). Before
  // this, agents round-tripped scripts/files/blobs through `name_ref`/
  // `name_region` — both ref-typed and a poor fit for raw bytes.
  //
  // Capability split: `artifact_save` → `action` (writes a file);
  // `artifact_get` / `artifact_list` → `read`. Workspace-rooted at
  // `$BROWX_WORKSPACE/.artifacts/<sessionId>/<name>`. Name restricted
  // (no separators / `..` / leading dots). Capacity-bounded (200 entries,
  // 50 MiB); oldest-write evicted. The on-disk dir is wiped on session
  // teardown — sessions that never wrote an artifact leave no trace.

  register(
    "artifact_save",
    {
      capability: "action",
      description:
        'Save a text or binary artifact to the session\'s key-value store at `$BROWX_WORKSPACE/.artifacts/<sessionId>/<name>`. `name` is letters, digits and `._-` only (no separators, `..` or leading dot). `content` is text by default (`encoding:"utf8"`); pass `encoding:"base64"` for binary. Saving an existing name overwrites it. The store holds 200 entries or 50 MiB per session; past either cap the oldest-written entry is evicted. Artifacts are deleted on `close_session`. Read back with `artifact_get`, list with `artifact_list`. Returns `{ ok, name, size, mtime, path }`.',
      inputSchema: {
        name: z
          .string()
          .describe(
            "Artifact name. Letters/digits/`._-` only — no separators, no `..`, no leading dot.",
          ),
        content: z
          .string()
          .describe(
            'Content to store. Text by default; pass `encoding:"base64"` for binary payloads.',
          ),
        encoding: z
          .enum(["utf8", "base64"])
          .optional()
          .describe("How `content` is encoded. Default `utf8` (text). Use `base64` for binary."),
        ...SESSION_ARG,
      },
    },
    async ({ name, content, encoding, session }) => {
      const g = gateCheck("artifact_save");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const info = e.artifacts.save(name, content, encoding ?? "utf8");
        return okText({
          ok: true,
          name: info.name,
          size: info.size,
          mtime: info.mtime,
          path: e.artifacts.pathFor(name),
        });
      } catch (err) {
        return errText("artifact_save", err);
      }
    },
  );

  register(
    "artifact_get",
    {
      capability: "read",
      description:
        "Read back a session artifact saved with `artifact_save`. `encoding` is `utf8` (default, text) or `base64` (faithful for binary). An unknown name errors: check `artifact_list`. Returns `{ ok, name, content, size, mtime, encoding }`.",
      inputSchema: {
        name: z.string().describe("Artifact name (as passed to `artifact_save`)."),
        encoding: z
          .enum(["utf8", "base64"])
          .optional()
          .describe("Return encoding. Default `utf8`; use `base64` for binary payloads."),
        ...SESSION_ARG,
      },
    },
    async ({ name, encoding, session }) => {
      const g = gateCheck("artifact_get");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const r = e.artifacts.get(name, encoding ?? "utf8");
        return okText({
          ok: true,
          name,
          content: r.content,
          size: r.size,
          mtime: r.mtime,
          encoding: r.encoding,
        });
      } catch (err) {
        return errText("artifact_get", err);
      }
    },
  );

  register(
    "artifact_list",
    {
      capability: "read",
      description:
        "List this session's artifacts, sorted by name: `{ ok, count, artifacts: [{ name, size, mtime }] }`. The store holds 200 entries or 50 MiB per session and is cleared on `close_session`.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("artifact_list");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const artifacts = e.artifacts.list();
        return okText({ ok: true, count: artifacts.length, artifacts });
      } catch (err) {
        return errText("artifact_list", err);
      }
    },
  );

  // ---- HAR record / replay ---------------------------------------------------
  //
  // Full-session reproducibility — capture every request the page made into a
  // HAR file, then later replay with `open_session({hars:[file]})` so XHR/fetch
  // are served from the archive. Recording sits under capability `action`
  // (writes a file). Replay is wired at `open_session` time (no separate tool).
  //
  // Finalize timing. Playwright writes the HAR file on `context.close()` —
  // there is no public mid-session flush. Both `start_har` (runtime) and
  // `open_session({har})` (creation-time, native) hit the same constraint:
  // the .har on disk is complete after `close_session`. `stop_har` removes
  // the recording route so further requests aren't logged, but the file
  // remains pending until session teardown.

  register(
    "start_har",
    {
      capability: "action",
      batchable: true,
      description:
        'Start recording a HAR on the current session through `context.routeFromHAR(path, {update:true})`. The file is finalized only when the session closes (`close_session`); Playwright has no mid-session flush. Calling it again while recording stops the earlier recorder and adds the new path (every recorded file is rewritten on close). To record from the start of a session, pass `open_session({har})` instead. Bodies are omitted by default (`content:"omit"`); `embed` and `attach` write bodies to disk and need the `network-body` capability (off by default). On close the file is rewritten with `Cookie`, `Set-Cookie` and `Authorization` values emptied (names kept) and registered secrets masked in headers, URLs and text bodies; without `network-body` request bodies are emptied too. Paths are workspace-rooted `.har` files: a path outside the workspace or a `.zip` path is rejected.',
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted .har file path. Default: `<workspace>/har/<session-id>-<ISO>.har`. Rejected if it escapes `$BROWX_WORKSPACE`; a .zip path is refused (use .har).",
          ),
        mode: z
          .enum(["full", "minimal"])
          .optional()
          .describe(
            "`full` (default) records full HAR; `minimal` records only what `routeFromHAR` needs for replay.",
          ),
        content: z
          .enum(["embed", "attach", "omit"])
          .optional()
          .describe(
            "Body persistence: `omit` (default, no bodies), `embed` (inline), `attach` (sidecar files). `embed` and `attach` need the `network-body` capability.",
          ),
        urlFilter: z
          .string()
          .optional()
          .describe("Optional glob/regex URL filter — only matching requests are stored."),
        ...SESSION_ARG,
      },
    },
    async ({ path, mode, content, urlFilter, session }) => {
      const g = gateCheck("start_har");
      if (g) return g;
      // Bodies on disk are response content, the same thing `network_body`
      // returns, so they need the same capability.
      if (harWritesBodies(content)) {
        const bodies = gateCheck(
          "start_har",
          ["network-body"],
          `start_har content "${content}" writes request and response bodies; pass content:"omit" or enable network-body`,
        );
        if (bodies) return bodies;
      }
      try {
        const e = await entryFor(session);
        const c = await confirmByobAction("start_har", confirmCtxFor(e));
        if (!c.ok) return denyContent("start_har", c);
        const r = await withDeadline(
          startHar(requirePage(e.session).context(), e.har, workspace.root, e.id, {
            path,
            mode,
            content,
            urlFilter,
          }),
          cfgActionTimeout(),
          "start_har",
        );
        return okText({
          ok: true,
          session: e.id,
          path: r.path,
          mode: r.mode,
          content: r.content,
          replacedPrior: r.replacedPrior,
          finalizesOn: "close_session",
          hint: "The HAR file is written to disk when the session closes (Playwright constraint). Call `close_session` to finalize; until then the file at `path` may be absent or incomplete. Re-call `start_har` to swap targets; `stop_har` removes the recording route.",
        });
      } catch (err) {
        return errText("start_har", err);
      }
    },
  );

  register(
    "stop_har",
    {
      capability: "action",
      batchable: true,
      description:
        "Stop HAR recording on the current session by removing the recording route, so later requests are not logged. The file is finalized only when the session closes (`close_session`). Returns the reserved path; an inline `har` field appears only when the file already exists and is under about 256 KB, which usually means the context was reopened on the same path, so read the file after `close_session`. To record again in the same session, call `start_har` with a fresh path.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("stop_har");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const r = await withDeadline(
          stopHar(requirePage(e.session).context(), e.har),
          cfgActionTimeout(),
          "stop_har",
        );
        // Best-effort inline: only succeeds when the file already exists AND
        // is under the cap. On the routeFromHAR(update:true) path that's
        // typically not until close_session — surface the path either way so
        // the caller can pick it up post-teardown.
        const inline = r.path ? readHarIfSmall(r.path, HAR_INLINE_CAP_BYTES) : undefined;
        return okText({
          ok: true,
          session: e.id,
          wasActive: r.wasActive,
          ...(r.path ? { path: r.path } : {}),
          finalized: r.finalized,
          nativeRecord: r.nativeRecord,
          ...(inline !== undefined
            ? { har: inline, inlineBytes: Buffer.byteLength(inline, "utf8") }
            : {}),
          hint: r.nativeRecord
            ? "HAR was wired at session creation via `open_session({har})` — the native `recordHar` primitive can't be toggled off mid-session. The file will be written when `close_session` runs."
            : r.wasActive
              ? "Recording route removed. The .har file is finalized when `close_session` runs (Playwright constraint). To re-record in this session: call `start_har` again with a new `path`."
              : "No HAR recorder was active.",
        });
      } catch (err) {
        return errText("stop_har", err);
      }
    },
  );

  // ---- Session video recording ----------------------------------------------
  //
  // Playwright's `recordVideo` is a context-creation primitive — there is no
  // public runtime start. Mirror of the native `recordHar` path: the recorder
  // is wired by `open_session({recordVideo})` and finalized on context.close
  // (which `close_session` triggers). `stop_video` signals intent — it
  // surfaces the constraint instead of pretending to flush mid-context.
  // `get_video` reads the finalized .webm. Both gated by `file-io`.

  register(
    "stop_video",
    {
      capability: "file-io",
      batchable: true,
      description:
        "Mark the session's video recording to be finalized. The .webm is written only when the session closes (`close_session`); Playwright has no mid-session flush, so this sets `pendingFinalize:true` and returns the reserved target path. After `close_session`, read the file with `get_video`. Returns a structured error if no recorder is active (`recordVideo` was not passed to `open_session`). Requires the `file-io` capability (off by default).",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("stop_video");
      if (g) return g;
      try {
        const e = await entryFor(session);
        if (e.mode === "attached") {
          return errText(
            "stop_video",
            new Error(
              "stop_video: not supported on attached sessions. recordVideo is applied when a " +
                "browser context is created, and browxai does not create the context for " +
                'your own Chrome. Open a session with {mode:"persistent"} or ' +
                '{mode:"incognito"} and {recordVideo:{...}}, then run it again.',
            ),
          );
        }
        if (!e.video.active) {
          return errText(
            "stop_video",
            new Error(
              "stop_video: no video recorder is active on this session. Recording can only " +
                "be set up when the session opens: use `open_session({recordVideo:{...}})`.",
            ),
          );
        }
        const r = stopVideo(e.video);
        return okText({
          ok: true,
          session: e.id,
          wasActive: r.wasActive,
          ...(r.targetPath ? { path: r.targetPath } : {}),
          pendingFinalize: r.pendingFinalize,
          finalized: r.finalized,
          finalizesOn: "close_session",
          hint: "Playwright finalizes the .webm only when the context closes. Call `close_session` to flush; then `get_video` to read the file. There is no mid-context flush on the native recordVideo primitive — same constraint shape as `open_session({har})`.",
        });
      } catch (err) {
        return errText("stop_video", err);
      }
    },
  );

  register(
    "get_video",
    {
      capability: "file-io",
      batchable: true,
      description:
        'Read the session\'s recorded video. The .webm exists only after `close_session`; an earlier call returns a structured error saying so. `format:"path"` (default) returns the absolute path and size. `format:"bytes"` also inlines the file as base64 when it is under about 1 MiB; larger files return the path with `tooLargeToInline:true`, so read them from disk. Returns a structured error if the session had no `recordVideo`. Requires the `file-io` capability (off by default).',
      inputSchema: {
        format: z
          .enum(["path", "bytes"])
          .optional()
          .describe(
            "`path` (default) returns absolute path + size. `bytes` additionally inlines the file as base64 when under ~1 MiB.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ format, session }) => {
      const g = gateCheck("get_video");
      if (g) return g;
      try {
        const e = await entryFor(session);
        if (e.mode === "attached") {
          return errText(
            "get_video",
            new Error(
              "get_video: not supported on attached sessions, which cannot record video. " +
                'Open a session with {mode:"persistent"} or {mode:"incognito"} and ' +
                "{recordVideo:{...}} to record.",
            ),
          );
        }
        if (!e.video.active || !e.video.targetPath) {
          return errText(
            "get_video",
            new Error(
              "get_video: no video recorder is active on this session. Recording can only " +
                "be set up when the session opens: use `open_session({recordVideo:{...}})`.",
            ),
          );
        }
        const r = readVideoIfReady(e.video.targetPath, format ?? "path", VIDEO_INLINE_CAP_BYTES);
        if (!r.exists) {
          return errText(
            "get_video",
            new Error(
              `get_video: the .webm is not yet on disk at "${e.video.targetPath}". ` +
                "Playwright finalizes recordVideo only when the context closes. " +
                "Call `close_session` to flush, then re-call `get_video`.",
            ),
          );
        }
        return okText({
          ok: true,
          session: e.id,
          path: r.path,
          bytes: r.bytes ?? 0,
          format: format ?? "path",
          ...(r.inlineBase64 !== undefined ? { videoBase64: r.inlineBase64 } : {}),
          ...(r.tooLargeToInline ? { tooLargeToInline: true } : {}),
          hint:
            r.inlineBase64 !== undefined
              ? "Video bytes inlined as base64 (under the 1 MiB inline cap). Decode and pipe to a .webm consumer."
              : r.tooLargeToInline
                ? "Video exceeds the 1 MiB inline cap. Read it off disk at `path`."
                : 'Video on disk. Read it at `path`, or re-call with `format:"bytes"` for inline base64 (under-cap files only).',
        });
      } catch (err) {
        return errText("get_video", err);
      }
    },
  );
}
