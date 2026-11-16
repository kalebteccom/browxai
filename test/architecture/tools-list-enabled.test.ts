// The `toolList` config key: `tools/list` reports every tool by default, and only
// the tools the server can run when it is `enabled`.
//
// Each case builds a real server in a hermetic workspace and talks to it over an
// in-memory MCP transport, so the assertions cover the wire listing and a call by
// name through the same server. Nothing here opens a browser: the tools called are
// refused by the capability gate before a session exists.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";

type Server = Awaited<ReturnType<typeof createServer>>;

const DEFAULTS = "read,navigation,action,human";
const opened: Array<{ server: Server; client: Client }> = [];

/** A connected server + client. The env only matters while `createServer` reads it. */
async function connect(env: { toolList?: string; capabilities?: string }) {
  const keys = ["BROWX_TOOL_LIST", "BROWX_CAPABILITIES", "BROWX_WORKSPACE"] as const;
  const previous = keys.map((k) => process.env[k]);
  const set = (k: (typeof keys)[number], v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  set("BROWX_TOOL_LIST", env.toolList);
  set("BROWX_CAPABILITIES", env.capabilities);
  set("BROWX_WORKSPACE", mkdtempSync(join(tmpdir(), "browxai-tool-list-")));
  let server: Server;
  try {
    server = await createServer({ headless: true });
  } finally {
    keys.forEach((k, i) => set(k, previous[i]));
  }
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.start(serverEnd);
  const client = new Client({ name: "tool-list-test", version: "0" });
  await client.connect(clientEnd);
  opened.push({ server, client });
  return { server, client };
}

afterAll(async () => {
  for (const { server, client } of opened) {
    await client.close().catch(() => undefined);
    await server.shutdown().catch(() => undefined);
  }
});

const namesOf = (tools: Array<{ name: string }>) => tools.map((t) => t.name);

describe("toolList: all (the default)", () => {
  it("lists every registered tool, with or without the key set", async () => {
    const unset = await connect({ capabilities: DEFAULTS });
    const explicit = await connect({ toolList: "all", capabilities: DEFAULTS });
    const { tools } = await unset.client.listTools();
    const registered = Object.keys(unset.server.handlers);
    expect(namesOf(tools).sort()).toEqual([...registered].sort());
    expect(namesOf(tools)).toContain("eval_js");
    expect(namesOf(tools)).toContain("network_body");
    const explicitListing = await explicit.client.listTools();
    expect(namesOf(explicitListing.tools)).toEqual(namesOf(tools));
  });
});

describe("toolList: enabled", () => {
  it("leaves out tools whose capability is off, and keeps the ones that can run", async () => {
    const { client, server } = await connect({ toolList: "enabled", capabilities: DEFAULTS });
    const names = namesOf((await client.listTools()).tools);
    expect(names).not.toContain("eval_js");
    expect(names).not.toContain("poll_eval");
    expect(names).not.toContain("network_body");
    for (const kept of ["snapshot", "navigate", "click", "open_session", "get_config"]) {
      expect(names).toContain(kept);
    }
    for (const name of names) expect(server.isToolListed(name)).toBe(true);
  });

  it("brings a tool back when its capability is added to BROWX_CAPABILITIES", async () => {
    const { client } = await connect({ toolList: "enabled", capabilities: `${DEFAULTS},eval` });
    const names = namesOf((await client.listTools()).tools);
    expect(names).toContain("eval_js");
    expect(names).toContain("poll_eval");
    expect(names).not.toContain("network_body");
  });

  it("still refuses an unlisted tool called by name, with the same refusal and hint", async () => {
    const hidden = await connect({ toolList: "enabled", capabilities: DEFAULTS });
    const shown = await connect({ capabilities: DEFAULTS });
    expect(namesOf((await hidden.client.listTools()).tools)).not.toContain("eval_js");
    const call = (c: Client) => c.callTool({ name: "eval_js", arguments: { expr: "1 + 1" } });
    const refusal = await call(hidden.client);
    const baseline = await call(shown.client);
    expect(refusal.content).toEqual(baseline.content);
    const first = refusal.content[0];
    const body = JSON.parse(first?.type === "text" ? first.text : "{}") as {
      ok: boolean;
      requiredCapability: string;
      hint: string;
    };
    expect(body.ok).toBe(false);
    expect(body.requiredCapability).toBe("eval");
    expect(body.hint).toContain("BROWX_CAPABILITIES");
  });

  it("lists fewer tools and fewer characters than all", async () => {
    const all = await connect({ capabilities: DEFAULTS });
    const enabled = await connect({ toolList: "enabled", capabilities: DEFAULTS });
    const allTools = (await all.client.listTools()).tools;
    const enabledTools = (await enabled.client.listTools()).tools;
    expect(enabledTools.length).toBeLessThan(allTools.length);
    const ratio = JSON.stringify(enabledTools).length / JSON.stringify(allTools).length;
    expect(ratio).toBeLessThan(0.95);
  });

  it("reports the live setting through get_config", async () => {
    const { server } = await connect({ toolList: "enabled", capabilities: DEFAULTS });
    const res = await server.handlers.get_config({});
    const text = res.content[0];
    const body = JSON.parse(text?.type === "text" ? text.text : "{}") as {
      config: { toolList: string };
    };
    expect(body.config.toolList).toBe("enabled");
  });
});

describe("toolList: a mistyped value", () => {
  it("stops the server at start and names the valid values", async () => {
    await expect(connect({ toolList: "enabeld", capabilities: DEFAULTS })).rejects.toThrow(
      /BROWX_TOOL_LIST: unknown value "enabeld"\. Valid: all, enabled/,
    );
  });
});
