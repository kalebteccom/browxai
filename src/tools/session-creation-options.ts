// Pure spec → context-creation-options resolver for the session factory.
// Extracted verbatim from `buildSessionRegistry`'s factory so the resolution
// of the four native context-creation primitives (creation-time storageState,
// HAR recording, HAR replay, video recording) lives in one pure, testable
// place. It performs NO browser work and opens NO session — it only reads the
// `OpenSpec` + the workspace root and returns the resolved creation locals the
// factory then threads into `open*Session({...})` and the entry assembly.
//
// LEAF by construction: this never imports from `./session-registry.js` (the
// barrel that the factory lives in) — that would be an import cycle. The shared
// helpers (`buildRecordHarOption`, `resolveHarReplayPaths`,
// `buildRecordVideoOption`, `readStorageStateFile`, `authLoad`) and the
// `OpenSpec` type are pulled straight from their own leaf modules, exactly as
// the factory pulled them inline.

import { readStorageStateFile, authLoad, type StorageStateBlob } from "../session/storage.js";
import { buildRecordHarOption, resolveHarReplayPaths } from "../page/har.js";
import { buildRecordVideoOption } from "../page/video.js";
import type { OpenSpec } from "../session/registry.js";

/** The resolved context-creation locals — byte-identical to the locals the
 *  factory built inline. `creationRecordHar` / `creationRecordVideo` are the
 *  native context-creation primitives passed to `open*Session`; the
 *  `*Resolved` siblings carry the deterministic paths used later to seed the
 *  HAR/video recorder STATE on the entry. `creationReplayHars` are the resolved
 *  absolute replay-HAR paths applied post-create via `routeFromHAR`. */
export interface ResolvedCreationOptions {
  creationStorageState: StorageStateBlob | undefined;
  creationRecordHar:
    | {
        path: string;
        mode?: "full" | "minimal";
        content?: "embed" | "attach" | "omit";
        urlFilter?: string | RegExp;
      }
    | undefined;
  creationRecordHarResolved:
    | { path: string; mode: "full" | "minimal"; content: "embed" | "attach" | "omit" }
    | undefined;
  creationReplayHars: string[] | undefined;
  creationRecordVideo: { dir: string; size?: { width: number; height: number } } | undefined;
  creationRecordVideoResolved:
    | { targetPath: string; stagingDir: string; size?: { width: number; height: number } }
    | undefined;
}

/**
 * Resolve the per-session native context-creation options from the open spec.
 * Pure over `(id, workspaceRoot, spec)`: no browser, no registry, no side
 * effects beyond the workspace-path safety checks the helpers already perform
 * (which create parent dirs / reject escape / error on a missing replay file —
 * preserved exactly by calling the same helpers in the same order).
 */
export function resolveCreationOptions(
  id: string,
  workspaceRoot: string,
  spec: OpenSpec | undefined,
): ResolvedCreationOptions {
  // Resolve creation-time storageState (inline blob, workspace path, OR
  // named slot). Mutually exclusive. `attached`/BYOB sessions ignore it
  // (not-owned: we don't seed someone else's Chrome).
  let creationStorageState: StorageStateBlob | undefined;
  if (spec?.storageState !== undefined && spec?.authState !== undefined) {
    throw new Error(
      `session "${id}": pass exactly one of \`storageState\` or \`authState\` (not both)`,
    );
  }
  if (spec?.authState !== undefined) {
    creationStorageState = authLoad(workspaceRoot, spec.authState);
  } else if (typeof spec?.storageState === "string") {
    creationStorageState = readStorageStateFile(workspaceRoot, spec.storageState, "open_session");
  } else if (spec?.storageState) {
    creationStorageState = spec.storageState;
  }
  // Resolve HAR recording config (native context-creation primitive). The
  // path is workspace-rooted by construction (resolveWorkspacePath rejects
  // escape) and the parent dir is created up-front. Ignored on attached
  // (we don't mutate the consumer's Chrome).
  let creationRecordHar:
    | {
        path: string;
        mode?: "full" | "minimal";
        content?: "embed" | "attach" | "omit";
        urlFilter?: string | RegExp;
      }
    | undefined;
  let creationRecordHarResolved:
    | { path: string; mode: "full" | "minimal"; content: "embed" | "attach" | "omit" }
    | undefined;
  if (spec?.har) {
    const built = buildRecordHarOption(workspaceRoot, id, spec.har);
    creationRecordHar = built.recordHar;
    creationRecordHarResolved = { path: built.path, mode: built.mode, content: built.content };
  }
  // Resolve replay HAR paths (workspace-escape rejected; missing file
  // errors loudly so a typo doesn't silently fall back to live network).
  let creationReplayHars: string[] | undefined;
  if (spec?.hars && spec.hars.length) {
    creationReplayHars = resolveHarReplayPaths(workspaceRoot, spec.hars, "open_session");
  }
  // Resolve video recording config (native context-creation primitive).
  // The target path is workspace-rooted by construction; the staging dir
  // (where Playwright auto-names the file) is also under the workspace.
  // Ignored on attached (we don't mutate the consumer's Chrome).
  let creationRecordVideo: { dir: string; size?: { width: number; height: number } } | undefined;
  let creationRecordVideoResolved:
    | { targetPath: string; stagingDir: string; size?: { width: number; height: number } }
    | undefined;
  if (spec?.recordVideo) {
    const built = buildRecordVideoOption(workspaceRoot, id, spec.recordVideo);
    creationRecordVideo = built.recordVideo;
    creationRecordVideoResolved = {
      targetPath: built.targetPath,
      stagingDir: built.stagingDir,
      size: built.size,
    };
  }
  return {
    creationStorageState,
    creationRecordHar,
    creationRecordHarResolved,
    creationReplayHars,
    creationRecordVideo,
    creationRecordVideoResolved,
  };
}
