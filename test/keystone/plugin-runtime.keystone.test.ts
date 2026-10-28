//  keystone — plugin runtime drives a real headless Chromium
// session through the actual MCP tool handlers, with a real example
// plugin loaded.
//
// Definition of done:
//   - example plugin's `example.echo({msg:"hi"})` returns `{ok:true, result:"hi"}`.
//   - the same call over a real stdio MCP connection (`client.callTool` with
//     arguments) reaches the handler with `{msg:"hi"}`: the SDK drops every
//     argument a tool's schema does not declare, and the in-process handler
//     table skips that step.
//   - example plugin's tools appear on `plugins_list` with status `loaded`.
//   - `plugins_info({name})` returns the full manifest dump.
//   - call-graph violation surfaces the structured error shape.
//   - `get_config({scope:"resolved"})` returns the live plugin set.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "../../src/server.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
let workspace: string;
const cwdBefore = process.cwd();
const REPO = join(__dirname, "..", "..");
const savedEnv: Record<string, string | undefined> = {};

async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const fn = handlers[name];
  if (!fn) throw new Error(`keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

beforeAll(async () => {
  // Strip BROWX_* env to zero — same posture as headless keystone.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browxai-plugin-keystone-"));
  process.env.BROWX_WORKSPACE = workspace;

  // Stage the @browxai/plugin-example package into
  // <workspace>/plugins/node_modules/. We copy the compiled output
  // from packages/plugins/example/dist/ — the keystone runs AFTER
  // `pnpm build` so dist/ is on disk.
  const sourceDir = join(__dirname, "..", "..", "packages", "plugins", "example");
  const targetDir = join(workspace, "plugins", "node_modules", "@browxai", "plugin-example");
  mkdirSync(join(workspace, "plugins", "node_modules", "@browxai"), {
    recursive: true,
  });
  mkdirSync(targetDir, { recursive: true });
  cpSync(join(sourceDir, "package.json"), join(targetDir, "package.json"));
  cpSync(join(sourceDir, "dist"), join(targetDir, "dist"), { recursive: true });

  // Declare it.
  writeFileSync(
    join(workspace, "plugins.json"),
    JSON.stringify({ plugins: ["@browxai/plugin-example"] }, null, 2),
  );

  server = await createServer({});
  handlers = server.handlers;
}, 120_000);

afterAll(async () => {
  await server?.shutdown?.();
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (process.cwd() !== cwdBefore) process.chdir(cwdBefore);
  rmSync(workspace, { recursive: true, force: true });
}, 120_000);

describe(" plugin runtime — keystone", () => {
  it("registers the example plugin's tools through MCP", async () => {
    const list = await callJson<{
      ok: boolean;
      plugins: Array<{ name: string; status: string; tools: string[]; namespace: string }>;
    }>("plugins_list", {});
    expect(list.ok).toBe(true);
    const ex = list.plugins.find((p) => p.name === "@browxai/plugin-example");
    expect(ex).toBeDefined();
    expect(ex?.status).toBe("loaded");
    expect(ex?.namespace).toBe("example");
    expect(ex?.tools.sort()).toEqual(["example.add", "example.echo", "example.now"]);
  });

  it("dispatches example.echo end-to-end", async () => {
    const res = await callJson<{ ok: boolean; result: string }>("example.echo", {
      msg: "hi",
    });
    expect(res.ok).toBe(true);
    expect(res.result).toBe("hi");
  });

  it("plugins_info returns the full manifest dump", async () => {
    const info = await callJson<{
      ok: boolean;
      name: string;
      namespace: string;
      apiVersion: string;
      tools: Array<{ name: string }>;
    }>("plugins_info", { name: "@browxai/plugin-example" });
    expect(info.ok).toBe(true);
    expect(info.namespace).toBe("example");
    expect(info.apiVersion).toBe("1.0.0");
    expect(info.tools.length).toBe(3);
  });

  it("get_config({scope:'resolved'}) reports the live plugin set", async () => {
    const cfg = await callJson<{
      scope: string;
      config: { plugins: string[] };
    }>("get_config", {});
    expect(cfg.scope).toBe("resolved");
    expect(cfg.config.plugins).toContain("@browxai/plugin-example");
  });

  it("delivers arguments to plugin tools over a real MCP connection", async () => {
    const transport = new StdioClientTransport({
      command: join(REPO, "node_modules/.bin/tsx"),
      args: [join(REPO, "src/cli.ts")],
      cwd: REPO,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        BROWX_WORKSPACE: workspace,
      },
      stderr: "ignore",
    });
    const client = new Client({ name: "plugin-runtime-keystone", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const echoTool = tools.find((t) => t.name === "example.echo");
      expect(echoTool?.inputSchema.properties).toHaveProperty("msg");

      const echo = await client.callTool({ name: "example.echo", arguments: { msg: "hi" } });
      const echoText = (echo.content as Array<{ text: string }>)[0]!.text;
      expect(JSON.parse(echoText)).toEqual({ ok: true, result: "hi" });

      const add = await client.callTool({ name: "example.add", arguments: { a: 2, b: 3 } });
      const addText = (add.content as Array<{ text: string }>)[0]!.text;
      expect(JSON.parse(addText)).toEqual({ ok: true, sum: 5 });
    } finally {
      await client.close();
    }
  }, 120_000);
});
