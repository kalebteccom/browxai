// Approval and config gate keystone. Three ways an agent could widen its own
// posture, each closed by a gate that has to hold when nothing is set:
//
//   1. `approve_actions` answers the confirm hooks that exist to stop the
//      agent's own actions. It needs the off-by-default `self-approval`
//      capability and refuses without it.
//   2. `set_config({capabilities})` used to replace BROWX_CAPABILITIES from the
//      next start. A saved list now only narrows: `set_config` refuses a
//      widening patch, and a saved widening list (one written by an older
//      version) is clamped at start.
//   3. `BROWX_CONFIG_READONLY=1` leaves `set_config`, `reset_config` and
//      `approve_actions` out of tools/list entirely, checked over a real stdio
//      MCP connection.
//
// Plus `BROWX_DEFAULT_PROFILE`: the default session launches a real Chromium on
// the operator's directory, created 0700.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "../../src/server.js";

const KEYSTONE_TIMEOUT = 120_000;
const REPO = resolve(__dirname, "../..");

type Server_ = Awaited<ReturnType<typeof createServer>>;

let workspace: string;
const savedEnv: Record<string, string | undefined> = {};
const servers: Server_[] = [];

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-approval-gate-"));
  process.env.BROWX_WORKSPACE = workspace;
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.shutdown().catch(() => undefined);
  for (const k of Object.keys(process.env)) if (k.startsWith("BROWX_")) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  rmSync(workspace, { recursive: true, force: true });
});

async function start(): Promise<Server_> {
  const s = await createServer({ headless: true });
  servers.push(s);
  return s;
}

function caller(server: Server_) {
  return async <T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> => {
    const fn = server.handlers[name];
    if (!fn) throw new Error(`approval-gate keystone: no handler "${name}"`);
    const res = await fn(args);
    return JSON.parse((res.content[0] as { text: string }).text) as T;
  };
}

describe("self-approval gate", () => {
  it(
    "approve_actions refuses when self-approval is not granted, and grants nothing",
    async () => {
      const call = caller(await start());
      const denied = await call<{ ok: boolean; requiredCapability: string; error: string }>(
        "approve_actions",
        { scopes: ["byob_action", "navigate_off_allowlist"], ttlSeconds: 600 },
      );
      expect(denied.ok).toBe(false);
      expect(denied.requiredCapability).toBe("self-approval");
      expect(denied.error).toMatch(/capability is not in the server's ACTIVE set/);
      const listed = await call<{ approvals: unknown[] }>("list_approvals", {});
      expect(listed.approvals).toEqual([]);
      // The batch path reaches the same gate.
      const batched = await call<{ results: Array<{ ok: boolean }> }>("batch", {
        calls: [{ tool: "approve_actions", args: { scopes: ["byob_action"] } }],
      });
      expect(batched.results[0]!.ok).toBe(false);
      expect((await call<{ approvals: unknown[] }>("list_approvals", {})).approvals).toEqual([]);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "approve_actions grants when the operator enabled self-approval",
    async () => {
      process.env.BROWX_CAPABILITIES = "read,navigation,action,human,self-approval";
      const call = caller(await start());
      const granted = await call<{ ok: boolean; granted: string[] }>("approve_actions", {
        scopes: ["byob_action"],
        ttlSeconds: 30,
      });
      expect(granted.ok).toBe(true);
      const listed = await call<{ approvals: Array<{ scope: string }> }>("list_approvals", {});
      expect(listed.approvals.map((a) => a.scope)).toEqual(["byob_action"]);
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("capabilities cannot be widened through config", () => {
  it(
    "set_config refuses a widening capabilities patch and writes nothing",
    async () => {
      const call = caller(await start());
      const r = await call<{ ok: boolean; error: string; widening: string[] }>("set_config", {
        scope: "user",
        patch: { capabilities: ["read", "navigation", "action", "human", "eval", "self-approval"] },
      });
      expect(r.ok).toBe(false);
      expect(r.error).toBe("capabilities-not-widenable");
      expect(r.widening.sort()).toEqual(["eval", "self-approval"]);
      expect(existsSync(join(workspace, "config.json"))).toBe(false);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a narrowing patch is accepted and takes effect at the next start",
    async () => {
      const first = caller(await start());
      const r = await first<{ ok: boolean }>("set_config", {
        scope: "user",
        patch: { capabilities: ["read", "human"] },
      });
      expect(r.ok).toBe(true);
      const second = caller(await start());
      const nav = await second<{ ok: boolean; requiredCapability?: string }>("navigate", {
        url: "about:blank",
      });
      expect(nav.ok).toBe(false);
      expect(nav.requiredCapability).toBe("navigation");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a saved widening list from an older version is clamped at start",
    async () => {
      // What a v0.10.1 `set_config` could leave behind.
      writeFileSync(
        join(workspace, "config.json"),
        JSON.stringify({
          user: {
            capabilities: ["read", "navigation", "action", "human", "eval", "self-approval"],
          },
        }),
      );
      const call = caller(await start());
      const cfg = await call<{ config: { capabilities: string[] } }>("get_config", {});
      expect(cfg.config.capabilities).not.toContain("eval");
      expect(cfg.config.capabilities).not.toContain("self-approval");
      const ev = await call<{ ok: boolean; requiredCapability?: string }>("eval_js", {
        expression: "1+1",
      });
      expect(ev.ok).toBe(false);
      expect(ev.requiredCapability).toBe("eval");
      const ap = await call<{ ok: boolean; requiredCapability?: string }>("approve_actions", {
        scopes: ["byob_action"],
      });
      expect(ap.requiredCapability).toBe("self-approval");
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("other policy keys cannot be loosened through config", () => {
  const A = "http://127.0.0.1:9";
  const B = "http://localhost:9";

  /** True when `navigate` is still waiting on the human after `ms`: a confirm
   *  hook is holding it. A loosened policy lets it through (or fail) at once. */
  async function heldByHook(call: ReturnType<typeof caller>, url: string, ms = 2_500) {
    const p = call("navigate", { url });
    const r = await Promise.race([
      p.then(() => "settled" as const),
      new Promise<"held">((res) => setTimeout(() => res("held"), ms)),
    ]);
    p.catch(() => undefined);
    return r === "held";
  }

  it(
    "set_config refuses every loosening patch and writes nothing",
    async () => {
      process.env.BROWX_ALLOWED_ORIGINS = A;
      process.env.BROWX_BLOCKED_ORIGINS = B;
      const call = caller(await start());
      const patches: Array<[string, Record<string, unknown>]> = [
        ["confirmRequired", { confirmRequired: [] }],
        ["allowedOrigins", { allowedOrigins: [] }],
        ["allowedOrigins", { allowedOrigins: ["https://evil.example"] }],
        ["blockedOrigins", { blockedOrigins: [] }],
        ["disableWebSecurity", { disableWebSecurity: true }],
        ["plugins", { plugins: ["@browxai/plugin-example"] }],
      ];
      for (const [key, patch] of patches) {
        const r = await call<{ ok: boolean; error: string; loosening: Record<string, unknown> }>(
          "set_config",
          { scope: "user", patch },
        );
        expect(r.ok, key).toBe(false);
        expect(r.error).toBe("policy-not-loosenable");
        expect(Object.keys(r.loosening)).toEqual([key]);
      }
      expect(existsSync(join(workspace, "config.json"))).toBe(false);
      // Tightening still works.
      const ok = await call<{ ok: boolean }>("set_config", {
        scope: "user",
        patch: { confirmRequired: ["navigate_off_allowlist", "byob_action", "file_upload"] },
      });
      expect(ok.ok).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a saved layer that loosens every key is clamped at start",
    async () => {
      process.env.BROWX_ALLOWED_ORIGINS = A;
      process.env.BROWX_BLOCKED_ORIGINS = "http://blocked.invalid";
      writeFileSync(
        join(workspace, "config.json"),
        JSON.stringify({
          user: {
            confirmRequired: [],
            allowedOrigins: [],
            blockedOrigins: [],
            disableWebSecurity: true,
            plugins: ["@browxai/plugin-example"],
          },
        }),
      );
      const server = await start();
      const call = caller(server);
      const cfg = await call<{
        config: {
          confirmRequired: string[];
          allowedOrigins: string[];
          blockedOrigins: string[];
          disableWebSecurity?: boolean;
          plugins: string[];
        };
      }>("get_config", {});
      expect(cfg.config.confirmRequired).toEqual(
        expect.arrayContaining(["navigate_off_allowlist", "byob_action"]),
      );
      expect(cfg.config.allowedOrigins).toEqual([A]);
      expect(cfg.config.blockedOrigins).toEqual(["http://blocked.invalid"]);
      expect(cfg.config.disableWebSecurity).toBeUndefined();
      expect(cfg.config.plugins).toEqual([]);
      const listed = await call<{ plugins: unknown[] }>("plugins_list", {});
      expect(listed.plugins).toEqual([]);
      // Behaviour, not just the view: the allowlist and its confirm hook still
      // hold an off-allowlist navigation for the human.
      expect(await heldByHook(call, B)).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a saved blockedOrigins: [] does not unblock an env-blocked origin",
    async () => {
      process.env.BROWX_BLOCKED_ORIGINS = B;
      writeFileSync(
        join(workspace, "config.json"),
        JSON.stringify({ user: { blockedOrigins: [], confirmRequired: [] } }),
      );
      const call = caller(await start());
      expect(await heldByHook(call, B)).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("operator files cannot be overwritten by write tools", () => {
  it(
    "pdf_save and dom_export refuse the config store, plugin files and profiles",
    async () => {
      process.env.BROWX_CAPABILITIES = "read,navigation,action,human,file-io";
      const call = caller(await start());
      const saved = await call<{ ok: boolean }>("set_config", {
        scope: "user",
        patch: { confirmRequired: ["navigate_off_allowlist", "byob_action", "file_upload"] },
      });
      expect(saved.ok).toBe(true);
      const before = readFileSync(join(workspace, "config.json"), "utf8");
      await call("navigate", { url: "data:text/html,<p>x</p>" });
      for (const path of ["config.json", "CONFIG.json", "./sub/../config.json"]) {
        const r = await call<{ ok: boolean; error?: string }>("pdf_save", { path });
        expect(r.ok, path).toBe(false);
        expect(r.error).toMatch(/refusing to write/);
      }
      for (const path of [
        "plugins.json",
        "plugins/x.html",
        "profile/x.html",
        "profiles/a/x.html",
      ]) {
        const r = await call<{ ok: boolean; error?: string }>("dom_export", { path });
        expect(r.ok, path).toBe(false);
        expect(r.error).toMatch(/refusing to write/);
      }
      expect(readFileSync(join(workspace, "config.json"), "utf8")).toBe(before);
      expect(existsSync(join(workspace, "plugins.json"))).toBe(false);
      // An ordinary path still works.
      const ok = await call<{ ok: boolean }>("dom_export", { path: "dumps/x.html" });
      expect(ok.ok).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a malformed config.json fails the server start",
    async () => {
      writeFileSync(join(workspace, "config.json"), "%PDF-1.7 not json");
      await expect(createServer({ headless: true })).rejects.toThrow(/config\.json is malformed/);
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("BROWX_CONFIG_READONLY", () => {
  const HIDDEN = ["set_config", "reset_config", "approve_actions"];

  async function listTools(env: Record<string, string>): Promise<string[]> {
    const transport = new StdioClientTransport({
      command: join(REPO, "node_modules/.bin/tsx"),
      args: [join(REPO, "src/cli.ts")],
      cwd: REPO,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      stderr: "ignore",
    });
    const client = new Client({ name: "approval-gate-keystone", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name);
    } finally {
      await client.close();
    }
  }

  it(
    "tools/list omits set_config, reset_config and approve_actions under the flag",
    async () => {
      // self-approval is on, so approve_actions would otherwise be listed.
      const caps = "read,navigation,action,human,self-approval";
      const readonly = await listTools({
        BROWX_WORKSPACE: workspace,
        BROWX_CAPABILITIES: caps,
        BROWX_CONFIG_READONLY: "1",
      });
      for (const t of HIDDEN) expect(readonly, `${t} must be absent`).not.toContain(t);
      expect(readonly).toContain("get_config");
      expect(readonly).toContain("list_approvals");

      const normal = await listTools({ BROWX_WORKSPACE: workspace, BROWX_CAPABILITIES: caps });
      for (const t of HIDDEN) expect(normal, `${t} must be listed`).toContain(t);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "the in-process handler table matches, and batch cannot reach the hidden tools",
    async () => {
      process.env.BROWX_CONFIG_READONLY = "1";
      process.env.BROWX_CAPABILITIES = "read,navigation,action,human,self-approval";
      const server = await start();
      for (const t of HIDDEN) expect(server.handlers[t]).toBeUndefined();
      const call = caller(server);
      const batched = await call<{ results: Array<{ ok: boolean }> }>("batch", {
        calls: [{ tool: "approve_actions", args: { scopes: ["byob_action"] } }],
      });
      expect(batched.results[0]!.ok).toBe(false);
      expect((await call<{ approvals: unknown[] }>("list_approvals", {})).approvals).toEqual([]);
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("BROWX_DEFAULT_PROFILE", () => {
  it(
    "the default session launches on the operator's directory, created 0700",
    async () => {
      const outside = mkdtempSync(join(tmpdir(), "browx-default-profile-"));
      const profile = join(outside, "nested", "profile");
      try {
        process.env.BROWX_DEFAULT_PROFILE = profile;
        const call = caller(await start());
        // createServer validated and created it before any browser call.
        expect(statSync(profile).mode & 0o777).toBe(0o700);
        const nav = await call<{ ok: boolean }>("navigate", { url: "about:blank" });
        expect(nav.ok).toBe(true);
        expect(readdirSync(profile).length).toBeGreaterThan(0);
        expect(existsSync(join(workspace, "profile"))).toBe(false);
      } finally {
        for (const s of servers.splice(0)) await s.shutdown().catch(() => undefined);
        rmSync(outside, { recursive: true, force: true });
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a bad value fails the server start",
    async () => {
      process.env.BROWX_DEFAULT_PROFILE = "relative/profile";
      await expect(createServer({ headless: true })).rejects.toThrow(
        /BROWX_DEFAULT_PROFILE: must be an absolute path/,
      );
    },
    KEYSTONE_TIMEOUT,
  );
});
