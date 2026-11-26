// A tool's input schema holds on every transport. The MCP SDK parses a
// `tools/call` before dispatch; the in-process SDK and `batch` call the handler
// directly, so the `register` wrapper parses again. No browser: `approve_actions`
// and `close_session` need no page.

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
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-sdk-input-"));
  process.env.BROWX_WORKSPACE = workspace;
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human,self-approval";
  // The client admits `eval` so the server's own gate is what answers `eval_js`.
  client = await createBrowxai({
    capabilities: ["read", "navigation", "action", "human", "self-approval", "eval"],
  });
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  delete process.env.BROWX_CAPABILITIES;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  rmSync(workspace, { recursive: true, force: true });
});

interface Refused {
  ok: boolean;
  error: string;
}

describe("in-process SDK: arguments outside the schema are refused", () => {
  it("refuses a ttlSeconds over the 24 hour cap", async () => {
    const r = await client.callTool<Refused>("approve_actions", {
      scopes: ["byob_action"],
      ttlSeconds: 7 * 24 * 60 * 60,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^approve_actions: the arguments do not match/);
    expect(r.error).toContain("ttlSeconds");
  });

  it("refuses a wrong-typed argument", async () => {
    const r = await client.callTool<Refused>("approve_actions", { scopes: "byob_action" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("scopes");
  });

  it("refuses native_device_app: a person approves each app on a phone", async () => {
    const r = await client.callTool<Refused>("approve_actions", {
      scopes: ["native_device_app"],
      ttlSeconds: 60,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^approve_actions: the arguments do not match/);
  });

  it("runs a call inside the schema", async () => {
    const r = await client.callTool<{ ok: boolean }>("approve_actions", {
      scopes: ["byob_action"],
      ttlSeconds: 60,
    });
    expect(r.ok).toBe(true);
  });

  it("drops a key the schema does not name, as the MCP SDK does", async () => {
    const r = await client.callTool<Record<string, unknown>>("close_session", {
      session: "input-probe",
      notAnArgument: true,
    });
    expect(r).toEqual({ ok: true, session: "input-probe", wasOpen: false });
  });
});

describe("batch: an inner call outside the schema is refused", () => {
  it("refuses an over-cap ttlSeconds and a wrong-typed argument, and runs the rest", async () => {
    const r = await client.callTool<{
      results: Array<{ ok: boolean; result: Partial<Refused> }>;
    }>("batch", {
      calls: [
        { tool: "approve_actions", args: { scopes: ["byob_action"], ttlSeconds: 86_401 } },
        { tool: "approve_actions", args: { scopes: [42] } },
        { tool: "approve_actions", args: { scopes: ["byob_action"], ttlSeconds: 60 } },
      ],
      stopOnError: false,
    });
    expect(r.results.map((x) => x.ok)).toEqual([false, false, true]);
    expect(r.results[0]!.result.error).toContain("ttlSeconds");
    expect(r.results[1]!.result.error).toContain("scopes");
  });
});

describe("a tool whose capability is off", () => {
  it("answers with the gate refusal whatever the arguments", async () => {
    const r = await client.callTool<{ ok: boolean; requiredCapability?: string }>("eval_js", {
      notTheSchema: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.requiredCapability).toBe("eval");
  });
});
