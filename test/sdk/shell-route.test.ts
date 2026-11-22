// Shell route, hermetic: `browxai call` and `browxai tools` against a real
// `serve --socket` daemon on a throwaway socket, with no browser. Every tool used here
// answers before it touches a page: `list_sessions`, `close_session` (which echoes the id
// it was given), `get_config`, and the tools a default server refuses.
//
// The headline check: a gated tool refuses through the route exactly as it does over MCP.
// The refusal is compared with what the in-process MCP handler returns and with what a
// plain MCP client gets over the same socket, so the route cannot add or lose a field.
// The browser-backed flow (open a session, snapshot, click) is the keystone's.
//
// Skipped on Windows: the daemon test relies on POSIX socket file semantics.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClientServer, type ClientHandlers } from "../../src/cli/serve-client.js";
import { listenPrivate } from "../../src/cli/serve-socket.js";
import { startServeForTests } from "../../src/cli/serve.js";
import { runCall } from "../../src/cli/shell-call.js";
import type { ShellIo } from "../../src/cli/shell-io.js";
import { runTools } from "../../src/cli/shell-tools.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { buildHost, type HostDeps } from "../../src/tools/host-build.js";
import type { ToolResponse } from "../../src/tools/host.js";
import { SocketTransport } from "../../src/transport/socket-transport.js";
import { SecretRegistry } from "../../src/util/secrets.js";
import { connectSocketClient } from "../../src/sdk/transport-socket.js";

const skipIfWindows = process.platform === "win32" ? describe.skip : describe;

let workspace: string;
let socketPath: string;
let serveHandle: Awaited<ReturnType<typeof startServeForTests>>;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-shell-route-"));
  process.env.BROWX_WORKSPACE = workspace;
  socketPath = join(workspace, "browxai.sock");
  serveHandle = await startServeForTests({ socketPath });
}, 30_000);

afterAll(async () => {
  await serveHandle?.shutdown().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  rmSync(workspace, { recursive: true, force: true });
}, 30_000);

interface Doc {
  isError: boolean;
  data?: Record<string, unknown>;
  text?: string;
  images: Array<{ mimeType: string; bytes: number; path?: string }>;
  truncated?: { originalChars: number; maxChars: number };
}

/** A fake process: its environment, what it prints, and what standard input holds. */
function fakeIo(env: Record<string, string | undefined> = {}, stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const io: ShellIo = {
    env,
    stdout: (t) => Promise.resolve(void out.push(t)),
    stderr: (t) => Promise.resolve(void err.push(t)),
    input: {
      readStdin: () => Promise.resolve(stdin),
      readFile: (path) => readFileSync(path, "utf8"),
    },
  };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

/** Run `browxai call` and return the exit code, the parsed document and the raw streams. */
async function call(args: string[], env: Record<string, string | undefined> = {}, stdin = "") {
  const fake = fakeIo(env, stdin);
  const code = await runCall(args, fake.io);
  const raw = fake.out();
  const doc = raw === "" ? undefined : (JSON.parse(raw) as Doc);
  return { code, doc, raw, err: fake.err() };
}

const viaSocket = (...args: string[]) => ["--socket", socketPath, ...args];

skipIfWindows("browxai call against a serve --socket daemon", () => {
  it("runs a tool and prints one JSON document and nothing else on standard output", async () => {
    const { code, doc, raw, err } = await call(["list_sessions", ...viaSocket()]);
    expect(code).toBe(0);
    expect(doc?.isError).toBe(false);
    expect(doc?.data).toHaveProperty("sessions");
    expect(doc?.images).toEqual([]);
    expect(raw.trimEnd().split("\n")).toHaveLength(1);
    expect(raw.endsWith("\n")).toBe(true);
    expect(err).toBe("");
  });

  it("forwards the arguments, from the command line, standard input and a file", async () => {
    // `close_session` on an id that was never opened echoes the id it was asked to close.
    const inline = await call(["close_session", '{"session":"probe-argv"}', ...viaSocket()]);
    expect(inline.doc?.data?.session).toBe("probe-argv");

    const stdin = await call(
      ["close_session", "-", ...viaSocket()],
      {},
      '{"session":"probe-stdin"}',
    );
    expect(stdin.doc?.data?.session).toBe("probe-stdin");

    const file = join(workspace, "args.json");
    writeFileSync(file, '{"session":"probe-file"}');
    const fromFile = await call(["close_session", "--args-file", file, ...viaSocket()]);
    expect(fromFile.doc?.data?.session).toBe("probe-file");
  });

  it("merges the session: the arguments beat the flag, and the flag beats the variable", async () => {
    const env = { BROWX_SESSION: "from-env" };
    const fromEnv = await call(["close_session", ...viaSocket()], env);
    expect(fromEnv.doc?.data?.session).toBe("from-env");
    const fromFlag = await call(["close_session", "--session", "from-flag", ...viaSocket()], env);
    expect(fromFlag.doc?.data?.session).toBe("from-flag");
    const fromArgs = await call(
      ["close_session", '{"session":"from-args"}', "--session", "from-flag", ...viaSocket()],
      env,
    );
    expect(fromArgs.doc?.data?.session).toBe("from-args");
  });

  it("reads the socket path from BROWX_SOCKET", async () => {
    const { code, doc } = await call(["list_sessions"], { BROWX_SOCKET: socketPath });
    expect(code).toBe(0);
    expect(doc?.data).toHaveProperty("sessions");
  });

  it("exits 1 for an unknown tool, with the daemon's own message", async () => {
    const { code, doc } = await call(["no_such_tool", ...viaSocket()]);
    expect(code).toBe(1);
    expect(doc?.isError).toBe(true);
    expect(doc?.text).toContain('unknown tool "no_such_tool"');
  });

  it("cuts a long result at --max-chars, sets truncated, and keeps the exit code", async () => {
    const cut = await call(["get_config", "--max-chars", "40", ...viaSocket()]);
    expect(cut.code).toBe(0);
    expect(cut.doc?.data).toBeUndefined();
    expect(cut.doc?.text).toHaveLength(40);
    expect(cut.doc?.truncated?.maxChars).toBe(40);
    expect(cut.doc?.truncated?.originalChars).toBeGreaterThan(40);

    const whole = await call(["get_config", "--max-chars", "0", ...viaSocket()]);
    expect(whole.doc?.truncated).toBeUndefined();
    expect(whole.doc?.data).toBeDefined();
  });

  it("says so, and still exits by the result, when --out is asked of a result with no image", async () => {
    const out = join(workspace, "no-image.png");
    const { code, err } = await call(["list_sessions", "--out", out, ...viaSocket()]);
    expect(code).toBe(0);
    expect(err).toContain("no image");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses an --out file that exists, with exit 2 and before anything runs", async () => {
    const out = join(workspace, "taken.png");
    writeFileSync(out, "keep me");
    const { code, raw, err } = await call(["list_sessions", "--out", out, ...viaSocket()]);
    expect(code).toBe(2);
    expect(raw).toBe("");
    expect(err).toContain("--force");
    expect(readFileSync(out, "utf8")).toBe("keep me");
  });
});

skipIfWindows("browxai call: usage and unreachable daemons", () => {
  it("exits 2 with the usage when no tool is named", async () => {
    const { code, raw, err } = await call([]);
    expect(code).toBe(2);
    expect(raw).toBe("");
    expect(err).toContain("usage: browxai call");
  });

  it("exits 2 for arguments that are not a JSON object, without printing them", async () => {
    const secret = "s3cr3t-in-bad-json";
    const bad = await call(["fill", `{"value":"${secret}", nope}`, ...viaSocket()]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("not valid JSON");
    expect(bad.err).not.toContain(secret);
    const array = await call(["fill", "[1]", ...viaSocket()]);
    expect(array.code).toBe(2);
  });

  it("exits 2 for an unreadable arguments file", async () => {
    const { code, err } = await call(["fill", "--args-file", join(workspace, "nope.json")]);
    expect(code).toBe(2);
    expect(err).toContain("could not read the arguments");
  });

  it("refuses register_secret arguments on the command line before connecting", async () => {
    const value = "hunter2-on-the-command-line";
    const { code, raw, err } = await call([
      "register_secret",
      `{"name":"PW","value":"${value}"}`,
      ...viaSocket(),
    ]);
    expect(code).toBe(2);
    expect(raw).toBe("");
    expect(err).toContain("standard input");
    expect(err).not.toContain(value);
  });

  it("exits 3 when no socket path is given, and does not look for one", async () => {
    const { code, raw, err } = await call(["list_sessions"]);
    expect(code).toBe(3);
    expect(raw).toBe("");
    expect(err).toContain("--socket");
    expect(err).toContain("BROWX_SOCKET");
  });

  it("exits 3 when nothing is at the socket path", async () => {
    const missing = join(workspace, "nothing-here.sock");
    const { code, raw, err } = await call(["list_sessions", "--socket", missing]);
    expect(code).toBe(3);
    expect(raw).toBe("");
    expect(err).toContain(missing);
  });
});

skipIfWindows("a gated tool refuses through the shell route exactly as over MCP", () => {
  /** What an MCP client gets from the server the stdio bin runs: the registered tools behind
   *  the MCP server's own schema check and the masked wire handlers, reached over an
   *  in-memory pair where stdio would be. This is a different code path from the daemon's
   *  socket handlers, so it is a real second leg for the comparison. */
  async function overStdioServer(tool: string, args: Record<string, unknown>) {
    const server = await createServer({});
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    await server.start(serverEnd);
    const client = new Client({ name: "shell-route-test", version: "0" });
    await client.connect(clientEnd);
    try {
      const res = await client.callTool({ name: tool, arguments: args });
      const items = res.content as Array<{ type: string; text?: string }>;
      return JSON.parse(items[0]?.text ?? "null") as Record<string, unknown>;
    } finally {
      await client.close();
      await server.shutdown();
    }
  }

  /** What a plain MCP client gets from the same daemon over the same socket. */
  async function overMcpSocket(tool: string, args: Record<string, unknown>) {
    const client = await connectSocketClient(socketPath);
    try {
      const res = await client.callTool({ name: tool, arguments: args });
      const items = res.content as Array<{ type: string; text?: string }>;
      return JSON.parse(items[0]?.text ?? "null") as Record<string, unknown>;
    } finally {
      await client.close();
    }
  }

  it("refuses eval_js with exit 4 and the same envelope over the socket and over the stdio server", async () => {
    const viaRoute = await call(["eval_js", '{"expr":"1+1"}', ...viaSocket()]);
    expect(viaRoute.code).toBe(4);
    expect(viaRoute.doc?.isError).toBe(false);
    expect(viaRoute.doc?.data?.ok).toBe(false);
    expect(viaRoute.doc?.data?.requiredCapability).toBe("eval");
    expect(String(viaRoute.doc?.data?.hint)).toContain("BROWX_CAPABILITIES");

    expect(viaRoute.doc?.data).toEqual(await overMcpSocket("eval_js", { expr: "1+1" }));
    expect(viaRoute.doc?.data).toEqual(await overStdioServer("eval_js", { expr: "1+1" }));
  });

  it("refuses register_secret from standard input with exit 4, and the secret goes nowhere", async () => {
    const value = "hunter2-from-stdin";
    const body = JSON.stringify({ name: "PW", value });
    const { code, doc, raw, err } = await call(["register_secret", "-", ...viaSocket()], {}, body);
    expect(code).toBe(4);
    expect(doc?.data?.requiredCapability).toBe("secrets");
    expect(raw).not.toContain(value);
    expect(err).not.toContain(value);
  });

  it("does not run a gated tool dispatched inside batch, and matches the MCP answer", async () => {
    const args = { calls: [{ tool: "eval_js", args: { expr: "1+1" } }] };
    const viaRoute = await call(["batch", JSON.stringify(args), ...viaSocket()]);
    const report = viaRoute.doc?.data as {
      completed: number;
      failedAt: number | null;
      results: Array<{ ok: boolean; result?: unknown; error?: string }>;
    };
    expect(report.failedAt).toBe(0);
    expect(report.results[0]?.ok).toBe(false);
    expect(report.results[0]?.result).toBeUndefined();
    expect(viaRoute.doc?.data).toEqual(await overMcpSocket("batch", args));
    expect(viaRoute.doc?.data).toEqual(await overStdioServer("batch", args));
  });
});

skipIfWindows("browxai tools against a serve --socket daemon", () => {
  it("lists the tools the daemon runs, each with a capability and a real description", async () => {
    const fake = fakeIo();
    expect(await runTools(["--socket", socketPath, "--json"], fake.io)).toBe(0);
    const doc = JSON.parse(fake.out()) as {
      source: string;
      tools: Array<{ name: string; capability: string; description: string }>;
    };
    expect(doc.source).toBe("daemon");
    const byName = new Map(doc.tools.map((t) => [t.name, t]));
    expect(byName.get("snapshot")?.capability).toBe("read");
    expect(byName.get("click")?.capability).toBe("action");
    expect(byName.get("navigate")?.capability).toBe("navigation");
    for (const t of doc.tools) {
      expect(t.description, t.name).not.toBe(`browxai/${t.name}`);
      expect(t.description.length, t.name).toBeGreaterThan(0);
    }
    // The default `toolList` setting leaves out a tool the server cannot run.
    expect(byName.has("eval_js")).toBe(false);
  });

  it("prints text lines by default, with nothing on standard error", async () => {
    const fake = fakeIo({ BROWX_SOCKET: socketPath });
    expect(await runTools([], fake.io)).toBe(0);
    expect(fake.err()).toBe("");
    expect(
      fake
        .out()
        .split("\n")
        .find((l) => l.startsWith("snapshot ")),
    ).toMatch(/^snapshot\s+read\s+\S/);
  });
});

// A daemon built from the real client-connection code (`createClientServer`, the same
// function `browxai serve` uses) over a stub host: one registered secret, and tools
// that throw, never answer, or answer with an image. These are the cases a real daemon
// cannot produce without a browser.
skipIfWindows("browxai call against a daemon with throwing, silent and image tools", () => {
  const PIXELS = Buffer.from("not really a png");
  const B64 = PIXELS.toString("base64");
  let stubPath: string;
  let netServer: NetServer;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    const secrets = new SecretRegistry();
    secrets.register({ name: "PASSWORD", value: "hunter2" });
    const toolHandlers: Record<string, (args: unknown) => Promise<ToolResponse>> = {};
    const wireHandlers: Record<string, (args: unknown) => Promise<ToolResponse>> = {};
    const host = buildHost({
      server: { registerTool: () => undefined },
      toolHandlers,
      wireHandlers,
      registry: { list: () => [{ secrets }], peek: () => undefined },
      config: { testAttributes: [] },
      caps: { enabled: new Set(["read", "secrets"]) },
      diagnostics: { enabled: false },
      pluginRecords: () => [],
    } as unknown as HostDeps);
    const image = (ok: boolean): ToolResponse => ({
      content: [
        { type: "image", data: B64, mimeType: "image/png" },
        { type: "text", text: JSON.stringify({ ok }) },
      ],
    });
    host.register("probe_throws", { description: "Throws." }, () =>
      Promise.reject(new Error("login failed for hunter2")),
    );
    host.register(
      "probe_slow",
      { description: "Never answers." },
      () => new Promise<ToolResponse>(() => undefined),
    );
    host.register("probe_image", { description: "An image." }, () => Promise.resolve(image(true)));
    host.register("probe_image_fails", { description: "An image, and a failure." }, () =>
      Promise.resolve(image(false)),
    );
    const handlers: ClientHandlers = {
      handlers: toolHandlers,
      wireHandlers,
      isToolListed: () => true,
      registrations: host.registrations,
    };
    stubPath = join(workspace, "stub.sock");
    netServer = createNetServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      void createClientServer(handlers).connect(new SocketTransport(socket));
    });
    await listenPrivate(netServer, stubPath);
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => netServer?.close(() => resolve()));
  });

  const viaStub = (...args: string[]) => ["--socket", stubPath, ...args];

  it("masks a registered secret in a thrown error's message, and prints it nowhere", async () => {
    const { code, doc, raw, err } = await call(["probe_throws", ...viaStub()]);
    expect(code).toBe(1);
    expect(doc?.isError).toBe(true);
    expect(doc?.text).toBe("login failed for <PASSWORD>");
    expect(raw).not.toContain("hunter2");
    expect(err).not.toContain("hunter2");
  });

  it("exits 3 with a clear line when the daemon does not answer within --timeout", async () => {
    const started = Date.now();
    const { code, raw, err } = await call(["probe_slow", ...viaStub("--timeout", "300")]);
    expect(code).toBe(3);
    expect(raw).toBe("");
    expect(err).toContain("did not answer within 300 ms");
    expect(err).toContain("--timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("writes the image of a successful call, owner-only, and records its path", async () => {
    const out = join(workspace, "stub-shot.png");
    const { code, doc, err } = await call(["probe_image", ...viaStub("--out", out)]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(readFileSync(out).equals(PIXELS)).toBe(true);
    expect(doc?.images).toEqual([{ mimeType: "image/png", bytes: PIXELS.length, path: out }]);
  });

  it("writes nothing for a call that failed, and keeps the tool's exit code", async () => {
    const out = join(workspace, "failed-shot.png");
    const { code, doc, err } = await call(["probe_image_fails", ...viaStub("--out", out)]);
    expect(code).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(err).toContain("did not succeed");
    expect(doc?.images[0]?.path).toBeUndefined();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "exits 1 when the image cannot be written after the tool ran",
    async () => {
      const dir = join(workspace, "read-only");
      mkdirSync(dir);
      chmodSync(dir, 0o500);
      try {
        const out = join(dir, "shot.png");
        const { code, doc, err } = await call(["probe_image", ...viaStub("--out", out)]);
        expect(code).toBe(1);
        expect(err).toContain("the tool ran, but could not write");
        // The result is still printed.
        expect(doc?.images).toHaveLength(1);
        expect(doc?.images[0]?.path).toBeUndefined();
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );
});
