// Socket-transport hermetic test — spins up `startServeForTests` against a
// throwaway Unix socket path, attaches a SDK client via the `socket`
// transport, and asserts list_sessions roundtrips through the socket wire.
//
// Skipped on Windows: the test relies on POSIX socket file semantics.
//
// This is the smallest end-to-end exercise of the multi-client scenario
// wrightxai's loop refactor will lean on: server-side `browxai serve` +
// SDK-side `createBrowxai({ endpoint: "unix://..." })`.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowxai } from "../../src/sdk/index.js";
import { startServeForTests } from "../../src/cli/serve.js";
import type { BrowxaiClient } from "../../src/sdk/types.js";

const skipIfWindows = process.platform === "win32" ? describe.skip : describe;

let workspace: string;
let socketPath: string;
let serveHandle: Awaited<ReturnType<typeof startServeForTests>>;
let client: BrowxaiClient;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-sdk-socket-"));
  process.env.BROWX_WORKSPACE = workspace;
  socketPath = join(workspace, "browxai.sock");
  serveHandle = await startServeForTests({ socketPath });
  client = await createBrowxai({ endpoint: `unix://${socketPath}` });
}, 30_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await serveHandle?.shutdown().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  rmSync(workspace, { recursive: true, force: true });
}, 30_000);

skipIfWindows("socket-attached SDK transport — drives browxai serve over Unix socket", () => {
  it("list_sessions roundtrips over the wire", async () => {
    const r = await client.list_sessions();
    expect(r.content.length).toBeGreaterThan(0);
    // The MCP wire returns the same JSON envelope as the in-process path.
    expect(r.data).toBeDefined();
  });

  it("the exposed-tools surface is identical to the in-process default", () => {
    expect(client.exposedTools).toContain("navigate");
    expect(client.exposedTools).toContain("snapshot");
    expect(client.exposedTools).not.toContain("eval_js");
  });

  it("forwards tool ARGUMENTS over the wire (regression: must not strip args)", async () => {
    // The socket serve once re-registered tools with an EMPTY input schema,
    // which made the MCP layer strip every argument before the handler ran —
    // so e.g. `navigate` reached its handler with no `url` and hung the call.
    // A distinctive argument must survive the round-trip: open a named session
    // and assert it shows up in list_sessions (the name is a forwarded arg).
    await client.open_session({ session: "sock-arg-probe", mode: "incognito" });
    const r = await client.list_sessions();
    const text = JSON.stringify(r.data);
    expect(text).toContain("sock-arg-probe");
    await client.close_session({ session: "sock-arg-probe" }).catch(() => undefined);
  });
});
