// Node-side File System Access policy state. Realm 1 of the fs-picker split
// (policy/state) — sibling realms are `fs-picker-page-script` (the browser-only
// init-script string) and `fs-picker-attach` (the Playwright binding adapter).
// Re-exported by the `fs-picker` barrel.
//
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

import type { BrowserContext } from "playwright-core";
import { resolve, sep } from "node:path";
import { PolicyRecordBuffer } from "./policy-buffer.js";

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
  /** Bounded record ring (shared `PolicyRecordBuffer` — the hard cap so a chatty
   *  page can't grow this without bound; the per-action slice is the only
   *  consumer, older records are noise). */
  private readonly records: PolicyRecordBuffer<FsPickerRecord>;
  /** Per-API response queue. `fs_picker_respond` pushes; the binding
   *  dequeues on the next matching picker call. Per-API so a queued
   *  open-file response doesn't satisfy a save-file picker (different
   *  semantics, different agent intent). */
  private responses: Record<FsPickerApi, FsPickerFile[][]> = {
    showOpenFilePicker: [],
    showSaveFilePicker: [],
    showDirectoryPicker: [],
  };
  /** Contexts we've already installed the init-script + binding on.
   *  Idempotent install guard — BYOB reconnect / context rebuild MUST not
   *  double-wire. */
  private wired = new WeakSet<BrowserContext>();

  constructor(initial: FsPickerPolicy = { mode: "raise" }, cap = 200) {
    this.policy = normalise(initial);
    this.records = new PolicyRecordBuffer<FsPickerRecord>(cap);
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
    this.records.record(rec);
  }

  /** Slice records with `ts >= since`. Used by the action-window. */
  since(since: number): FsPickerRecord[] {
    return this.records.since(since);
  }

  /** True if any record in `[since, now]` was handled in `raise` mode.
   *  When true, the action-window flips the result to `ok:false`. */
  raisedSince(since: number): boolean {
    return this.records.matchedSince(since, (r) => r.handledAs === "raised");
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
