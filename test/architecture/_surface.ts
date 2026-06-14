// The static surface under test for the architecture-fitness suite.
//
// Every fitness test reads the LIVE registered surface — never a hand-copied
// list — so the freeze it asserts is against the real registration set, not a
// duplicate that could itself drift. Two readers:
//
//   - registeredToolNames(): the ~198 tool-name set, read off a server built
//     with no browser open (createServer wires every registerXxxTools(host)
//     module at construction; the session is lazy, so the full tool surface is
//     inspectable with zero engine — server.ts:142,310,380).
//   - batchAllowedTools(): the 71-entry batch allow-set, read OFF a built
//     ToolHost via the read-only `batchAllowedTools` member (host.ts:160).
//     `BATCH_ALLOWED_TOOLS` is a local `const` (host-build.ts:640-712) — NOT
//     exported — so this is the only sanctioned read of the set; never an import
//     of the const.
//
// Both run in the fast lane (vitest.config.ts excludes only test/keystone/** and
// test/investigation/**), statically, with no browser download or launch.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";

// ── Hermetic workspace ───────────────────────────────────────────────────────
// The frozen surface must never vary with the operator's real ~/.browxai: an
// installed `plugins.json` would add handlers and a persisted config could shift
// state. Both readers resolve the workspace from BROWX_WORKSPACE (workspace.ts:18),
// so each read runs with that env pointed at a fresh EMPTY temp dir — no
// `plugins.json` ⇒ zero plugins load ⇒ the deterministic core surface (198
// handlers) on any machine and in CI — then restores the prior env. (Nothing is
// written into the temp dir; the plugin runtime treats a missing declaration file
// as "no plugins declared".)
let hermeticRoot: string | undefined;
function hermeticWorkspaceRoot(): string {
  hermeticRoot ??= mkdtempSync(join(tmpdir(), "browxai-arch-surface-"));
  return hermeticRoot;
}

/** Run `fn` with BROWX_WORKSPACE pointed at the empty temp workspace, then
 *  restore. The architecture lane reads sequentially within a file, and vitest
 *  workers are separate processes, so the save/set/restore is race-free. */
async function withHermeticWorkspace<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.BROWX_WORKSPACE;
  process.env.BROWX_WORKSPACE = hermeticWorkspaceRoot();
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.BROWX_WORKSPACE;
    else process.env.BROWX_WORKSPACE = prev;
  }
}

/** Build the server far enough to enumerate the registered handler table.
 *  createServer wires every registerXxxTools(host) module at construction and
 *  exposes `handlers` (server.ts:149-156,380) WITHOUT opening a browser — the
 *  session is created lazily on the first browser-touching call. So the full
 *  tool surface (198 handlers today) is inspectable with zero engine, in a
 *  hermetic empty workspace so plugins/config can never perturb the freeze. */
export async function registeredToolNames(): Promise<string[]> {
  return withHermeticWorkspace(async () => {
    const server = await createServer({ headless: true });
    return Object.keys(server.handlers);
  });
}

/** The batch allow-set, DERIVED (RFC 0004 P2) from each `register({ batchable })`
 *  call and surfaced via `ToolHost.batchAllowedTools` (host.ts). It is read off a
 *  fully-registered host so the derivation has run; `collectToolMetadata` builds a
 *  browser-free host and runs every registration module. */
export async function batchAllowedTools(): Promise<ReadonlySet<string>> {
  const { collectToolMetadata } = await import("../../src/tools/tool-metadata.js");
  return withHermeticWorkspace(async () => {
    const table = collectToolMetadata();
    return new Set([...table].filter(([, m]) => m.batchable).map(([name]) => name));
  });
}

/** The full derived registration table (name → ToolMeta + zod schema), RFC 0004
 *  P2 / D7. Built browser-free by running every registration once. The derivation
 *  checks read `batchable` / `capability` / `deep` off this single table. */
export async function toolRegistrations() {
  const { collectToolMetadata } = await import("../../src/tools/tool-metadata.js");
  return withHermeticWorkspace(async () => collectToolMetadata());
}
