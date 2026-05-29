// `browxai serve --socket /tmp/foo.sock` — long-running server that listens
// on a Unix domain socket (or named pipe on Windows) and accepts MCP-over-
// socket connections. The wire framing is byte-identical to the stdio path
// (same JSON-lines + ReadBuffer), but the listener lets multiple SDK
// clients attach to ONE browser/session registry — the wrightxai
// loop-plus-script scenario.
//
// Off by default: there is no `serve` exposed unless the operator explicitly
// runs this subcommand and passes `--socket`. There is no auto-discovery; an
// SDK client must be given the endpoint URL out-of-band.
//
// Security posture: the socket is created with restrictive perms (0700) so
// only the owning user can connect. Capability gates are enforced at the
// server, identical to stdio.

import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer as createNetServer, type Server } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "../server.js";
import { SocketTransport } from "../sdk/socket-transport.js";
import { log } from "../util/logging.js";

interface ServeOptions {
  readonly socketPath: string;
  readonly attachCdp?: string;
  readonly headless?: boolean;
}

function parseFlagString(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) return undefined;
  return v;
}

export async function runServe(rawArgs: string[]): Promise<number> {
  const socketPath = parseFlagString(rawArgs, "--socket");
  if (!socketPath) {
    process.stderr.write(
      "usage: browxai serve --socket <unix-socket-path-or-windows-pipe-name>\n" +
        "  Example (macOS/Linux): browxai serve --socket /tmp/browxai.sock\n" +
        "  Example (Windows):     browxai serve --socket \\\\\\\\.\\\\pipe\\\\browxai\n",
    );
    return 2;
  }
  const attachCdp = process.env.BROWX_ATTACH_CDP?.trim() || undefined;
  const headless = process.env.BROWX_HEADLESS === "1";
  const code = await startServe({ socketPath, attachCdp, headless });
  return code;
}

/** Exposed for tests — programmatic `browxai serve` startup that returns the
 *  underlying net.Server so a test can `close()` it cleanly. */
export async function startServeForTests(opts: ServeOptions): Promise<{
  server: Server;
  shutdown: () => Promise<void>;
}> {
  // Existing socket file → remove. A stale socket left over from a crashed
  // run would otherwise block .listen() with EADDRINUSE.
  if (opts.socketPath.startsWith("/") && existsSync(opts.socketPath)) {
    try {
      unlinkSync(opts.socketPath);
    } catch {
      /* race; the listen() below will fail loudly if it actually mattered */
    }
  }

  const browxai = await createServer({ attachCdp: opts.attachCdp, headless: opts.headless });

  // We share ONE McpServer per attached client connection by creating a
  // fresh adapter per connection. The simplest correct approach: each
  // connection gets its OWN McpServer instance that re-registers against
  // the SAME `browxai.handlers` map. Since `handlers` is shared,
  // session-state isolation is the SessionRegistry's job (already true),
  // and the per-connection McpServer just routes the JSON-RPC.
  //
  // Implementation detail: re-creating tools from scratch on every connect
  // would require duplicating server.ts's input schemas. Instead we expose
  // a thin tool-call proxy: the connection's McpServer registers a single
  // catch-all? No — the MCP SDK requires tools to be registered by name.
  // The cleanest path is: register the same tool names that the in-process
  // server already has, with `inputSchema: { additionalProperties: true }`
  // (open schema — the underlying handler still validates). Each tool's
  // handler delegates to `browxai.handlers[name]`.
  const liveConnections = new Set<{ close: () => Promise<void> }>();

  const netServer: Server = createNetServer((socket) => {
    void (async () => {
      try {
        const mcp = new McpServer({ name: "browxai", version: "0.2.3" });
        for (const [name, handler] of Object.entries(browxai.handlers)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (mcp.registerTool as any)(
            name,
            { description: `browxai/${name}`, inputSchema: {} },
            async (args: unknown) => handler(args),
          );
        }
        const transport = new SocketTransport(socket);
        await mcp.connect(transport);
        const conn = {
          close: async () => {
            await mcp.close().catch(() => undefined);
            await transport.close().catch(() => undefined);
          },
        };
        liveConnections.add(conn);
        socket.on("close", () => {
          liveConnections.delete(conn);
        });
      } catch (err) {
        log.error("browxai serve: connection setup failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        socket.destroy();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    netServer.once("error", reject);
    netServer.listen(opts.socketPath, () => resolve());
  });

  // Tighten perms on the listening socket (POSIX only — chmod is a no-op /
  // throws on Windows pipes).
  if (opts.socketPath.startsWith("/")) {
    try {
      chmodSync(opts.socketPath, 0o700);
    } catch {
      /* best-effort; on macOS the socket inherits umask which is usually fine */
    }
  }

  const shutdown = async (): Promise<void> => {
    for (const conn of liveConnections) {
      await conn.close().catch(() => undefined);
    }
    liveConnections.clear();
    await new Promise<void>((resolve) => {
      netServer.close(() => resolve());
    });
    await browxai.shutdown().catch(() => undefined);
    if (opts.socketPath.startsWith("/") && existsSync(opts.socketPath)) {
      try {
        unlinkSync(opts.socketPath);
      } catch {
        /* tolerated */
      }
    }
  };

  return { server: netServer, shutdown };
}

async function startServe(opts: ServeOptions): Promise<number> {
  const { shutdown } = await startServeForTests(opts);
  log.info("browxai: serve listening", { socket: opts.socketPath });

  // Keep the process alive until a signal.
  const onSignal = async (sig: string): Promise<void> => {
    log.info(`browxai: serve shutdown (${sig})`);
    await shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void onSignal("SIGINT"));
  process.on("SIGTERM", () => void onSignal("SIGTERM"));

  // Block indefinitely.
  await new Promise<void>(() => {
    /* never resolves; signals exit */
  });
  return 0;
}
