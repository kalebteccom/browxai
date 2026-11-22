// Keystone: the `core` tool profile keeps plugin tools listed.
//
// The example plugin is staged into a hermetic workspace the way the plugin runtime
// keystone does it (this lane runs after `pnpm build`, so its `dist/` is on disk).
// With `BROWX_TOOL_PROFILE=core`, `tools/list` holds the core set, the discovery
// tool and all three `example.*` tools, and an `example.*` call still runs.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { CORE_TOOLS, TOOL_CATALOG_TOOL } from "../../src/util/tool-profile.js";

let server: Awaited<ReturnType<typeof createServer>>;
let client: Client;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browxai-core-profile-plugin-"));
  process.env.BROWX_WORKSPACE = workspace;
  process.env.BROWX_TOOL_PROFILE = "core";

  const sourceDir = join(__dirname, "..", "..", "packages", "plugins", "example");
  const targetDir = join(workspace, "plugins", "node_modules", "@browxai", "plugin-example");
  mkdirSync(targetDir, { recursive: true });
  cpSync(join(sourceDir, "package.json"), join(targetDir, "package.json"));
  cpSync(join(sourceDir, "dist"), join(targetDir, "dist"), { recursive: true });
  writeFileSync(
    join(workspace, "plugins.json"),
    JSON.stringify({ plugins: ["@browxai/plugin-example"] }, null, 2),
  );

  server = await createServer({});
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.start(serverEnd);
  client = new Client({ name: "core-profile-plugin", version: "0" });
  await client.connect(clientEnd);
}, 120_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await server?.shutdown?.();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) delete process.env[k];
  }
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
  }
  rmSync(workspace, { recursive: true, force: true });
}, 120_000);

describe("core tool profile with a plugin loaded", () => {
  it("lists the core set, the discovery tool and every plugin tool", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    const plugin = ["example.add", "example.echo", "example.now"];
    expect(names).toEqual([...CORE_TOOLS, TOOL_CATALOG_TOOL, ...plugin].sort());
    expect(names).toHaveLength(CORE_TOOLS.length + plugin.length + 1);
  });

  it("runs a plugin tool by name", async () => {
    const res = await client.callTool({ name: "example.echo", arguments: { msg: "hi" } });
    const first = (res.content as Array<{ type: string; text?: string }>)[0];
    const body = JSON.parse(first?.type === "text" ? (first.text ?? "{}") : "{}") as {
      ok: boolean;
      result: string;
    };
    expect(body.ok).toBe(true);
    expect(body.result).toBe("hi");
  });

  it("leaves plugin tools out of the discovery tool, since they are listed", async () => {
    const res = await client.callTool({ name: TOOL_CATALOG_TOOL, arguments: {} });
    const first = (res.content as Array<{ type: string; text?: string }>)[0];
    expect(first?.type === "text" ? first.text : "").not.toContain("example.echo");
  });
});
