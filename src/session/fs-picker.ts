// Per-session File System Access API policy. Sibling of `dialog_policy` /
// `permission_policy`. Plugs the FS-picker blind spot: modern web editors
// (VSCode for the web, Figma, anything calling `showOpenFilePicker` /
// `showSaveFilePicker` / `showDirectoryPicker`) deadlock under a headless
// session — the picker dialog blocks every subsequent browser event until
// the human clicks a real OS file chooser that doesn't exist in headless,
// and even on attached Chrome the human can't see the picker through the
// agent's session.
//
// Policy modes (mirror `permission_policy`):
//   - "allow"     — the agent provides files server-side via `fs_picker_respond`;
//                   the init-script stub returns synthetic FileSystem*Handle
//                   objects to the page. For showSaveFilePicker, the agent
//                   supplies a workspace-rooted destination path and writes
//                   from `createWritable()` are persisted there.
//   - "deny"      — the stub throws `NotAllowedError` ("user dismissed the
//                   picker"). The page sees the standard rejection path.
//   - "raise"     — DEFAULT (deterministic anti-deadlock). Stub throws
//                   `NotAllowedError` AND records the request as
//                   `handledAs:"raised"`. The next ActionResult flips
//                   `ok:false` with a stable hint pointing at
//                   `set_fs_picker_policy`. The page never blocks (the
//                   picker rejects immediately), but a picker call never
//                   silently changes app state under an unaware caller
//                   either.
//   - "ask-human" — server records the request, blocks on the bridge
//                   (`await_human({kind:"input"})` mechanism), then either
//                   resolves with agent-provided files or denies per the
//                   human's response.
//
// Per-API override map. The top-level `mode` is the default; the per-API
// map (`perAPI: { showSaveFilePicker: "allow", … }`) overrides it for a
// specific picker. Mirrors `permission_policy.perPermission`.
//
// Per-action capture. Every page-side picker call is appended to a buffer
// with a timestamp. `since(ts)` slices for the action window — same pattern
// as `dialog_policy` / `permission_policy`; `raisedSince(ts)` drives the
// `ok:false` flip.
//
// Why one layer (init-script stubs) instead of two (CDP + init-script):
//   - There is no CDP analogue for the File System Access API — Chromium
//     exposes the picker UX only via the real OS file chooser, which
//     headless can't drive and which (on attached Chrome) wouldn't route
//     through the agent. The init-script stub IS the policy enforcement
//     point. The native `window.show*FilePicker` is replaced before any
//     page script runs, so the original is never called.
//
// FileSystemFileHandle.createWritable() handling:
//   - In `allow` mode for `showSaveFilePicker`, the agent supplies a
//     workspace-rooted `path` via `fs_picker_respond`. The init-script
//     stub returns a synthetic `FileSystemFileHandle` whose
//     `createWritable()` returns a stub `FileSystemWritableFileStream`
//     that routes every `write(chunk)` / `truncate()` / `close()` /
//     `abort()` through a server-side binding (`__browx_fs_picker_write`),
//     which append-writes to the workspace path. Workspace-escape on the
//     path is rejected at `fs_picker_respond` time (the agent never
//     supplies a path to the page-side stub directly).
//   - In `allow` mode for `showOpenFilePicker`, the agent supplies either
//     inline `{contents, name}` (base64 file bytes the page reads back
//     via `getFile()`) or a workspace-rooted `{path}` (server reads the
//     file once at respond time and inlines the bytes). The handle's
//     `createWritable()` returns a no-op stub — open-pickers are
//     read-side; the agent didn't supply a destination.
//   - `showDirectoryPicker` returns a minimal directory handle: `.name`
//     is the basename of the agent-supplied path (or "browxai-virtual"
//     when synthetic); `entries()` / `values()` / `keys()` iterate empty.
//     Best-effort by construction — a real directory tree would require
//     either reading the workspace path recursively (heavy + a footgun
//     when the workspace holds artefacts the page shouldn't see) or
//     synthesising one from agent input (complex). MVP scope is "the
//     picker dialog doesn't deadlock and the page can check that it got
//     a directory" — most modern editors will then re-prompt for
//     individual files.

import type { BrowserContext } from "playwright-core";
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, sep, basename } from "node:path";
import { log } from "../util/logging.js";

export type FsPickerMode = "allow" | "deny" | "raise" | "ask-human";

/** The three File System Access API entry points browxai governs. v1 set.
 *  Re-exported in `fs_picker_policy` tool docs + tool-reference.md. */
export const SUPPORTED_FS_PICKER_APIS = [
  "showOpenFilePicker",
  "showSaveFilePicker",
  "showDirectoryPicker",
] as const;
export type FsPickerApi = (typeof SUPPORTED_FS_PICKER_APIS)[number];

/** Public, runtime-mutable policy shape. Top-level `mode` is the default;
 *  the per-API map wins when present. */
export interface FsPickerPolicy {
  mode: FsPickerMode;
  perAPI?: Partial<Record<FsPickerApi, FsPickerMode>>;
}

/** Agent-supplied file payload for `fs_picker_respond`. Either inline
 *  `{contents, name}` (base64 bytes the page reads via `getFile()`; for
 *  save-pickers the page writes nowhere) or a workspace-rooted `{path}`
 *  (for open-pickers: bytes are read once at respond-time; for save-pickers:
 *  the destination for `createWritable()`-driven writes; for directory-
 *  pickers: the dir name surfaces as `.name` and the rest is a stub). */
export interface FsPickerFile {
  /** Workspace-rooted file (or dir) path. Mutually exclusive with `contents`. */
  path?: string;
  /** base64 file content. Mutually exclusive with `path`. Pass `name` to set
   *  the filename the page sees. Read-only on the page side (the page can
   *  call `getFile()` to obtain a `File`; `createWritable()` is a no-op stub). */
  contents?: string;
  /** Filename presented to the page when `contents` is used. Default
   *  `"browxai-virtual"`. Ignored when `path` is used (basename of `path`
   *  is taken). */
  name?: string;
  /** MIME type for the synthetic `File` exposed to the page. Default
   *  `"application/octet-stream"`. */
  mimeType?: string;
}

/** One captured picker call, exposed on `ActionResult.fsPickerRequests[]`. */
export interface FsPickerRecord {
  api: FsPickerApi;
  /** `suggestedName` from `showSaveFilePicker` options (undefined for open /
   *  directory). Captured so the agent can see what filename the page
   *  proposed. */
  suggestedName?: string;
  /** What the server actually did. `"raised"` means the stub threw AND
   *  the policy was `raise`, so the action will be marked failed. */
  handledAs: "allowed" | "denied" | "raised" | "asked-human";
  /** epoch ms — used by the action-window slice. */
  ts: number;
}

/** Hint emitted on `ActionResult.failure.hint` when `raise` mode fired.
 *  Stable, agent-facing string — referenced in docs/tool-reference.md. */
export const UNHANDLED_FS_PICKER_HINT =
  "unhandled File System Access picker — set fsPickerPolicy (open_session/set_fs_picker_policy) " +
  'to "allow", "deny", or "ask-human" before driving an action that may trigger one. ' +
  "The picker was rejected page-side (NotAllowedError) so the page is not deadlocked, but " +
  "the app effect is the user-dismissed branch. In `allow` mode, supply the file(s) with " +
  "`fs_picker_respond` before (or in parallel with) the action that triggers the picker.";

/** Mutable per-session state. The page-side stubs read `current(api)` on
 *  every call, so a `set_fs_picker_policy` call takes effect on the very
 *  next picker without page reload. */
export class FsPickerPolicyState {
  private policy: FsPickerPolicy;
  private buffer: FsPickerRecord[] = [];
  /** Per-API response queue. `fs_picker_respond` pushes; the binding
   *  dequeues on the next matching picker call. Per-API so a queued
   *  open-file response doesn't satisfy a save-file picker (different
   *  semantics, different agent intent). */
  private responses: Record<FsPickerApi, FsPickerFile[][]> = {
    showOpenFilePicker: [],
    showSaveFilePicker: [],
    showDirectoryPicker: [],
  };
  /** Hard cap so a chatty page can't grow this without bound. The per-action
   *  slice is the only consumer — older records are noise. */
  private readonly cap: number;
  /** Contexts we've already installed the init-script + binding on.
   *  Idempotent install guard — BYOB reconnect / context rebuild MUST not
   *  double-wire. */
  private wired = new WeakSet<BrowserContext>();

  constructor(initial: FsPickerPolicy = { mode: "raise" }, cap = 200) {
    this.policy = normalise(initial);
    this.cap = cap;
  }

  /** Resolved policy snapshot. */
  current(): FsPickerPolicy {
    return {
      mode: this.policy.mode,
      ...(this.policy.perAPI ? { perAPI: { ...this.policy.perAPI } } : {}),
    };
  }

  /** Effective mode for one API — per-API map wins, else top-level. */
  modeFor(api: FsPickerApi): FsPickerMode {
    return this.policy.perAPI?.[api] ?? this.policy.mode;
  }

  set(next: FsPickerPolicy): FsPickerPolicy {
    this.policy = normalise(next);
    return this.current();
  }

  /** Append a request record. Caps the buffer at `cap`. */
  record(rec: FsPickerRecord): void {
    this.buffer.push(rec);
    if (this.buffer.length > this.cap) this.buffer.shift();
  }

  /** Slice records with `ts >= since`. Used by the action-window. */
  since(since: number): FsPickerRecord[] {
    return this.buffer.filter((r) => r.ts >= since);
  }

  /** True if any record in `[since, now]` was handled in `raise` mode.
   *  When true, the action-window flips the result to `ok:false`. */
  raisedSince(since: number): boolean {
    return this.buffer.some((r) => r.ts >= since && r.handledAs === "raised");
  }

  /** Queue an agent-supplied response for the next picker of `api`.
   *  Pushed by `fs_picker_respond`; consumed by the binding on the next
   *  matching call. */
  pushResponse(api: FsPickerApi, files: FsPickerFile[]): void {
    this.responses[api].push(files);
  }

  /** Dequeue the next agent-supplied response for `api`. Returns
   *  `undefined` when the queue is empty (the binding falls back to a
   *  best-effort empty file list so the page still gets a usable
   *  shape — not deadlocking is the contract). */
  dequeueResponse(api: FsPickerApi): FsPickerFile[] | undefined {
    return this.responses[api].shift();
  }

  /** Has this context already been wired? Idempotent install guard. */
  hasContext(c: BrowserContext): boolean {
    return this.wired.has(c);
  }
  /** Mark a context as wired. */
  markContext(c: BrowserContext): void {
    this.wired.add(c);
  }
}

/** Idempotent normaliser. Rejects unknown top-level modes; per-API map is
 *  validated per-entry (an unknown API name in the map throws so the caller
 *  gets a fast error instead of silent fallthrough). */
function normalise(p: FsPickerPolicy): FsPickerPolicy {
  if (!isFsPickerMode(p.mode)) {
    throw new Error(
      `fsPickerPolicy: invalid mode "${String(p.mode)}" — expected "allow" | "deny" | "raise" | "ask-human"`,
    );
  }
  if (p.perAPI) {
    const cleaned: Partial<Record<FsPickerApi, FsPickerMode>> = {};
    for (const [name, mode] of Object.entries(p.perAPI)) {
      if (!SUPPORTED_FS_PICKER_APIS.includes(name as FsPickerApi)) {
        throw new Error(
          `fsPickerPolicy.perAPI: unknown API "${name}" — supported: ${SUPPORTED_FS_PICKER_APIS.join(", ")}`,
        );
      }
      if (mode === undefined) continue;
      if (!isFsPickerMode(mode)) {
        throw new Error(
          `fsPickerPolicy.perAPI["${name}"]: invalid mode "${String(mode)}" — expected "allow" | "deny" | "raise" | "ask-human"`,
        );
      }
      cleaned[name as FsPickerApi] = mode;
    }
    return { mode: p.mode, perAPI: cleaned };
  }
  return { mode: p.mode };
}

function isFsPickerMode(m: unknown): m is FsPickerMode {
  return m === "allow" || m === "deny" || m === "raise" || m === "ask-human";
}

/** Parse the spec's compact string form for the top-level mode, or accept
 *  the object form. Idempotent. */
export function parseFsPickerPolicyArg(v: string | FsPickerPolicy | undefined): FsPickerPolicy {
  if (!v) return { mode: "raise" };
  if (typeof v === "object") return normalise(v);
  if (isFsPickerMode(v)) return { mode: v };
  throw new Error(
    `fsPickerPolicy: invalid value "${v}" — expected "allow" | "deny" | "raise" | "ask-human"`,
  );
}

/** Resolve + validate a workspace-rooted file path. Mirrors the workspace-
 *  escape rejection in `src/page/upload.ts`. Exported for tests; used by
 *  the binding install + by `fs_picker_respond`. */
export function resolveWorkspaceFsPath(workspaceRoot: string, path: string): string {
  const resolved = resolve(workspaceRoot, path);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + sep)) {
    throw new Error(
      "fs_picker_respond: `path` must resolve inside $BROWX_WORKSPACE — stage the file there, or use `contents` (base64)",
    );
  }
  return resolved;
}

/** Bridge callback type for `ask-human` mode. The server-side binding wires
 *  this to await-human; the page-side stub consults it before deciding
 *  whether to call through. Returns either the agent-supplied file list (the
 *  human approved + the agent staged a response) or `null` (denied). */
export type FsPickerAskHandler = (
  api: FsPickerApi,
  suggestedName: string | undefined,
) => Promise<FsPickerFile[] | null>;

/** Init script that replaces the page-side File System Access entry points
 *  with stubs that route through the per-session policy. Stringified so it
 *  can be passed to `addInitScript` and `page.evaluate`. Keep browser-only
 *  JS — no TS-only syntax. Re-injected on `framenavigated` (idempotent:
 *  guards on `window.__browx_fs_picker_installed`).
 *
 *  The stubs consult `window.__browx_fs_picker_check({api, suggestedName})`
 *  (an exposeBinding callable from page context) — it returns one of:
 *    - `{decision:"allow", files:[{handleId, name, mimeType, contents?}]}`:
 *      the agent staged file(s); the stub builds synthetic
 *      `FileSystemFileHandle` / `FileSystemDirectoryHandle` objects whose
 *      `getFile()` returns a synthetic `File` and `createWritable()` returns
 *      a synthetic writable stream routed through
 *      `__browx_fs_picker_write({handleId, op, data?})`.
 *    - `{decision:"deny"}`: the stub throws `NotAllowedError`.
 *
 *  Stubs are written to be browser-only JS (no TS-only syntax). The
 *  install guards on `window.__browx_fs_picker_installed`. */
export const FS_PICKER_PAGE_SCRIPT = `(() => {
  if (window.__browx_fs_picker_installed) return;
  window.__browx_fs_picker_installed = true;

  function check(api, suggestedName) {
    try {
      if (typeof window.__browx_fs_picker_check === "function") {
        return Promise.resolve(window.__browx_fs_picker_check(JSON.stringify({
          api: api, suggestedName: suggestedName,
        })));
      }
    } catch (_) {}
    // Binding missing — safe-by-default deny so the page never deadlocks.
    return Promise.resolve(JSON.stringify({ decision: "deny" }));
  }

  function notAllowed(msg) {
    var e = new Error(msg || "The user aborted a request.");
    try { e.name = "NotAllowedError"; } catch (_) {}
    return e;
  }

  function b64ToBytes(b64) {
    try {
      var binary = atob(b64);
      var len = binary.length;
      var bytes = new Uint8Array(len);
      for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch (_) {
      return new Uint8Array(0);
    }
  }

  function syntheticFile(spec) {
    var name = spec.name || "browxai-virtual";
    var mimeType = spec.mimeType || "application/octet-stream";
    var bytes = spec.contents ? b64ToBytes(spec.contents) : new Uint8Array(0);
    try {
      return new File([bytes], name, { type: mimeType });
    } catch (_) {
      // Fallback Blob-shaped object for environments without File (test
      // pages); the constructor is universally available on real browsers.
      var blob = new Blob([bytes], { type: mimeType });
      blob.name = name;
      return blob;
    }
  }

  function syntheticWritable(handleId) {
    // Route every operation through the server-side binding. Each call is
    // ack'd by the binding so we surface back-pressure to a determined page
    // (await stream.write(buf) resolves only after the write hit disk).
    function call(op, data) {
      try {
        if (typeof window.__browx_fs_picker_write === "function") {
          return Promise.resolve(window.__browx_fs_picker_write(JSON.stringify({
            handleId: handleId, op: op, data: data == null ? null : data,
          })));
        }
      } catch (_) {}
      return Promise.resolve(undefined);
    }
    return {
      write: function (data) {
        // Accept BufferSource | Blob | string | { type:"write"|"seek"|"truncate", … }
        if (data == null) return Promise.resolve(undefined);
        if (typeof data === "string") return call("write", data);
        if (data.type === "seek") return call("seek", String(data.position || 0));
        if (data.type === "truncate") return call("truncate", String(data.size || 0));
        if (data.type === "write" && data.data != null) return call("write", encodeForBinding(data.data));
        return call("write", encodeForBinding(data));
      },
      seek: function (position) { return call("seek", String(position || 0)); },
      truncate: function (size) { return call("truncate", String(size || 0)); },
      close: function () { return call("close"); },
      abort: function () { return call("abort"); },
    };
  }

  function encodeForBinding(data) {
    // base64-encode any BufferSource / Blob / string for binding transport.
    // exposeBinding payloads are strings; we wrap as "b64:<base64>" so the
    // server side can distinguish from a literal text write.
    function bytesToB64(bytes) {
      var s = "";
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      try { return "b64:" + btoa(s); } catch (_) { return "b64:"; }
    }
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return bytesToB64(new Uint8Array(data));
    if (ArrayBuffer.isView && ArrayBuffer.isView(data)) {
      return bytesToB64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
    if (data instanceof Blob) {
      // Synchronous-from-page Promise; the binding awaits.
      return data.arrayBuffer().then(function (ab) { return bytesToB64(new Uint8Array(ab)); });
    }
    return String(data);
  }

  function syntheticFileHandle(spec) {
    var handleId = spec.handleId;
    var name = spec.name || "browxai-virtual";
    return {
      kind: "file",
      name: name,
      getFile: function () { return Promise.resolve(syntheticFile(spec)); },
      createWritable: function () { return Promise.resolve(syntheticWritable(handleId)); },
      // Minimal queryPermission / requestPermission — the page often probes
      // before reading. Always "granted" for our virtual handles.
      queryPermission: function () { return Promise.resolve("granted"); },
      requestPermission: function () { return Promise.resolve("granted"); },
      // Comparison helper expected by some libraries.
      isSameEntry: function (other) { return Promise.resolve(other === this); },
    };
  }

  function syntheticDirectoryHandle(spec) {
    var name = spec.name || "browxai-virtual";
    // MVP scope: empty directory. Most editors will fall back to per-file
    // pickers when iteration yields nothing.
    var empty = {
      next: function () { return Promise.resolve({ value: undefined, done: true }); },
      return: function () { return Promise.resolve({ value: undefined, done: true }); },
    };
    var emptyIter = { __asyncIterator__: true };
    emptyIter[Symbol.asyncIterator] = function () { return empty; };
    return {
      kind: "directory",
      name: name,
      entries: function () { return emptyIter; },
      values: function () { return emptyIter; },
      keys: function () { return emptyIter; },
      getFileHandle: function () { return Promise.reject(notAllowed("Not found in virtual directory")); },
      getDirectoryHandle: function () { return Promise.reject(notAllowed("Not found in virtual directory")); },
      removeEntry: function () { return Promise.resolve(undefined); },
      resolve: function () { return Promise.resolve(null); },
      queryPermission: function () { return Promise.resolve("granted"); },
      requestPermission: function () { return Promise.resolve("granted"); },
      isSameEntry: function (other) { return Promise.resolve(other === this); },
      [Symbol.asyncIterator]: function () { return empty; },
    };
  }

  function installStub(apiName, isDirectory, isMulti) {
    Object.defineProperty(window, apiName, {
      configurable: true,
      writable: true,
      value: function (options) {
        var suggestedName = options && options.suggestedName ? String(options.suggestedName) : undefined;
        return check(apiName, suggestedName).then(function (raw) {
          var resp;
          try { resp = typeof raw === "string" ? JSON.parse(raw) : (raw || {}); } catch (_) { resp = { decision: "deny" }; }
          if (resp.decision !== "allow") {
            throw notAllowed("The user aborted a " + apiName + " request.");
          }
          var files = Array.isArray(resp.files) ? resp.files : [];
          if (isDirectory) {
            var dirSpec = files[0] || { handleId: resp.handleIdFallback || "dir-0", name: "browxai-virtual" };
            return syntheticDirectoryHandle(dirSpec);
          }
          if (isMulti) {
            return files.map(function (f) { return syntheticFileHandle(f); });
          }
          var spec = files[0] || { handleId: resp.handleIdFallback || "file-0", name: "browxai-virtual" };
          return syntheticFileHandle(spec);
        });
      },
    });
  }

  // showOpenFilePicker: returns Array<FileSystemFileHandle> (multi by default).
  installStub("showOpenFilePicker", false, true);
  // showSaveFilePicker: returns FileSystemFileHandle (single).
  installStub("showSaveFilePicker", false, false);
  // showDirectoryPicker: returns FileSystemDirectoryHandle (single).
  installStub("showDirectoryPicker", true, false);
})();`;

/** Server-side handle-id → writable-target map. Lives per
 *  `attachFsPickerPolicy` install so multiple sessions don't collide.
 *  `target` is the absolute workspace path the writes go to; `truncated`
 *  flips after the first chunk so subsequent writes append rather than
 *  retruncating. `closed` short-circuits further ops. */
interface WritableTarget {
  api: FsPickerApi;
  /** Absolute workspace path, or null when the agent supplied `contents`
   *  (open-picker read-side only — writes are dropped with a warning). */
  path: string | null;
  truncated: boolean;
  closed: boolean;
  bytesWritten: number;
}

/** Server-side wire-up. Installs:
 *   - `__browx_fs_picker_check` exposeBinding: synchronous-from-page consult
 *     that records the request, dequeues an agent-staged response when the
 *     policy is `allow` (or routes ask-human via `askHandler`), and returns
 *     `{decision, files?}`. Files carry a `handleId` the page-side stub
 *     uses to route subsequent `createWritable()` ops back to the right
 *     target.
 *   - `__browx_fs_picker_write` exposeBinding: target of every
 *     `createWritable()`-driven write. Writes append-mode to the
 *     workspace-rooted path the agent supplied. `close` / `abort` clean
 *     up the per-handle target.
 *   - The page-side init script (see above), re-injected by Playwright on
 *     every new document.
 *
 * Idempotent on the same context. Errors during install are logged and
 * swallowed — the page-side stub falls back to safe-by-default deny when
 * the binding is missing, so the page still doesn't deadlock.
 */
export async function attachFsPickerPolicy(
  context: BrowserContext,
  state: FsPickerPolicyState,
  workspaceRoot: string,
  askHandler: FsPickerAskHandler,
): Promise<void> {
  if (state.hasContext(context)) return;
  state.markContext(context);

  // Per-context handle map. Each `allow`-mode response mints a fresh
  // handle id; the page stub round-trips it on every write op so we
  // route writes to the right target file.
  const handles = new Map<string, WritableTarget>();
  let handleCounter = 0;

  try {
    await context.exposeBinding("__browx_fs_picker_check", async (_source, payload: string) => {
      try {
        const o = JSON.parse(payload) as { api?: string; suggestedName?: string };
        const api = o.api as FsPickerApi;
        if (!SUPPORTED_FS_PICKER_APIS.includes(api)) {
          // Unknown API — safe-by-default deny.
          return JSON.stringify({ decision: "deny" });
        }
        const suggestedName = o.suggestedName;
        const mode = state.modeFor(api);
        const ts = Date.now();
        const baseRec: Omit<FsPickerRecord, "handledAs"> = {
          api,
          ts,
          ...(suggestedName ? { suggestedName } : {}),
        };
        switch (mode) {
          case "allow": {
            const files = state.dequeueResponse(api) ?? [];
            const prepared = prepareAllowResponse(
              api,
              files,
              workspaceRoot,
              handles,
              () => `h${++handleCounter}`,
            );
            state.record({ ...baseRec, handledAs: "allowed" });
            return JSON.stringify({ decision: "allow", files: prepared });
          }
          case "deny": {
            state.record({ ...baseRec, handledAs: "denied" });
            return JSON.stringify({ decision: "deny" });
          }
          case "ask-human": {
            const askResult = await askHandler(api, suggestedName).catch(() => null);
            state.record({ ...baseRec, handledAs: "asked-human" });
            if (!askResult) return JSON.stringify({ decision: "deny" });
            const prepared = prepareAllowResponse(
              api,
              askResult,
              workspaceRoot,
              handles,
              () => `h${++handleCounter}`,
            );
            return JSON.stringify({ decision: "allow", files: prepared });
          }
          case "raise":
          default: {
            state.record({ ...baseRec, handledAs: "raised" });
            return JSON.stringify({ decision: "deny" });
          }
        }
      } catch (err) {
        log.warn("session.fs-picker: check handler error", {
          error: err instanceof Error ? err.message : String(err),
        });
        return JSON.stringify({ decision: "deny" });
      }
    });

    await context.exposeBinding("__browx_fs_picker_write", (_source, payload: string) => {
      try {
        const o = JSON.parse(payload) as { handleId?: string; op?: string; data?: string | null };
        const id = o.handleId;
        const op = o.op;
        if (!id || !op) return undefined;
        const target = handles.get(id);
        if (!target) return undefined;
        if (target.closed && op !== "close" && op !== "abort") return undefined;
        if (target.path === null) {
          // Open-picker read-side; the page is writing back to a virtual
          // handle. Drop on the floor with a one-time warning so the page
          // doesn't see an error mid-flight.
          if (op === "write") {
            log.warn(
              "session.fs-picker: write to a read-only virtual handle dropped — open-picker responses don't carry a writable destination; use showSaveFilePicker for writes",
            );
          }
          if (op === "close" || op === "abort") target.closed = true;
          return undefined;
        }
        // `target.path` was validated against `workspace.root` (workspace-
        // rooted; workspace-escape rejected at fs_picker_respond time via
        // `resolveWorkspaceFsPath(workspaceRoot, …)` — see prepareAllow-
        // Response). Every mutation below routes through this validated
        // path, never cwd.
        const path = target.path;
        switch (op) {
          case "write": {
            const bytes = decodeChunk(o.data);
            // workspace-rooted write — `path` came from workspace.root.
            if (!target.truncated) {
              const dir = dirname(path);
              if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
              writeFileSync(path, bytes);
              target.truncated = true;
            } else {
              // workspace-rooted append — `path` came from workspace.root.
              appendFileSync(path, bytes);
            }
            target.bytesWritten += bytes.length;
            return undefined;
          }
          case "truncate": {
            // Best-effort: rewrite empty up to the requested size.
            // workspace-rooted write — `path` came from workspace.root.
            const size = Number(o.data ?? 0);
            const dir = dirname(path);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(path, Buffer.alloc(Math.max(0, size)));
            target.truncated = true;
            target.bytesWritten = Math.max(0, size);
            return undefined;
          }
          case "seek": {
            // No-op in MVP: Node fs has no native seek-and-overwrite for
            // append-mode; would need fd APIs. Most save-picker flows do
            // a single write+close sequence, so seek is rare.
            return undefined;
          }
          case "close": {
            target.closed = true;
            // If the page never wrote anything, ensure an empty file
            // exists so callers see a deterministic artefact.
            // workspace-rooted write — `path` came from workspace.root.
            if (!target.truncated) {
              const dir = dirname(path);
              if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
              writeFileSync(path, Buffer.alloc(0));
              target.truncated = true;
            }
            return undefined;
          }
          case "abort": {
            target.closed = true;
            return undefined;
          }
          default:
            return undefined;
        }
      } catch (err) {
        log.warn("session.fs-picker: write handler error", {
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    });
  } catch (err) {
    log.warn("session.fs-picker: exposeBinding install failed; page-side stub falls back to deny", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await context.addInitScript({ content: FS_PICKER_PAGE_SCRIPT });
    for (const page of context.pages()) {
      await page.evaluate(FS_PICKER_PAGE_SCRIPT).catch(() => undefined);
    }
  } catch (err) {
    log.warn("session.fs-picker: addInitScript failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Build the page-side response shape for an `allow` / `ask-human` decision.
 *  Each file gets a fresh handleId; save-picker `path` entries register a
 *  write target so subsequent `createWritable()` writes land in the
 *  workspace. Workspace-escape on `path` is rejected here (the agent's
 *  response is the only place a path enters the system; `fs_picker_respond`
 *  is the validation gate). */
function prepareAllowResponse(
  api: FsPickerApi,
  files: FsPickerFile[],
  workspaceRoot: string,
  handles: Map<string, WritableTarget>,
  nextId: () => string,
): Array<{ handleId: string; name: string; mimeType: string; contents?: string }> {
  // Directory picker: agent supplies (at most) one entry; we honour the
  // basename of `path` as `.name` if supplied.
  if (api === "showDirectoryPicker") {
    const entry = files[0];
    const handleId = nextId();
    const path =
      entry?.path !== undefined ? resolveWorkspaceFsPath(workspaceRoot, entry.path) : null;
    const name = path ? basename(path) : (entry?.name ?? "browxai-virtual");
    handles.set(handleId, {
      api,
      path: null, // directory handle: writes go to per-file children, not the dir itself
      truncated: false,
      closed: false,
      bytesWritten: 0,
    });
    return [{ handleId, name, mimeType: "" }];
  }

  // showSaveFilePicker is single-file; showOpenFilePicker is multi.
  const slice = api === "showSaveFilePicker" ? files.slice(0, 1) : files;
  // Empty-list edge: still hand back ONE virtual file so the page's
  // promise resolves with a usable shape instead of an empty array
  // (the spec says showSaveFilePicker returns a single handle; an empty
  // result would force a downstream NPE on most page code).
  const effective = slice.length > 0 ? slice : [{ name: "browxai-virtual" }];
  return effective.map((f) => {
    const handleId = nextId();
    let path: string | null = null;
    let name = f.name ?? "browxai-virtual";
    if (f.path !== undefined) {
      path = resolveWorkspaceFsPath(workspaceRoot, f.path);
      name = basename(path);
    }
    const target: WritableTarget = {
      api,
      path: api === "showSaveFilePicker" ? path : null,
      truncated: false,
      closed: false,
      bytesWritten: 0,
    };
    handles.set(handleId, target);
    const out: { handleId: string; name: string; mimeType: string; contents?: string } = {
      handleId,
      name,
      mimeType: f.mimeType ?? "application/octet-stream",
    };
    if (f.contents !== undefined) out.contents = f.contents;
    return out;
  });
}

/** Decode a page-side write payload. Either `"b64:<base64>"` for binary
 *  data or a literal string for text writes. Returns a Buffer. */
function decodeChunk(raw: string | null | undefined): Buffer {
  if (raw === null || raw === undefined) return Buffer.alloc(0);
  if (raw.startsWith("b64:")) return Buffer.from(raw.slice("b64:".length), "base64");
  return Buffer.from(raw, "utf8");
}
