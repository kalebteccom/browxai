// Phase 8 keystone — plugin runtime drives a real headless Chromium
// session through the actual MCP tool handlers, with a real example
// plugin loaded.
//
// Definition of done:
//   - example plugin's `example.echo({msg:"hi"})` returns `{ok:true, result:"hi"}`.
//   - example plugin's tools appear on `plugins_list` with status `loaded`.
//   - `plugins_info({name})` returns the full manifest dump.
//   - call-graph violation surfaces the structured error shape.
//   - `get_config({scope:"resolved"})` returns the live plugin set.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
let workspace: string;
const cwdBefore = process.cwd();
let savedEnv: Record<string, string | undefined> = {};

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

  // Stage the @kalebtec/browxai-plugin-example package into
  // <workspace>/plugins/node_modules/. We copy the compiled output
  // from packages/plugins/example/dist/ — the keystone runs AFTER
  // `pnpm build` so dist/ is on disk.
  const sourceDir = join(__dirname, "..", "..", "packages", "plugins", "example");
  const targetDir = join(
    workspace,
    "plugins",
    "node_modules",
    "@kalebtec",
    "browxai-plugin-example",
  );
  mkdirSync(join(workspace, "plugins", "node_modules", "@kalebtec"), {
    recursive: true,
  });
  mkdirSync(targetDir, { recursive: true });
  cpSync(join(sourceDir, "package.json"), join(targetDir, "package.json"));
  cpSync(join(sourceDir, "dist"), join(targetDir, "dist"), { recursive: true });

  // Declare it.
  writeFileSync(
    join(workspace, "plugins.json"),
    JSON.stringify({ plugins: ["@kalebtec/browxai-plugin-example"] }, null, 2),
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

describe("Phase 8 plugin runtime — keystone", () => {
  it("registers the example plugin's tools through MCP", async () => {
    const list = await callJson<{
      ok: boolean;
      plugins: Array<{ name: string; status: string; tools: string[]; namespace: string }>;
    }>("plugins_list", {});
    expect(list.ok).toBe(true);
    const ex = list.plugins.find((p) => p.name === "@kalebtec/browxai-plugin-example");
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

  it("dispatches example.add", async () => {
    const res = await callJson<{ ok: boolean; sum: number }>("example.add", {
      a: 7,
      b: 5,
    });
    expect(res.ok).toBe(true);
    expect(res.sum).toBe(12);
  });

  it("plugins_info returns the full manifest dump", async () => {
    const info = await callJson<{
      ok: boolean;
      name: string;
      namespace: string;
      apiVersion: string;
      tools: Array<{ name: string }>;
    }>("plugins_info", { name: "@kalebtec/browxai-plugin-example" });
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
    expect(cfg.config.plugins).toContain("@kalebtec/browxai-plugin-example");
  });
});
