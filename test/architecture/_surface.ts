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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, NAME, VERSION, type StartOptions } from "../../src/server.js";
import { buildHost, type HostDeps } from "../../src/tools/host-build.js";
import type { ToolResponse } from "../../src/tools/host.js";
import { buildSessionRegistry } from "../../src/tools/session-registry.js";
import { resolveConfig } from "../../src/util/config.js";
import { resolveWorkspace } from "../../src/util/workspace.js";
import { ConfigStore, resolvedToEnv } from "../../src/util/config-store.js";
import { resolveCapabilities, resolveConfirmHooks } from "../../src/util/capabilities.js";
import { resolveOriginPolicy } from "../../src/policy/origin.js";
import { ApprovalStore } from "../../src/policy/confirm.js";
import { resolveCredentialsProvider } from "../../src/util/credentials.js";
import { DiagnosticsRecorder } from "../../src/util/diagnostics.js";

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

/** Assemble a headless `HostDeps` so `buildHost` runs without opening a browser.
 *
 *  This mirrors the deps `createServer` assembles (server.ts:292-339) using the
 *  same public resolvers, with two differences that keep it browser-free and
 *  side-effect-free: the session-registry factory it wires is lazy (no session
 *  is ever opened here), and the two per-handler closures `describeTarget` /
 *  `asTarget` are stubs — `buildHost` only stores them on the host and never
 *  invokes them at construction, and no handler runs in this suite. The batch
 *  allow-set is a plain `const` captured when `buildHost` runs, so it is fully
 *  resolved the moment the host exists. */
function makeTestHostDeps(opts: StartOptions = { headless: true }): HostDeps {
  const workspace = resolveWorkspace();
  const configStore = new ConfigStore(workspace.root);
  const resolvedConfig = configStore.resolve();
  const cfgEnv = resolvedToEnv(resolvedConfig);
  const config = resolveConfig(cfgEnv);
  const caps = resolveCapabilities(cfgEnv);
  const confirmHooks = resolveConfirmHooks(cfgEnv);
  const originPolicy = resolveOriginPolicy(cfgEnv);
  const approvals = new ApprovalStore();
  const credentialsResolved = resolveCredentialsProvider(cfgEnv);
  const diagnostics = new DiagnosticsRecorder({ enabled: false, workspaceRoot: workspace.root });
  const registry = buildSessionRegistry({
    opts,
    resolvedConfig,
    configStore,
    caps,
    workspace,
    serverEngine: "chromium",
    serverDefaultMode: "persistent",
  });
  const server = new McpServer({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });
  const toolHandlers: Record<string, (args: unknown) => Promise<ToolResponse>> = {};
  return {
    server,
    toolHandlers,
    registry,
    config,
    configStore,
    resolvedConfig,
    caps,
    confirmHooks,
    originPolicy,
    approvals,
    isByob: false,
    workspace,
    diagnostics,
    credentialsResolved,
    pluginRecords: () => [],
    startOptions: opts,
    // Stubs: stored on the host, never invoked at construction or in this suite.
    describeTarget: async () => "",
    asTarget: () => {
      throw new Error("asTarget is a test stub — no handler runs in the architecture suite");
    },
  };
}

/** The batch allow-set, read OFF a built ToolHost via `ToolHost.batchAllowedTools`
 *  (host.ts:160). `BATCH_ALLOWED_TOOLS` is a local `const` (host-build.ts:640-712),
 *  not exported — this is the only sanctioned read of the set, never an import of
 *  the const. The host builds with no browser open (the session factory is lazy). */
export async function batchAllowedTools(): Promise<ReadonlySet<string>> {
  return withHermeticWorkspace(async () => {
    const host = buildHost(makeTestHostDeps());
    return host.batchAllowedTools;
  });
}
