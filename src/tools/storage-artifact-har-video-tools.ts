import { withDeadline } from "../util/deadline.js";
import { confirmByobAction } from "../policy/confirm.js";
import { startHar, stopHar, readHarIfSmall, HAR_INLINE_CAP_BYTES } from "../page/har.js";
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
        'Save a session-scoped artifact (string or binary) into the session\'s workspace-rooted KV. The artifact lives at `$BROWX_WORKSPACE/.artifacts/<sessionId>/<name>`. `name` must be letters / digits / `._-` only (no path separators, no `..`, no leading dot — workspace-escape rejected). `content` is text by default (`encoding:"utf8"`); pass `encoding:"base64"` for binary payloads. Overwrites an existing artifact with the same name. The session\'s KV is capacity-bounded at 200 entries / 50 MiB — past either cap the OLDEST-write entry is evicted to make room. Cleared on `close_session` — artifacts don\'t survive teardown. Retrieve with `artifact_get({name})`; enumerate with `artifact_list()`. → `{ ok, name, size, mtime, path }`. Capability `action`.',
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
        "Read back a previously-saved session artifact. `name` matches the value passed to `artifact_save`. `encoding` controls the return shape — `utf8` (default) returns the bytes as text; `base64` returns them base64-encoded (round-trip-faithful for binary payloads). Throws if the name is unknown in this session. → `{ ok, name, content, size, mtime, encoding }`. Capability `read`.",
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
        "Enumerate every artifact in this session's KV (sorted by name asc). Read-only. → `{ ok, count, artifacts: [{ name, size, mtime }] }`. Per-session, capacity-bounded (200 entries / 50 MiB); cleared on `close_session`. Capability `read`.",
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
        "Begin HAR recording on the current session via `context.routeFromHAR(path, {update:true})`. From the next request onward every page network event is captured into a HAR archive. **The file on disk is finalized when the session closes** (`close_session`) — Playwright provides no mid-session flush. Re-calling `start_har` while a recorder is already active transparently stops the prior one and swaps targets. For up-front recording across the whole session prefer the additive `open_session({har:{...}})` schema (Playwright's blessed native primitive — same finalize-on-close caveat). Capability `action`. Workspace-rooted paths only; traversal rejected.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted .har file path. Default: `<workspace>/har/<session-id>-<ISO>.har`. Rejected if it escapes `$BROWX_WORKSPACE`.",
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
            "Body persistence: `embed` (default, inline), `attach` (sidecar files / .zip entries), `omit` (drop bodies).",
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
      try {
        const e = await entryFor(session);
        const c = await confirmByobAction("start_har", confirmCtxFor(e));
        if (!c.ok) return denyContent("start_har", c);
        const r = await withDeadline(
          startHar(e.session.page().context(), e.har, workspace.root, e.id, {
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
        "Stop HAR recording on the current session. Removes the recording route so further requests aren't logged. **The HAR file is finalized only when the session closes** (`close_session`) — there is no mid-session flush on Playwright's native HAR pipeline. Returns the reserved path; if the file already exists on disk and is under ~256 KB, an inline `har` field is also returned (only happens once the context has actually been closed and re-opened with the same path; usually you'll just read the file after `close_session`). Re-recording within the same session: stop_har, then start_har again with a fresh path. Capability `action`.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("stop_har");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const r = await withDeadline(
          stopHar(e.session.page().context(), e.har),
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
        "Signal that the session's video recording should be finalized. Mirrors the `stop_har` native-record posture: **the .webm is written to disk only when the session closes** (`close_session`) — Playwright provides no mid-context flush on the `recordVideo` primitive. This call marks the recorder as `pendingFinalize:true` and returns the reserved target path; the actual file appears on disk after `close_session`. Use `get_video` afterwards to retrieve the bytes or absolute path. Returns a structured error if no video recorder is active (you didn't pass `recordVideo` to `open_session`). Capability `file-io`.",
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
              "stop_video: not supported on attached / BYOB sessions — recordVideo is " +
                "a context-creation primitive and we don't wire it on the consumer's " +
                'Chrome (not-owned). Open a managed session ({mode:"persistent"} or ' +
                '{mode:"incognito"}) with {recordVideo:{...}} and re-run.',
            ),
          );
        }
        if (!e.video.active) {
          return errText(
            "stop_video",
            new Error(
              "stop_video: no video recorder is active on this session. Video must be " +
                "wired at session creation via `open_session({recordVideo:{...}})` — " +
                "Playwright doesn't expose a runtime `start_video` primitive.",
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
        'Read the session\'s recorded video. **The .webm is written only after `close_session`** — calling `get_video` before then returns a structured error pointing at the close requirement. `format:"path"` (default) returns the absolute path + on-disk size. `format:"bytes"` additionally inlines the file as base64 when under ~1 MiB; larger files return path + `tooLargeToInline:true` so the caller reads them off disk. Returns a structured error if no recorder was wired (no `recordVideo` on `open_session`). Capability `file-io`.',
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
              "get_video: not supported on attached / BYOB sessions — recordVideo is " +
                "a context-creation primitive and was refused at session-open time on " +
                "this session. Open a managed session with {recordVideo:{...}} to record.",
            ),
          );
        }
        if (!e.video.active || !e.video.targetPath) {
          return errText(
            "get_video",
            new Error(
              "get_video: no video recorder is active on this session. Video must be " +
                "wired at session creation via `open_session({recordVideo:{...}})`.",
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
