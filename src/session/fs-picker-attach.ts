// Server-side attach/binding adapter for the fs-picker policy. Realm 3 of the
// fs-picker split (the *-attach half) — sibling realms are `fs-picker-policy`
// (Node-side state) and `fs-picker-page-script` (the browser-only init-script
// string). Re-exported by the `fs-picker` barrel.
//
// This is the Playwright/CDP wiring: it installs the two exposeBindings the
// page-side stubs call back into (`__browx_fs_picker_check` /
// `__browx_fs_picker_write`) and re-injects the page script on every new
// document. It reads the policy decision off `FsPickerPolicyState` and routes
// `createWritable()`-driven writes to the workspace.

import type { BrowserContext } from "playwright-core";
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, basename } from "node:path";
import { log } from "../util/logging.js";
import {
  resolveWorkspaceFsPath,
  SUPPORTED_FS_PICKER_APIS,
  type FsPickerApi,
  type FsPickerAskHandler,
  type FsPickerFile,
  type FsPickerPolicyState,
  type FsPickerRecord,
} from "./fs-picker-policy.js";
import { FS_PICKER_PAGE_SCRIPT } from "./fs-picker-page-script.js";

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
 *   - The page-side init script (see `fs-picker-page-script`), re-injected
 *     by Playwright on every new document.
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
