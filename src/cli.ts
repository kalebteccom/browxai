#!/usr/bin/env node
// browxai canonical entrypoint. See USAGE below for the sub-command surface.
//
// All transient state lives at $BROWX_WORKSPACE (default ~/.browxai/). NEVER cwd.

import { createServer } from "./server.js";
import { runDoctor } from "./cli/doctor.js";
import { runChrome } from "./cli/chrome.js";
import { runInit } from "./cli/init.js";
import { runServe } from "./cli/serve.js";
import { runPlugin } from "./plugin/cli.js";
import { log } from "./util/logging.js";
import { resolveConfig } from "./util/config.js";
import { resolveWorkspace } from "./util/workspace.js";
import { PACKAGE_VERSION } from "./util/version.js";
import { resolveEngineSelection, UnknownEngineError } from "./engine/index.js";

const USAGE = `Usage: browxai [subcommand]

  browxai                       start the MCP server (stdio)            — default
  browxai doctor                env + connectivity health-check
  browxai chrome start [opts]   launch an attachable Chrome (BYOB host)
  browxai chrome stop           kill the Chrome that \`chrome start\` launched
  browxai init <workspace>      bootstrap a per-app workspace (.mcp.json + sniff)
  browxai serve --socket <p>    long-running server on a Unix socket / named pipe
                                — accepts MCP-over-socket connections from SDK clients
                                (\`createBrowxai({ endpoint: "unix:///..." })\`).
                                Off-by-default; explicit operator opt-in.
  browxai plugin <sub>          install / remove / list / info / upgrade / sync
                                plugins. All ops are workspace-rooted.

  --engine <kind>               browser engine for the MCP server: chromium
                                (default) | firefox | webkit | android. Overrides
                                BROWX_ENGINE. android implies attach-mode (real
                                Chrome-on-Android over adb — no BROWX_ATTACH_CDP).
  --version, -v                 print the browxai version
  --help, -h                    print this usage text

All transient state lives at $BROWX_WORKSPACE (default ~/.browxai/).
`;

async function main(): Promise<void> {
  const [, , subcommand, ...rest] = process.argv;

  // Sub-command dispatch.
  switch (subcommand) {
    case "doctor":
      process.exit(await runDoctor());
      break;
    case "chrome":
      process.exit(await runChrome(rest));
      break;
    case "init":
      process.exit(await runInit(rest));
      break;
    case "serve":
      process.exit(await runServe(rest));
      break;
    case "plugin":
      process.exit(await runPlugin(rest));
      break;
    case "--version":
    case "-v":
      process.stdout.write(`${PACKAGE_VERSION}\n`);
      process.exit(0);
      break;
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      process.exit(0);
      break;
    case undefined:
      break; // fall through to MCP server
    default:
      // `--engine <kind>` / `--engine=<kind>` is a SERVER-mode flag, not a
      // subcommand — when it appears first (`browxai --engine firefox`) it lands
      // in `subcommand`, so fall through to the MCP server path (which parses the
      // full argv for it) instead of treating it as unknown.
      if (subcommand === "--engine" || subcommand.startsWith("--engine=")) break;
      // Unknown subcommand — print help and exit non-zero (don't silently start the
      // MCP server, since stdout is the MCP wire and we'd corrupt any caller's expectation).
      process.stderr.write(
        `unknown subcommand "${subcommand}". Valid: doctor | chrome | init | serve | plugin | (no args = start MCP server). Run \`browxai --help\` for details.\n`,
      );
      process.exit(2);
  }

  // Default: MCP server.
  const workspace = resolveWorkspace();
  const config = resolveConfig();
  const attachCdp = process.env.BROWX_ATTACH_CDP?.trim() || undefined;
  const headless = process.env.BROWX_HEADLESS === "1";
  // Engine selection: explicit `--engine <kind>` > `BROWX_ENGINE` env > default
  // chromium (left to server.ts when this resolves undefined — byte-identical to
  // never passing browserType). An unknown engine fails loudly here, before the
  // server starts, with a structured message listing the implemented engines —
  // never a stack trace, never a silent fallback to chromium.
  let browserType;
  try {
    browserType = resolveEngineSelection(process.argv.slice(2));
  } catch (err) {
    if (
      err instanceof UnknownEngineError ||
      (err instanceof Error && err.message.includes("--engine"))
    ) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  log.info("browxai: starting", {
    workspace: workspace.root,
    mode: attachCdp ? "byob" : "managed",
    attachCdp,
    headless,
    engine: browserType ?? "chromium",
    testAttributes: config.testAttributes,
  });

  const server = await createServer({ attachCdp, headless, browserType });

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
