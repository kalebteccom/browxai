// Bridge keystone: an MCP client whose server is `browxai bridge`, started as a stdio
// child, drives a real headless Chromium that a `serve --socket` daemon owns.
//
// Covered:
//   - open a session, navigate, snapshot, click by a ref from the snapshot, verify
//   - a gated tool is refused with the envelope a direct socket client gets and the one
//     the stdio server returns
//   - the daemon restarts under the running bridge: the client needs no restart, the
//     sessions are gone, and a ref from before the restart no longer resolves
//
// Skipped on Windows: the daemon test relies on POSIX socket file semantics.

import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startServeForTests } from "../../src/cli/serve.js";
import { connectSocketClient } from "../../src/sdk/transport-socket.js";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";
import { gatedDescribe, hostGate } from "./keystone-gate.js";

const KEYSTONE_TIMEOUT = 120_000;
const REPO = join(__dirname, "..", "..");
const SESSION = "bridge-ks";
const skipIfWindows = gatedDescribe(
  hostGate(process.platform !== "win32", "the daemon socket is a Unix domain socket"),
);

let fixture: Fixture;
let workspace: string;
let socketPath: string;
let serveHandle: Awaited<ReturnType<typeof startServeForTests>>;
let client: Client;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_") && k !== "BROWX_CHANNEL") {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-bridge-ks-"));
  process.env.BROWX_WORKSPACE = workspace;
  socketPath = join(workspace, "browxai.sock");
  fixture = await startFixture();
  serveHandle = await startServeForTests({ socketPath, headless: true });
  // The bridge gets the socket and nothing else: no workspace, no capability list.
  client = new Client({ name: "bridge-keystone", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: join(REPO, "node_modules/.bin/tsx"),
      args: [join(REPO, "src/cli.ts"), "bridge", "--socket", socketPath],
      cwd: REPO,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stderr: "ignore",
    }),
  );
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await serveHandle?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

type Json = Record<string, unknown>;

/** The first text item of a tool result. */
const textOf = (res: { content?: unknown }): string =>
  (res.content as Array<{ type: string; text?: string }>).find((i) => i.type === "text")?.text ??
  "";

const call = async (via: Client, name: string, args: Json): Promise<string> =>
  textOf(await via.callTool({ name, arguments: args }));

const callJson = async (via: Client, name: string, args: Json): Promise<Json> =>
  JSON.parse(await call(via, name, args)) as Json;

async function openSession(): Promise<void> {
  const opened = await callJson(client, "open_session", { session: SESSION, mode: "incognito" });
  expect(opened.ok).toBe(true);
}

/** Load the fixture page in the open session and return the Save button's ref. */
async function findSave(): Promise<string> {
  const nav = await callJson(client, "navigate", { session: SESSION, url: `${fixture.url}/` });
  expect(nav.ok).toBe(true);
  const tree = await call(client, "snapshot", { session: SESSION });
  expect(tree).toContain('[data-testid="save-btn"]');
  const line = tree.split("\n").find((l) => l.includes("save-btn")) ?? "";
  const ref = /\[ref=(e\d+)\]/.exec(line)?.[1];
  expect(ref, `no ref on the Save button line: ${line}`).toBeDefined();
  return ref!;
}

/** Whether a tool call failed: an error result, or an envelope with `ok` false. */
async function failed(name: string, args: Json): Promise<boolean> {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError === true) return true;
  try {
    return (JSON.parse(textOf(res)) as Json).ok === false;
  } catch {
    return false;
  }
}

skipIfWindows("an MCP client drives a real browser through browxai bridge", () => {
  let refBeforeRestart: string;

  it(
    "opens a session, snapshots, clicks by a ref from the snapshot, and verifies",
    async () => {
      await openSession();
      refBeforeRestart = await findSave();
      const clicked = await callJson(client, "click", { session: SESSION, ref: refBeforeRestart });
      expect(clicked.ok).toBe(true);
      const verified = await callJson(client, "verify_text", {
        session: SESSION,
        selector: '[data-testid="saved-state"]',
        text: "Saved OK",
      });
      expect(verified.ok).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "lists the daemon's sessions, which a direct socket client sees too",
    async () => {
      const direct = await connectSocketClient(socketPath);
      try {
        const viaBridge = await callJson(client, "list_sessions", {});
        const viaSocket = await callJson(direct, "list_sessions", {});
        expect(JSON.stringify(viaBridge.sessions)).toContain(SESSION);
        expect(JSON.stringify(viaSocket.sessions)).toContain(SESSION);
      } finally {
        await direct.close().catch(() => undefined);
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "refuses a gated tool as a direct socket client and the stdio server see it, and the page is untouched",
    async () => {
      const args = { session: SESSION, expr: "document.title = 'changed by eval'" };
      const viaBridge = await callJson(client, "eval_js", args);
      expect(viaBridge.ok).toBe(false);
      expect(viaBridge.requiredCapability).toBe("eval");

      const direct = await connectSocketClient(socketPath);
      try {
        expect(viaBridge).toEqual(await callJson(direct, "eval_js", args));
      } finally {
        await direct.close().catch(() => undefined);
      }

      const server = await createServer({ headless: true });
      const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
      await server.start(serverEnd);
      const overStdio = new Client({ name: "bridge-keystone", version: "0" });
      await overStdio.connect(clientEnd);
      try {
        expect(viaBridge).toEqual(await callJson(overStdio, "eval_js", args));
      } finally {
        await overStdio.close();
        await server.shutdown();
      }

      const verified = await callJson(client, "verify_text", {
        session: SESSION,
        selector: '[data-testid="saved-state"]',
        text: "Saved OK",
      });
      expect(verified.ok).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "carries on after the daemon restarts, with the old sessions and refs gone",
    async () => {
      await serveHandle.shutdown();
      serveHandle = await startServeForTests({ socketPath, headless: true });

      // The bridge reconnects by itself. Until it has, a call is answered with an error.
      const deadline = Date.now() + 60_000;
      let sessions: Json | undefined;
      // cap: ends at `deadline`.
      while (sessions === undefined) {
        sessions = await callJson(client, "list_sessions", {}).catch(() => undefined);
        if (sessions === undefined) {
          expect(Date.now(), "the bridge never reached the restarted daemon").toBeLessThan(
            deadline,
          );
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      expect(JSON.stringify(sessions)).not.toContain(SESSION);

      // The same session id opens a new, empty session, and the old ref means nothing
      // in it. This runs before any new snapshot, which would hand out the same ref ids.
      await openSession();
      expect(
        await failed("click", { session: SESSION, ref: refBeforeRestart, timeoutMs: 1500 }),
      ).toBe(true);

      // A new snapshot gives refs that work.
      const ref = await findSave();
      const clicked = await callJson(client, "click", { session: SESSION, ref });
      expect(clicked.ok).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "closes the session",
    async () => {
      const closed = await callJson(client, "close_session", { session: SESSION });
      expect(closed.ok).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );
});
