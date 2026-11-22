// In-process transport hermetic test — drives the actual MCP handlers
// without a browser by only calling tools that do not require a live page:
// `list_sessions` is a pure registry-read. This proves the in-process
// transport reaches the same `handlers` map the keystone uses and that the
// SDK result is the tool's own result, unwrapped.
//
// A real-browser keystone covers the full navigate → find → click → extract
// → screenshot roundtrip (see test/keystone/sdk.keystone.test.ts).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowxai } from "../../src/sdk/index.js";
import type { BrowxaiClient } from "../../src/sdk/types.js";

let client: BrowxaiClient;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // Strip BROWX_* so the test inherits zero ambient policy (mirrors the
  // hermeticity discipline of the keystone).
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-sdk-"));
  process.env.BROWX_WORKSPACE = workspace;
  client = await createBrowxai();
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  rmSync(workspace, { recursive: true, force: true });
});

describe("in-process SDK transport — drives the real MCP handler registry", () => {
  it("list_sessions resolves to the tool's own result, with no envelope around it", async () => {
    const r = await client.list_sessions();
    // The MCP handler returns one JSON text item. The SDK parses it, so the
    // result IS the tool's object: no `content`, no `data` wrapper.
    expect(r).toEqual({ sessions: [] });
    expect(r).not.toHaveProperty("content");
    expect(r).not.toHaveProperty("data");
  });

  it("close_session resolves to its own { ok, session, wasOpen } object", async () => {
    // `close_session` echoes the id for a session that was never opened, and
    // needs no browser.
    const r = await client.close_session({ session: "in-proc-probe" });
    expect(r).toEqual({ ok: true, session: "in-proc-probe", wasOpen: false });
  });

  it("callTool resolves the same way and takes the result type as an argument", async () => {
    const r = await client.callTool<{ sessions: unknown[] }>("list_sessions");
    expect(r.sessions).toEqual([]);
  });

  it("close() ends the embedded server cleanly", async () => {
    const tmp = await createBrowxai();
    // Hits the same handler map, prove dispatch works …
    const r = await tmp.list_sessions();
    expect(r.sessions).toBeDefined();
    // … then close + assert idempotency.
    await tmp.close();
    await tmp.close();
    // dispatch after close throws
    let err: unknown = null;
    try {
      await tmp.list_sessions();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
  });
});
