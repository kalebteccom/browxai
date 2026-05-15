#!/usr/bin/env node
// browxai canonical entrypoint.
//
// Sub-commands (wishlist W-B6 / W-B7 / W-D3):
//   browxai                       start the MCP server (stdio)            — default
//   browxai doctor                env + connectivity health-check
//   browxai chrome start [opts]   launch an attachable Chrome (BYOB host)
//   browxai chrome stop           kill the Chrome that `chrome start` launched
//   browxai init <workspace>      bootstrap a per-app workspace (.mcp.json + sniff)
//
// All transient state lives at $BROWX_WORKSPACE (default ~/.browxai/). NEVER cwd.

import { createServer } from "./server.js";
import { runDoctor } from "./cli/doctor.js";
import { runChrome } from "./cli/chrome.js";
import { runInit } from "./cli/init.js";
import { log } from "./util/logging.js";
import { resolveConfig } from "./util/config.js";
import { resolveWorkspace } from "./util/workspace.js";

async function main(): Promise<void> {
  const [, , subcommand, ...rest] = process.argv;

  // Sub-command dispatch.
  switch (subcommand) {
    case "doctor":
      process.exit(await runDoctor());
    case "chrome":
      process.exit(await runChrome(rest));
    case "init":
      process.exit(await runInit(rest));
    case undefined:
      break; // fall through to MCP server
    default:
      // Unknown subcommand — print help and exit non-zero (don't silently start the
      // MCP server, since stdout is the MCP wire and we'd corrupt any caller's expectation).
      process.stderr.write(
        `unknown subcommand "${subcommand}". Valid: doctor | chrome | init | (no args = start MCP server)\n`,
      );
      process.exit(2);
  }

  // Default: MCP server.
  const workspace = resolveWorkspace();
  const config = resolveConfig();
  const attachCdp = process.env.BROWX_ATTACH_CDP?.trim() || undefined;
  const headless = process.env.BROWX_HEADLESS === "1";

  log.info("browxai: starting", {
    workspace: workspace.root,
    mode: attachCdp ? "byob" : "managed",
    attachCdp,
    headless,
    testAttributes: config.testAttributes,
  });

  const server = await createServer({ attachCdp, headless });

  const shutdown = async (signal: string): Promise<void> => {
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
