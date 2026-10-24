// `browxai serve --socket /tmp/foo.sock` — long-running server that listens
// on a Unix domain socket (or named pipe on Windows) and accepts MCP-over-
// socket connections. The wire framing is byte-identical to the stdio path
// (same JSON-lines + ReadBuffer), but the listener lets multiple SDK
// clients attach to ONE browser/session registry — the adopter
// loop-plus-script scenario.
//
// Off by default: there is no `serve` exposed unless the operator explicitly
// runs this subcommand and passes `--socket`. There is no auto-discovery; an
// SDK client must be given the endpoint URL out-of-band.
//
// Permissions: the socket is created with owner-only permissions (the umask is
// set before it is created), so only the owning user can connect. Capability gates are enforced at the
// server, identical to stdio.

import { createServer as createNetServer, type Server } from "node:net";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer, NAME, VERSION } from "../server.js";
import { resolveEngineSelection, UnknownEngineError, type EngineKind } from "../engine/index.js";
import { SocketTransport } from "../transport/socket-transport.js";
import { log } from "../util/logging.js";
import { isHeadlessEnv } from "../util/config-store.js";
import {
  SocketPathError,
  isPipePath,
  listenPrivate,
  removeStaleSocket,
  resolveSocketPath,
} from "./serve-socket.js";

interface ServeOptions {
  readonly socketPath: string;
  readonly attachCdp?: string;
  readonly headless?: boolean;
  /** Server default engine for sessions (from `--engine` / `BROWX_ENGINE`).
   *  Undefined ⇒ server.ts defaults to chromium. Per-session `open_session`
   *  ({engine}) still overrides this default. */
  readonly browserType?: EngineKind;
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
  const headless = isHeadlessEnv(process.env.BROWX_HEADLESS);
  // Server default engine: `--engine <kind>` > `BROWX_ENGINE` > chromium (left
  // to server.ts when undefined). An unknown engine fails loudly here, before
  // the server starts — same posture as `browxai` stdio (src/cli.ts). Per-session
  // `open_session({engine})` overrides this default at runtime.
  let browserType: EngineKind | undefined;
  try {
    browserType = resolveEngineSelection(rawArgs);
  } catch (err) {
    if (
      err instanceof UnknownEngineError ||
      (err instanceof Error && err.message.includes("--engine"))
    ) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
  try {
    return await startServe({ socketPath, attachCdp, headless, browserType });
  } catch (err) {
    if (err instanceof SocketPathError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

/** Exposed for tests — programmatic `browxai serve` startup that returns the
 *  underlying net.Server so a test can `close()` it cleanly. */
export async function startServeForTests(opts: ServeOptions): Promise<{
  server: Server;
  shutdown: () => Promise<void>;
}> {
  const socketPath = resolveSocketPath(opts.socketPath);
  // A stale socket left over from a crashed run would block .listen() with
  // EADDRINUSE, so a socket at the path is removed. Anything else at the path
  // is left alone and the start fails.
  if (!isPipePath(socketPath)) {
    try {
      removeStaleSocket(socketPath);
    } catch (err) {
      if (err instanceof SocketPathError) throw err;
      /* race; the listen() below will fail loudly if it actually mattered */
    }
  }

  const browxai = await createServer({
    attachCdp: opts.attachCdp,
    headless: opts.headless,
    browserType: opts.browserType,
  });

  // Each attached client connection gets its OWN low-level MCP Server that
  // routes JSON-RPC straight to the SHARED `browxai.handlers` map (session-state
  // isolation is the SessionRegistry's job, already true). We deliberately do
  // NOT use the high-level `McpServer.registerTool` with per-tool schemas: that
  // path validates/strips arguments against the declared schema, and an empty
  // schema dropped every argument (the `navigate`-hangs-forever bug). The
  // low-level CallTool handler forwards raw arguments, exactly like the
  // in-process transport.
  const liveConnections = new Set<{ close: () => Promise<void> }>();

  const netServer: Server = createNetServer((socket) => {
    void (async () => {
      try {
        // Route JSON-RPC straight to the in-process handler map with the RAW
        // arguments. The previous `McpServer.registerTool(name, { inputSchema:
        // {} }, …)` path validated each call against an EMPTY object schema,
        // which silently STRIPPED every argument — so e.g. `navigate` reached
        // its handler with no `url` and hung the whole call (load wait that
        // never resolves). The per-tool handler does its own validation, so the
        // socket layer must pass args through untouched, exactly like the
        // in-process transport (`src/sdk/transport-in-process.ts`).
        const mcp = new McpServer(
          { name: NAME, version: VERSION },
          { capabilities: { tools: {} } },
        );
        mcp.setRequestHandler(ListToolsRequestSchema, () => ({
          tools: Object.keys(browxai.handlers).map((name) => ({
            name,
            description: `browxai/${name}`,
            // Open schema — NOT `{}` (which strips args). The handler validates.
            inputSchema: { type: "object" as const, additionalProperties: true },
          })),
        }));
        mcp.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
          const handler = browxai.handlers[request.params.name];
          if (!handler) {
            return {
              isError: true,
              content: [{ type: "text", text: `browxai: unknown tool "${request.params.name}"` }],
            };
          }
          return await handler(request.params.arguments ?? {});
        });
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
        log.error(
          "browxai serve: could not set up this client connection, so it was closed. The server is still running.",
          {
            error: err instanceof Error ? err.message : String(err),
          },
        );
        socket.destroy();
      }
    })();
  });

  // The socket is created owner-only: the permissions are set before it exists.
  await listenPrivate(netServer, socketPath);

  const shutdown = async (): Promise<void> => {
    for (const conn of liveConnections) {
      await conn.close().catch(() => undefined);
    }
    liveConnections.clear();
    await new Promise<void>((resolve) => {
      netServer.close(() => resolve());
    });
    await browxai.shutdown().catch(() => undefined);
    if (!isPipePath(socketPath)) {
      try {
        removeStaleSocket(socketPath);
      } catch {
        /* tolerated */
      }
    }
  };

  return { server: netServer, shutdown };
}

async function startServe(opts: ServeOptions): Promise<number> {
  const { shutdown } = await startServeForTests(opts);
  log.info("serve listening", { socket: opts.socketPath });

  // Keep the process alive until a signal.
  const onSignal = async (sig: string): Promise<void> => {
    log.info(`serve shutdown (${sig})`);
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
