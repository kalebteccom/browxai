#!/usr/bin/env node
// browxai canonical entrypoint (first-consumer ask #2).
// `pnpm browxai` / `browxai` bin. Curated surface as default — no BROWX_SPIKE_* env vars.
//
// Configuration is env-driven (so an MCP-client `.mcp.json` can wire it without flags):
//   BROWX_WORKSPACE       — root for all transient state (default ~/.browxai/). NEVER cwd.
//   BROWX_ATTACH_CDP      — loopback CDP endpoint; opt in to BYOB attach (off by default).
//   BROWX_HEADLESS        — "1" to launch managed Chromium headless.
//
// stderr-only logging. stdout is the MCP wire.

import { createServer } from "./server.js";
import { log } from "./util/logging.js";
import { resolveWorkspace } from "./util/workspace.js";

async function main(): Promise<void> {
  const workspace = resolveWorkspace();
  const attachCdp = process.env.BROWX_ATTACH_CDP?.trim() || undefined;
  const headless = process.env.BROWX_HEADLESS === "1";

  log.info("browxai: starting", {
    workspace: workspace.root,
    mode: attachCdp ? "byob" : "managed",
    attachCdp,
    headless,
  });

  const server = await createServer({ attachCdp, headless });

  const shutdown = async (signal: string) => {
    log.info(`browxai: shutdown (${signal})`);
    await server.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.start();
}

main().catch((err) => {
  log.error("browxai: fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
