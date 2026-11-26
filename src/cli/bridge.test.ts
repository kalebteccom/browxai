// `browxai bridge` as a command: its arguments, how it finds and waits for the daemon,
// what it prints, and its exit codes. The daemon here is the real per-connection server
// (`createClientServer`) over a stub tool table, on a socket in a temporary directory.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ToolRegistration, ToolResponse } from "../tools/host.js";
import { SocketTransport } from "../transport/socket-transport.js";
import {
  BRIDGE_USAGE,
  ignoredSettings,
  openDaemonLink,
  runBridge,
  type BridgeIo,
} from "./bridge.js";
import type { DaemonLink } from "./bridge-relay.js";
import { createClientServer, type ClientHandlers } from "./serve-client.js";
import { listenPrivate } from "./serve-socket.js";

type Msg = Record<string, unknown>;

/** A fake process around `runBridge`: streams, the environment and a clock a test owns. */
function fakeProcess(over: Partial<BridgeIo> = {}) {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  const stdout = new PassThrough();
  const out: string[] = [];
  const err: string[] = [];
  const stops: Array<() => void> = [];
  stdout.on("data", (chunk: Buffer) => out.push(chunk.toString("utf8")));
  let clock = 0;
  const io: BridgeIo = {
    env: {},
    stdin,
    stdout,
    stderr: (text) => void err.push(text),
    onStop: (stop) => void stops.push(stop),
    sleep: (ms) => {
      clock += ms;
      return new Promise((resolve) => setImmediate(resolve));
    },
    now: () => clock,
    ...over,
  };
  return {
    io,
    stdin,
    err: () => err.join(""),
    messages: () =>
      out
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Msg),
    stop: () => stops.forEach((s) => s()),
    send: (m: Msg) => stdin.write(`${JSON.stringify(m)}\n`),
  };
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  // cap: ends at `deadline`.
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const refused = (code: string): Error => Object.assign(new Error(code), { code });

describe("browxai bridge: arguments and the socket path", () => {
  it("exits 2 with the usage for an unknown flag or a positional argument", async () => {
    for (const args of [["--start"], ["extra"], ["--socket"]]) {
      const p = fakeProcess();
      expect(await runBridge(args, p.io), args.join(" ")).toBe(2);
      expect(p.err()).toContain("usage: browxai bridge");
      expect(p.messages()).toEqual([]);
    }
  });

  it("exits 3 and names --socket and BROWX_SOCKET when it has no socket path", async () => {
    const p = fakeProcess();
    expect(await runBridge([], p.io)).toBe(3);
    expect(p.err()).toContain("--socket PATH");
    expect(p.err()).toContain("BROWX_SOCKET");
    expect(p.messages()).toEqual([]);
  });

  it("exits 3 for an endpoint with an empty path", async () => {
    const p = fakeProcess();
    expect(await runBridge(["--socket", "unix://"], p.io)).toBe(3);
    expect(p.err()).toContain("empty unix:// path");
  });

  it("keeps its usage in 80 columns", () => {
    for (const line of BRIDGE_USAGE.split("\n")) expect(line.length, line).toBeLessThanOrEqual(80);
  });
});

describe("browxai bridge: settings it ignores", () => {
  it("names every BROWX_ variable but BROWX_SOCKET", () => {
    expect(
      ignoredSettings({
        BROWX_WORKSPACE: "/w",
        BROWX_SOCKET: "/s",
        BROWX_CAPABILITIES: "eval",
        BROWX_UNSET: undefined,
        PATH: "/bin",
      }),
    ).toEqual(["BROWX_CAPABILITIES", "BROWX_WORKSPACE"]);
  });

  it("prints the names on one line and never a value", async () => {
    const p = fakeProcess({
      env: {
        BROWX_SOCKET: "/tmp/browxai-bridge-none.sock",
        BROWX_WORKSPACE: "/private/workspace-value",
        BROWX_CAPABILITIES: "eval,secrets",
      },
      connect: () => Promise.reject(refused("ENOENT")),
    });
    expect(await runBridge(["--connect-timeout", "0"], p.io)).toBe(3);
    const line = p
      .err()
      .split("\n")
      .find((l) => l.includes("ignoring"));
    expect(line).toContain("BROWX_CAPABILITIES, BROWX_WORKSPACE");
    expect(line).toContain("the daemon's own settings apply");
    expect(p.err()).not.toContain("workspace-value");
    expect(p.err()).not.toContain("eval,secrets");
  });

  it("says there is nothing to type when it runs in a terminal", async () => {
    const p = fakeProcess({ connect: () => Promise.reject(refused("ENOENT")) });
    p.stdin.isTTY = true;
    await runBridge(["--socket", "/tmp/none.sock", "--connect-timeout", "0"], p.io);
    expect(p.err()).toContain("this is an MCP server on stdio");
  });
});

describe("browxai bridge: waiting for the daemon", () => {
  it("tries every 250 ms until the time runs out, then exits 3 with the path and the next step", async () => {
    let attempts = 0;
    const p = fakeProcess({
      connect: () => {
        attempts++;
        return Promise.reject(refused("ECONNREFUSED"));
      },
    });
    const code = await runBridge(["--socket", "/tmp/b.sock", "--connect-timeout", "1000"], p.io);
    expect(code).toBe(3);
    expect(attempts).toBe(5);
    expect(p.err()).toContain("no daemon answered on /tmp/b.sock within 1000 ms (ECONNREFUSED)");
    expect(p.err()).toContain("browxai serve --socket /tmp/b.sock");
    expect(p.err()).toContain("login-item status");
    expect(p.messages()).toEqual([]);
  });

  it("tries once with --connect-timeout 0", async () => {
    let attempts = 0;
    const p = fakeProcess({
      connect: () => {
        attempts++;
        return Promise.reject(refused("ENOENT"));
      },
    });
    expect(await runBridge(["--socket", "/tmp/b.sock", "--connect-timeout", "0"], p.io)).toBe(3);
    expect(attempts).toBe(1);
    expect(p.err()).toContain("(nothing is there)");
  });

  it("exits 0 when it is told to stop while it waits", async () => {
    let attempts = 0;
    const p = fakeProcess({
      connect: () => {
        if (++attempts === 2) p.stop();
        return Promise.reject(refused("ENOENT"));
      },
    });
    expect(await runBridge(["--socket", "/tmp/b.sock"], p.io)).toBe(0);
    expect(attempts).toBe(2);
    expect(p.err()).not.toContain("no daemon answered");
  });
});

describe.skipIf(process.platform === "win32")("browxai bridge against a daemon", () => {
  let dir: string;
  let socketPath: string;
  let netServer: Server;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "browx-bridge-"));
    socketPath = join(dir, "d.sock");
    const echo = (args: unknown): Promise<ToolResponse> =>
      Promise.resolve({ content: [{ type: "text", text: JSON.stringify(args) }] });
    const handlers = {
      handlers: { probe_echo: echo },
      wireHandlers: { probe_echo: echo },
      isToolListed: () => true,
      registrations: new Map<string, ToolRegistration>([
        ["probe_echo", { description: "Echo the arguments back.", capability: "read" }],
      ]),
    } as unknown as ClientHandlers;
    netServer = createNetServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      void createClientServer(handlers).connect(new SocketTransport(socket));
    });
    await listenPrivate(netServer, socketPath);
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => netServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const initialize: Msg = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bridge-test", version: "0.0.0" },
    },
  };

  it("relays the handshake, a listing and a call, and exits 0 when the client closes its input", async () => {
    const p = fakeProcess({ env: { BROWX_SOCKET: socketPath } });
    const exit = runBridge([], p.io);

    p.send(initialize);
    await until(() => p.messages().length === 1, "the initialize result");
    const init = p.messages()[0]!.result as {
      capabilities: unknown;
      serverInfo: { name: string };
    };
    expect(init.capabilities).toEqual({ tools: {} });
    expect(init.serverInfo.name).toBe("browxai");

    p.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    p.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    p.send({
      jsonrpc: "2.0",
      id: "three",
      method: "tools/call",
      params: { name: "probe_echo", arguments: { a: 1 } },
    });
    await until(() => p.messages().length === 3, "the listing and the call result");
    const byId = new Map(p.messages().map((m) => [m.id, m]));
    const listed = (byId.get(2)!.result as { tools: Array<{ name: string; description: string }> })
      .tools;
    expect(listed.map((t) => t.name)).toEqual(["probe_echo"]);
    expect(listed[0]!.description).toBe("Echo the arguments back.");
    const called = byId.get("three")!.result as { content: Array<{ text: string }> };
    expect(JSON.parse(called.content[0]!.text)).toEqual({ a: 1 });

    p.stdin.end();
    expect(await exit).toBe(0);
    expect(p.err()).toBe("");
  });

  it("picks up a daemon that starts answering during the wait", async () => {
    let attempts = 0;
    const p = fakeProcess({
      connect: (path): Promise<DaemonLink> =>
        ++attempts < 3 ? Promise.reject(refused("ENOENT")) : openDaemonLink(path),
    });
    const exit = runBridge(["--socket", socketPath], p.io);
    p.send(initialize);
    await until(() => p.messages().length === 1, "the initialize result");
    expect(attempts).toBe(3);
    p.stop();
    expect(await exit).toBe(0);
  });

  it("accepts the unix:// form of the path", async () => {
    const p = fakeProcess();
    const exit = runBridge(["--socket", `unix://${socketPath}`], p.io);
    p.send(initialize);
    await until(() => p.messages().length === 1, "the initialize result");
    p.stop();
    expect(await exit).toBe(0);
  });

  it("exits 3 at once, with the reason, when the path is not a socket of this user", async () => {
    const file = join(dir, "plain-file");
    writeFileSync(file, "");
    const p = fakeProcess();
    expect(await runBridge(["--socket", file], p.io)).toBe(3);
    expect(p.err()).toContain("refusing to connect");
    expect(p.err()).toContain("is not a socket");
    expect(p.messages()).toEqual([]);
  });
});
