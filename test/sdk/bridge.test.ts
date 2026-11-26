// `browxai bridge`, hermetic: the real bin started as a stdio child, the way an MCP
// client starts its server, relaying to a real `serve --socket` daemon on a throwaway
// socket. No browser: every tool used here answers before it touches a page.
//
// The headline check: an MCP client behind the bridge sees what a client connected
// straight to the socket sees. The handshake result, the tool listing and a gated tool's
// refusal are compared field by field. The second half stops and restarts a daemon under
// a running bridge. The browser-backed flow is the keystone's.
//
// Skipped on Windows: the daemon test relies on POSIX socket file semantics.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createClientServer, type ClientHandlers } from "../../src/cli/serve-client.js";
import { listenPrivate } from "../../src/cli/serve-socket.js";
import { startServeForTests } from "../../src/cli/serve.js";
import { connectSocketClient } from "../../src/sdk/transport-socket.js";
import { createServer } from "../../src/server.js";
import type { ToolRegistration, ToolResponse } from "../../src/tools/host.js";
import { SocketTransport } from "../../src/transport/socket-transport.js";

const REPO = join(__dirname, "..", "..");
const skipIfWindows = process.platform === "win32" ? describe.skip : describe;
const CHILD_TIMEOUT = 60_000;

/** An MCP client whose server is the bridge bin, started as a stdio child. */
async function bridgedClient(socket: string, extraEnv: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: join(REPO, "node_modules/.bin/tsx"),
    args: [join(REPO, "src/cli.ts"), "bridge"],
    cwd: REPO,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      BROWX_SOCKET: socket,
      ...extraEnv,
    },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const client = new Client({ name: "bridge-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr.join("") };
}

const firstJson = (res: { content?: unknown }): Record<string, unknown> => {
  const items = res.content as Array<{ type: string; text?: string }>;
  return JSON.parse(items[0]?.text ?? "null") as Record<string, unknown>;
};

async function until<T>(attempt: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  // cap: ends at `deadline`.
  for (;;) {
    const value = await attempt();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

skipIfWindows("an MCP client behind browxai bridge and a real daemon", () => {
  let workspace: string;
  let socketPath: string;
  let serveHandle: Awaited<ReturnType<typeof startServeForTests>>;
  let bridged: Awaited<ReturnType<typeof bridgedClient>>;
  let direct: Client;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("BROWX_")) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }
    }
    workspace = mkdtempSync(join(tmpdir(), "browx-bridge-"));
    process.env.BROWX_WORKSPACE = workspace;
    socketPath = join(workspace, "browxai.sock");
    serveHandle = await startServeForTests({ socketPath });
    direct = await connectSocketClient(socketPath);
    bridged = await bridgedClient(socketPath, { BROWX_CAPABILITIES: "eval" });
  }, CHILD_TIMEOUT);

  afterAll(async () => {
    await bridged?.client.close().catch(() => undefined);
    await direct?.close().catch(() => undefined);
    await serveHandle?.shutdown().catch(() => undefined);
    delete process.env.BROWX_WORKSPACE;
    for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
    rmSync(workspace, { recursive: true, force: true });
  }, CHILD_TIMEOUT);

  it("gets the handshake result a direct socket client gets", () => {
    expect(bridged.client.getServerVersion()).toEqual(direct.getServerVersion());
    expect(bridged.client.getServerCapabilities()).toEqual(direct.getServerCapabilities());
    expect(bridged.client.getServerCapabilities()).toEqual({ tools: {} });
    expect(bridged.client.getServerVersion()?.name).toBe("browxai");
  });

  it("gets the same tool listing, with full descriptions and real input schemas", async () => {
    const viaBridge = await bridged.client.listTools();
    const viaSocket = await direct.listTools();
    expect(viaBridge).toEqual(viaSocket);
    expect(viaBridge.tools.length).toBeGreaterThan(50);

    const click = viaBridge.tools.find((t) => t.name === "click");
    expect(Object.keys(click?.inputSchema.properties ?? {})).toContain("ref");
    // The whole description, where the listing carried one line of 140 characters at most.
    expect(viaBridge.tools.some((t) => (t.description?.length ?? 0) > 140)).toBe(true);
    // The daemon's `toolList` setting still applies: a tool it cannot run is not listed.
    expect(viaBridge.tools.some((t) => t.name === "eval_js")).toBe(false);
  });

  it("runs a tool and forwards its arguments", async () => {
    const sessions = firstJson(await bridged.client.callTool({ name: "list_sessions" }));
    expect(sessions).toHaveProperty("sessions");
    // `close_session` on an id that was never opened echoes the id it was asked to close.
    const closed = firstJson(
      await bridged.client.callTool({
        name: "close_session",
        arguments: { session: "probe-bridge" },
      }),
    );
    expect(closed.session).toBe("probe-bridge");
  });

  it("refuses a gated tool as the daemon and the stdio server do, whatever the bridge's own environment says", async () => {
    const args = { expr: "1+1" };
    const viaBridge = firstJson(
      await bridged.client.callTool({ name: "eval_js", arguments: args }),
    );
    // The child was started with BROWX_CAPABILITIES=eval. The daemon's capabilities apply.
    expect(viaBridge.ok).toBe(false);
    expect(viaBridge.requiredCapability).toBe("eval");
    expect(viaBridge).toEqual(
      firstJson(await direct.callTool({ name: "eval_js", arguments: args })),
    );

    const server = await createServer({});
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    await server.start(serverEnd);
    const stdioClient = new Client({ name: "bridge-test", version: "0" });
    await stdioClient.connect(clientEnd);
    try {
      expect(viaBridge).toEqual(
        firstJson(await stdioClient.callTool({ name: "eval_js", arguments: args })),
      );
    } finally {
      await stdioClient.close();
      await server.shutdown();
    }
  });

  it("names the settings it ignores on standard error, and no value", () => {
    const line = bridged
      .stderr()
      .split("\n")
      .find((l) => l.includes("ignoring"));
    expect(line).toBe(
      "browxai bridge: ignoring BROWX_CAPABILITIES. The bridge starts no server, so the daemon's own settings apply.",
    );
  });

  it("answers an unknown method with the daemon's own error", async () => {
    const asked = bridged.client.request({ method: "no/such-method" }, ResultSchema);
    await expect(asked).rejects.toMatchObject({ code: -32601 });
  });
});

// A daemon built from the real client-connection code over a stub tool table, so a call
// can stay in flight for as long as the test needs and the daemon can stop and start.
skipIfWindows("browxai bridge across a daemon restart", () => {
  let dir: string;
  let socketPath: string;
  let netServer: NetServer | undefined;
  let bridged: Awaited<ReturnType<typeof bridgedClient>>;
  const sockets = new Set<Socket>();
  let slowCalls = 0;
  let generation = 0;

  const startDaemon = async (): Promise<void> => {
    generation++;
    const started = generation;
    const answer = (value: unknown): Promise<ToolResponse> =>
      Promise.resolve({ content: [{ type: "text", text: JSON.stringify(value) }] });
    const tools: Record<string, (args: unknown) => Promise<ToolResponse>> = {
      probe_echo: (args) => answer({ args, generation: started }),
      probe_slow: () => {
        slowCalls++;
        return new Promise<ToolResponse>(() => undefined);
      },
    };
    const handlers = {
      handlers: tools,
      wireHandlers: tools,
      isToolListed: () => true,
      registrations: new Map<string, ToolRegistration>([
        ["probe_echo", { description: "Echo the arguments back." }],
        ["probe_slow", { description: "Never answers." }],
      ]),
    } as unknown as ClientHandlers;
    netServer = createNetServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      void createClientServer(handlers).connect(new SocketTransport(socket));
    });
    await listenPrivate(netServer, socketPath);
  };

  const stopDaemon = async (): Promise<void> => {
    const server = netServer;
    netServer = undefined;
    // Stop accepting first: a redial that reaches a listener still open would start a
    // handshake, and the call during the gap would be held instead of refused.
    const closed = new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
    for (const s of sockets) s.destroy();
    await closed;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "browx-bridge-restart-"));
    socketPath = join(dir, "d.sock");
    await startDaemon();
    bridged = await bridgedClient(socketPath);
  }, CHILD_TIMEOUT);

  afterAll(async () => {
    await bridged?.client.close().catch(() => undefined);
    await stopDaemon();
    rmSync(dir, { recursive: true, force: true });
  }, CHILD_TIMEOUT);

  it(
    "fails the call in flight and a call during the gap, then works again with no client restart",
    async () => {
      const before = firstJson(
        await bridged.client.callTool({ name: "probe_echo", arguments: { n: 1 } }),
      );
      expect(before).toEqual({ args: { n: 1 }, generation: 1 });

      const inFlight = bridged.client.callTool({ name: "probe_slow", arguments: {} }).then(
        () => undefined,
        (err: unknown) => err as Error & { code?: number },
      );
      await until(() => Promise.resolve(slowCalls > 0 ? true : undefined), "the slow call");
      await stopDaemon();

      const lost = await inFlight;
      expect(lost?.code).toBe(-32000);
      expect(lost?.message).toContain("connection to the daemon was lost");
      expect(lost?.message).toContain("may or may not have run");

      const duringGap = await bridged.client
        .callTool({ name: "probe_echo", arguments: { n: 2 } })
        .then(
          () => undefined,
          (err: unknown) => err as Error & { code?: number },
        );
      expect(duringGap?.code).toBe(-32000);
      expect(duringGap?.message).toContain("was not sent");

      await startDaemon();
      const after = await until(
        () =>
          bridged.client.callTool({ name: "probe_echo", arguments: { n: 3 } }).then(
            (res) => firstJson(res),
            () => undefined,
          ),
        "the bridge to reach the restarted daemon",
      );
      expect(after).toEqual({ args: { n: 3 }, generation: 2 });
      // The child's standard error arrives on its own pipe, after the response.
      const logged = await until(
        () => Promise.resolve(bridged.stderr().includes("connection restored") ? true : undefined),
        "the reconnect to be logged",
      );
      expect(logged).toBe(true);
      expect(bridged.stderr()).toContain("daemon connection lost");
    },
    CHILD_TIMEOUT,
  );
});
