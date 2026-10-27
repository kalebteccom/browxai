import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

interface FakeRequest {
  name: string;
  arguments: unknown;
}

const fake = vi.hoisted(() => {
  const state = {
    params: undefined as
      { command: string; args: string[]; env: Record<string, string>; stderr: string } | undefined,
    pid: 4242 as number | null,
    stderrChunks: [] as string[],
    stderrHandlers: [] as Array<(chunk: Buffer) => void>,
    connect: (): Promise<void> => Promise.resolve(),
    call: (_req: { name: string; arguments: unknown }): Promise<unknown> => Promise.resolve({}),
    requests: [] as Array<{ name: string; arguments: unknown }>,
    callOptions: [] as unknown[],
    connectOptions: undefined as unknown,
    closed: 0,
  };
  return state;
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    pid = fake.pid;
    stderr = {
      on: (_event: string, handler: (chunk: Buffer) => void) => {
        fake.stderrHandlers.push(handler);
      },
    };
    constructor(params: {
      command: string;
      args: string[];
      env: Record<string, string>;
      stderr: string;
    }) {
      fake.params = params;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect(_transport: unknown, options: unknown): Promise<void> {
      fake.connectOptions = options;
      for (const chunk of fake.stderrChunks) {
        for (const handler of fake.stderrHandlers) handler(Buffer.from(chunk));
      }
      await fake.connect();
    }
    async callTool(req: FakeRequest, _schema: unknown, options: unknown): Promise<unknown> {
      fake.requests.push(req);
      fake.callOptions.push(options);
      return fake.call(req);
    }
    close(): Promise<void> {
      fake.closed += 1;
      return Promise.resolve();
    }
  },
}));

import { runSmoke } from "./init-smoke.js";

const DIST_CLI = fileURLToPath(import.meta.url);
const NEXT = "Run `browxai doctor` to see what is missing, or skip this check with --no-smoke.";

const okReply = { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
const textReply = (text: string, isError = true) => ({
  isError,
  content: [{ type: "text", text }],
});
const jsonReply = (body: Record<string, unknown>) => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
});

const names = () => fake.requests.map((r) => r.name);
const interruptListener = (signal: "SIGINT" | "SIGTERM", before: readonly unknown[]) =>
  process.listeners(signal).find((l) => !before.includes(l));

beforeEach(() => {
  fake.params = undefined;
  fake.pid = 4242;
  fake.stderrChunks = [];
  fake.stderrHandlers = [];
  fake.connect = () => Promise.resolve();
  fake.call = () => Promise.resolve(okReply);
  fake.requests = [];
  fake.callOptions = [];
  fake.connectOptions = undefined;
  fake.closed = 0;
});

afterEach(() => vi.restoreAllMocks());

describe("runSmoke against a fake server", () => {
  it("opens an incognito session, takes a snapshot, and closes it", async () => {
    const res = await runSmoke({ distCli: DIST_CLI });
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/^ok: first snapshot in \d+ ms$/);
    expect(fake.requests).toEqual([
      { name: "open_session", arguments: { session: "init-smoke", mode: "incognito" } },
      { name: "snapshot", arguments: { session: "init-smoke" } },
      { name: "close_session", arguments: { session: "init-smoke" } },
    ]);
    expect(fake.closed).toBe(1);
  });

  it("starts the built cli with a headless, minimal environment", async () => {
    await runSmoke({ distCli: DIST_CLI });
    expect(fake.params?.command).toBe(process.execPath);
    expect(fake.params?.args).toEqual([DIST_CLI]);
    expect(fake.params?.env).toEqual({
      BROWX_WORKSPACE: expect.any(String),
      BROWX_HEADLESS: "1",
    });
  });

  it("removes its temp workspace and its signal listeners", async () => {
    const before = [...process.listeners("SIGINT"), ...process.listeners("SIGTERM")];
    await runSmoke({ distCli: DIST_CLI });
    expect(existsSync(fake.params!.env.BROWX_WORKSPACE!)).toBe(false);
    expect([...process.listeners("SIGINT"), ...process.listeners("SIGTERM")]).toEqual(before);
  });

  it("gives connect and every call the same timeout, 60 s by default", async () => {
    await runSmoke({ distCli: DIST_CLI });
    expect(fake.connectOptions).toEqual({ timeout: 60_000 });
    expect(fake.callOptions).toEqual([
      { timeout: 60_000 },
      { timeout: 60_000 },
      { timeout: 60_000 },
    ]);
    fake.requests = [];
    fake.callOptions = [];
    await runSmoke({ distCli: DIST_CLI, timeoutMs: 1234 });
    expect(fake.connectOptions).toEqual({ timeout: 1234 });
    expect(fake.callOptions).toEqual([{ timeout: 1234 }, { timeout: 1234 }, { timeout: 1234 }]);
  });

  it("still passes when closing the session fails", async () => {
    fake.call = (req) =>
      req.name === "close_session" ? Promise.reject(new Error("gone")) : Promise.resolve(okReply);
    const res = await runSmoke({ distCli: DIST_CLI });
    expect(res.ok).toBe(true);
  });

  it("names the first stderr line when the server does not start", async () => {
    fake.stderrChunks = ["\n  Error: Cannot find module 'x'\n    at load (a.js:1)\n"];
    fake.connect = () => Promise.reject(new Error("Connection closed"));
    const res = await runSmoke({ distCli: DIST_CLI });
    expect(res).toEqual({
      ok: false,
      message: `error: the server did not start (Error: Cannot find module 'x'). ${NEXT}`,
    });
    expect(fake.requests).toEqual([]);
    expect(fake.closed).toBe(1);
    expect(existsSync(fake.params!.env.BROWX_WORKSPACE!)).toBe(false);
  });

  it("falls back to the connect error when the server printed nothing", async () => {
    fake.connect = () => Promise.reject(new Error("spawn ENOENT\nmore"));
    const res = await runSmoke({ distCli: DIST_CLI });
    expect(res.message).toBe(`error: the server did not start (spawn ENOENT). ${NEXT}`);
  });

  it("explains a session that would not open because the browser is missing", async () => {
    fake.call = () =>
      Promise.resolve(
        jsonReply({ ok: false, error: "No browser found.", hint: "Run npx playwright install" }),
      );
    const res = await runSmoke({ distCli: DIST_CLI });
    expect(res.ok).toBe(false);
    expect(res.message).toBe(
      `error: could not open a browser session: No browser found. Run npx playwright install. ${NEXT}`,
    );
    expect(names()).toEqual(["open_session"]);
  });

  it("reports an error result from open_session by its first line", async () => {
    fake.call = () => Promise.resolve(textReply("Launch failed\n    at stack"));
    const res = await runSmoke({ distCli: DIST_CLI });
    expect(res.message).toBe(`error: could not open a browser session: Launch failed ${NEXT}`);
    expect(names()).toEqual(["open_session"]);
  });

  it("says there is no detail when the server gives none", async () => {
    fake.call = () => Promise.resolve({ isError: true, content: [] });
    const res = await runSmoke({ distCli: DIST_CLI });
    expect(res.message).toBe(
      `error: could not open a browser session: no detail from the server. ${NEXT}`,
    );
  });

  it("reports a failed snapshot and still closes the session", async () => {
    fake.call = (req) =>
      Promise.resolve(
        req.name === "snapshot" ? jsonReply({ ok: false, error: "Page crashed" }) : okReply,
      );
    const res = await runSmoke({ distCli: DIST_CLI });
    expect(res).toEqual({
      ok: false,
      message: `error: the snapshot failed: Page crashed. ${NEXT}`,
    });
    expect(names()).toEqual(["open_session", "snapshot", "close_session"]);
  });

  it("reports a call that times out, and still closes the session", async () => {
    fake.call = (req) =>
      req.name === "snapshot"
        ? Promise.reject(new Error("MCP error -32001: Request timed out"))
        : Promise.resolve(okReply);
    const res = await runSmoke({ distCli: DIST_CLI });
    expect(res).toEqual({
      ok: false,
      message: `error: MCP error -32001: Request timed out. ${NEXT}`,
    });
    expect(names()).toEqual(["open_session", "snapshot", "close_session"]);
    expect(fake.closed).toBe(1);
  });

  it("reports a server that dies while the session opens", async () => {
    fake.call = () => Promise.reject(new Error("MCP error -32000: Connection closed"));
    const res = await runSmoke({ distCli: DIST_CLI });
    expect(res.message).toBe(`error: MCP error -32000: Connection closed. ${NEXT}`);
    expect(names()).toEqual(["open_session"]);
    expect(existsSync(fake.params!.env.BROWX_WORKSPACE!)).toBe(false);
  });

  it("cuts a long error to 300 characters", async () => {
    fake.call = () => Promise.reject(new Error("x".repeat(500)));
    const res = await runSmoke({ distCli: DIST_CLI });
    expect(res.message).toContain(`error: ${"x".repeat(300)}. `);
    expect(res.message).not.toContain("x".repeat(301));
  });
});

describe("runSmoke on Ctrl+C", () => {
  let exit: MockInstance<typeof process.exit>;
  let kill: MockInstance<typeof process.kill>;

  beforeEach(() => {
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "on %s stops the server, removes the workspace and exits %i",
    async (signal, code) => {
      const before = process.listeners(signal);
      let removed: boolean | undefined;
      fake.call = (req) => {
        if (req.name === "open_session") {
          interruptListener(signal, before)!(signal);
          removed = !existsSync(fake.params!.env.BROWX_WORKSPACE!);
        }
        return Promise.resolve(okReply);
      };
      await runSmoke({ distCli: DIST_CLI });
      expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
      expect(removed).toBe(true);
      expect(exit).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(code);
    },
  );

  it("does not signal a server that has no pid yet", async () => {
    fake.pid = null;
    const before = process.listeners("SIGINT");
    fake.call = () => {
      interruptListener("SIGINT", before)!("SIGINT");
      return Promise.resolve(okReply);
    };
    await runSmoke({ distCli: DIST_CLI });
    expect(kill).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("exits even when the server is already gone", async () => {
    kill.mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    });
    const before = process.listeners("SIGINT");
    fake.call = () => {
      interruptListener("SIGINT", before)!("SIGINT");
      return Promise.resolve(okReply);
    };
    await runSmoke({ distCli: DIST_CLI });
    expect(exit).toHaveBeenCalledWith(130);
  });
});
