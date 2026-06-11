// `client.plugins.<namespace>.<tool>(args)` proxy seam.
//
// The proxy is purely lexical — every namespaced access returns a
// function that routes through `callTool`. The function exists even
// when no plugin is loaded, and (correctly) surfaces an
// unknown-tool error at call time. This test verifies:
//   - the proxy responds to any namespace.tool access
//   - calling an unregistered plugin tool surfaces a clear error
//     (no silent undefined)

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  workspace = mkdtempSync(join(tmpdir(), "browx-sdk-plugins-"));
  process.env.BROWX_WORKSPACE = workspace;
  client = await createBrowxai();
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  rmSync(workspace, { recursive: true, force: true });
});

describe("client.plugins proxy", () => {
  it("exposes a namespaced caller", () => {
    expect(typeof client.plugins).toBe("object");
    expect(typeof client.plugins.figma).toBe("object");
    expect(typeof client.plugins.figma.moveNode).toBe("function");
  });

  it("calling an unregistered plugin tool surfaces a clear error", async () => {
    // No plugins loaded → the host's dispatch path emits an
    // unknown-tool error rather than silently failing.
    await expect(client.plugins.demo.does_not_exist({})).rejects.toThrow(/demo\.does_not_exist/);
  });
});
