// The `toolProfile` config key: `tools/list` has no profile limit by default (`full`),
// and holds the core set plus plugin tools plus the `tool_catalog` discovery tool when
// it is `core`. `toolList` decides separately which tools the server can run; the
// cases that need every registered tool set `toolList: all`.
//
// Each case builds a real server in a hermetic workspace and talks to it over an
// in-memory MCP transport, so the assertions cover the wire listing and a call by
// name through the same server. Nothing here opens a browser: the tools called are
// answered or refused before a session exists.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { CORE_TOOLS, TOOL_CATALOG_TOOL } from "../../src/util/tool-profile.js";
import { registeredToolNames } from "./_surface.js";

type Server = Awaited<ReturnType<typeof createServer>>;

const DEFAULTS = "read,navigation,action,human";
const opened: Array<{ server: Server; client: Client }> = [];

/** A connected server + client. The env only matters while `createServer` reads it. */
async function connect(env: { toolProfile?: string; toolList?: string; capabilities?: string }) {
  const keys = [
    "BROWX_TOOL_PROFILE",
    "BROWX_TOOL_LIST",
    "BROWX_CAPABILITIES",
    "BROWX_WORKSPACE",
  ] as const;
  const previous = keys.map((k) => process.env[k]);
  const set = (k: (typeof keys)[number], v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  set("BROWX_TOOL_PROFILE", env.toolProfile);
  set("BROWX_TOOL_LIST", env.toolList);
  set("BROWX_CAPABILITIES", env.capabilities);
  set("BROWX_WORKSPACE", mkdtempSync(join(tmpdir(), "browxai-tool-profile-")));
  let server: Server;
  try {
    server = await createServer({ headless: true });
  } finally {
    keys.forEach((k, i) => set(k, previous[i]));
  }
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.start(serverEnd);
  const client = new Client({ name: "tool-profile-test", version: "0" });
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

/** The JSON body of the first text item of a tool result. */
function bodyOf(res: unknown): Record<string, unknown> {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content;
  const first = content?.[0];
  return JSON.parse(first?.type === "text" ? (first.text ?? "{}") : "{}") as Record<
    string,
    unknown
  >;
}

interface CatalogBody {
  profile: string;
  omitted: number;
  note: string;
  groups: Array<{
    capability: string;
    enabled: boolean;
    tools: Array<{ name: string; summary: string }>;
  }>;
}

/** The core set plus the discovery tool, plus any namespaced plugin tool a server holds. */
const pluginToolsOf = (server: Server) =>
  Object.keys(server.handlers).filter((n) => n.includes("."));

describe("the core set", () => {
  it("names only registered tools", async () => {
    const registered = new Set(await registeredToolNames());
    const missing = CORE_TOOLS.filter((name) => !registered.has(name));
    expect(missing, "core names that are not registered tools").toEqual([]);
  });

  it("does not hold the discovery tool or open_session", () => {
    expect(CORE_TOOLS).not.toContain(TOOL_CATALOG_TOOL);
    expect(CORE_TOOLS).not.toContain("open_session");
  });
});

describe("toolProfile: full (the default)", () => {
  it("lists every registered tool, with or without the key set, and has no discovery tool", async () => {
    const unset = await connect({ toolList: "all", capabilities: DEFAULTS });
    const explicit = await connect({
      toolProfile: "full",
      toolList: "all",
      capabilities: DEFAULTS,
    });
    const { tools } = await unset.client.listTools();
    expect(namesOf(tools).sort()).toEqual(Object.keys(unset.server.handlers).sort());
    expect(namesOf(tools)).not.toContain(TOOL_CATALOG_TOOL);
    expect(unset.server.handlers[TOOL_CATALOG_TOOL]).toBeUndefined();
    const explicitListing = await explicit.client.listTools();
    expect(JSON.stringify(explicitListing.tools)).toBe(JSON.stringify(tools));
  });
});

describe("toolProfile: core", () => {
  it("lists the core set, plugin tools and the discovery tool, and nothing else", async () => {
    const { client, server } = await connect({ toolProfile: "core", capabilities: DEFAULTS });
    const names = namesOf((await client.listTools()).tools);
    const expected = [...CORE_TOOLS, TOOL_CATALOG_TOOL, ...pluginToolsOf(server)];
    expect(names.sort()).toEqual([...expected].sort());
    expect(names).toHaveLength(CORE_TOOLS.length + pluginToolsOf(server).length + 1);
    for (const name of Object.keys(server.handlers)) {
      expect(server.isToolListed(name), name).toBe(names.includes(name));
    }
  });

  it("lists far fewer characters than the full profile", async () => {
    const full = await connect({ toolList: "all", capabilities: DEFAULTS });
    const core = await connect({ toolProfile: "core", capabilities: DEFAULTS });
    const fullChars = JSON.stringify((await full.client.listTools()).tools).length;
    const coreChars = JSON.stringify((await core.client.listTools()).tools).length;
    expect(coreChars / fullChars).toBeLessThan(0.4);
  });

  it("still runs an omitted tool called by name", async () => {
    const { client } = await connect({ toolProfile: "core", capabilities: DEFAULTS });
    expect(namesOf((await client.listTools()).tools)).not.toContain("get_config");
    const res = await client.callTool({ name: "get_config", arguments: {} });
    expect(res.isError).not.toBe(true);
    const body = bodyOf(res) as { config: { toolProfile: string } };
    expect(body.config.toolProfile).toBe("core");
  });

  it("still refuses an omitted, capability-gated tool with the same refusal and hint", async () => {
    const core = await connect({ toolProfile: "core", capabilities: DEFAULTS });
    const full = await connect({ toolList: "all", capabilities: DEFAULTS });
    expect(namesOf((await core.client.listTools()).tools)).not.toContain("eval_js");
    const call = (c: Client) => c.callTool({ name: "eval_js", arguments: { expr: "1 + 1" } });
    const refusal = await call(core.client);
    const baseline = await call(full.client);
    expect(refusal.content).toEqual(baseline.content);
    const body = bodyOf(refusal) as {
      ok: boolean;
      requiredCapability: string;
    };
    expect(body.ok).toBe(false);
    expect(body.requiredCapability).toBe("eval");
  });

  it("reports the live setting through get_config, and flags a saved one that differs", async () => {
    const { client, server } = await connect({ toolProfile: "core", capabilities: DEFAULTS });
    const saved = await client.callTool({
      name: "set_config",
      arguments: { scope: "user", patch: { toolProfile: "full" } },
    });
    expect(saved.isError).not.toBe(true);
    const res = await server.handlers.get_config({});
    const body = bodyOf(res) as {
      config: { toolProfile: string };
      toolProfilePendingRestart?: { active: string; persisted: string };
    };
    expect(body.config.toolProfile).toBe("core");
    expect(body.toolProfilePendingRestart).toMatchObject({ active: "core", persisted: "full" });
  });

  it("refuses a toolProfile value set_config does not know", async () => {
    const { client } = await connect({ toolProfile: "core", capabilities: DEFAULTS });
    const res = await client.callTool({
      name: "set_config",
      arguments: { scope: "user", patch: { toolProfile: "lean" } },
    });
    expect(res.isError).toBe(true);
  });
});

describe("tool_catalog", () => {
  it("lists exactly the tools the listing leaves out, grouped by capability", async () => {
    const { client, server } = await connect({ toolProfile: "core", capabilities: DEFAULTS });
    const listed = new Set(namesOf((await client.listTools()).tools));
    const omitted = Object.keys(server.handlers)
      .filter((name) => !listed.has(name))
      .sort();
    const res = await client.callTool({ name: TOOL_CATALOG_TOOL, arguments: {} });
    expect(res.isError).not.toBe(true);
    const body = bodyOf(res) as unknown as CatalogBody;
    const named = body.groups.flatMap((g) => g.tools.map((t) => t.name)).sort();
    expect(named).toEqual(omitted);
    expect(body.omitted).toBe(omitted.length);
    expect(named).not.toContain(TOOL_CATALOG_TOOL);
    for (const core of CORE_TOOLS) expect(named).not.toContain(core);
    for (const group of body.groups) {
      for (const tool of group.tools) expect(tool.summary.length, tool.name).toBeGreaterThan(0);
    }
    const capabilities = body.groups.map((g) => g.capability);
    expect(new Set(capabilities).size).toBe(capabilities.length);
    expect(body.groups.find((g) => g.capability === "eval")?.enabled).toBe(false);
    expect(body.groups.find((g) => g.capability === "read")?.enabled).toBe(true);
  });

  it("names the setting that lists everything, and says calls by name still work", async () => {
    const { client } = await connect({ toolProfile: "core", capabilities: DEFAULTS });
    const res = await client.callTool({ name: TOOL_CATALOG_TOOL, arguments: {} });
    const body = bodyOf(res) as unknown as CatalogBody;
    expect(body.note).toContain("BROWX_TOOL_PROFILE=full");
    expect(body.note).toContain("callable by name");
  });

  it("belongs to no capability: it runs with only read on", async () => {
    const { client } = await connect({ toolProfile: "core", capabilities: "read" });
    const res = await client.callTool({ name: TOOL_CATALOG_TOOL, arguments: {} });
    expect(res.isError).not.toBe(true);
    const body = bodyOf(res);
    expect(body.profile).toBe("core");
    expect(body.requiredCapability).toBeUndefined();
  });

  it("keeps its own schema tiny: one optional string with a one-line description", async () => {
    const { client } = await connect({ toolProfile: "core", capabilities: DEFAULTS });
    const tool = (await client.listTools()).tools.find((t) => t.name === TOOL_CATALOG_TOOL);
    expect(tool).toBeDefined();
    const properties = (tool?.inputSchema.properties ?? {}) as Record<
      string,
      { type?: string; description?: string }
    >;
    expect(Object.keys(properties)).toEqual(["capability"]);
    expect(properties.capability?.type).toBe("string");
    expect(properties.capability?.description?.length).toBeLessThan(100);
    expect(tool?.inputSchema.required ?? []).toEqual([]);
    expect(JSON.stringify(properties).length).toBeLessThan(250);
    expect(JSON.stringify(tool).length).toBeLessThan(900);
  });
});

describe("tool_catalog capability argument", () => {
  const callCatalog = (client: Client, args: Record<string, unknown>) =>
    client.callTool({ name: TOOL_CATALOG_TOOL, arguments: args });

  /** The text of the first content item of a tool result. */
  const textOf = (res: unknown): string => {
    const first = (res as { content?: Array<{ type: string; text?: string }> }).content?.[0];
    return first?.type === "text" ? (first.text ?? "") : "";
  };

  it("with no argument keeps the full reply: same four keys, every group, no capability key", async () => {
    const { client } = await connect({ toolProfile: "core", capabilities: DEFAULTS });
    const first = await callCatalog(client, {});
    const second = await callCatalog(client, { capability: undefined });
    expect(first.isError).not.toBe(true);
    expect(textOf(second)).toBe(textOf(first));
    const body = bodyOf(first) as unknown as CatalogBody;
    expect(Object.keys(body)).toEqual(["profile", "omitted", "note", "groups"]);
    expect(body.groups.length).toBeGreaterThan(1);
  });

  it("returns only the named group, with the fields the full reply gives that group", async () => {
    const { client } = await connect({ toolProfile: "core", capabilities: DEFAULTS });
    const full = bodyOf(await callCatalog(client, {})) as unknown as CatalogBody;
    expect(full.groups.map((g) => g.capability)).toContain("eval");
    for (const group of full.groups) {
      const res = await callCatalog(client, { capability: group.capability });
      expect(res.isError, group.capability).not.toBe(true);
      const body = bodyOf(res) as unknown as CatalogBody & { capability: string };
      expect(body.profile).toBe("core");
      expect(body.capability).toBe(group.capability);
      expect(body.omitted).toBe(group.tools.length);
      expect(body.note).toBe(full.note);
      expect(body.groups).toEqual([group]);
    }
  });

  it("answers an unknown value with an error that lists every valid group and its count", async () => {
    const { client } = await connect({ toolProfile: "core", capabilities: DEFAULTS });
    const full = bodyOf(await callCatalog(client, {})) as unknown as CatalogBody;
    // "constructor" and "toString" are names every object has, and must not pass as groups.
    for (const value of ["no-such-group", "Eval", "", "constructor", "toString"]) {
      const res = await callCatalog(client, { capability: value });
      expect(res.isError, JSON.stringify(value)).toBe(true);
      const text = textOf(res);
      expect(text).toContain(`"${value}" is not a group`);
      for (const group of full.groups) {
        expect(text, group.capability).toContain(`${group.capability} (${group.tools.length})`);
      }
    }
  });

  it("splits the omitted set with no gap and no overlap: group counts add up to the full reply", async () => {
    const { client, server } = await connect({ toolProfile: "core", capabilities: DEFAULTS });
    const listed = new Set(namesOf((await client.listTools()).tools));
    const omitted = Object.keys(server.handlers)
      .filter((name) => !listed.has(name))
      .sort();
    const full = bodyOf(await callCatalog(client, {})) as unknown as CatalogBody;
    let total = 0;
    const seen: string[] = [];
    for (const group of full.groups) {
      const slice = bodyOf(
        await callCatalog(client, { capability: group.capability }),
      ) as unknown as CatalogBody;
      total += slice.omitted;
      seen.push(...slice.groups.flatMap((g) => g.tools.map((t) => t.name)));
    }
    expect(total).toBe(full.omitted);
    expect(total).toBe(omitted.length);
    expect(seen.sort()).toEqual(omitted);
  });

  it("filters the same way when a capability is off, and still marks the group disabled", async () => {
    const { client } = await connect({ toolProfile: "core", capabilities: "read" });
    const res = await callCatalog(client, { capability: "eval" });
    expect(res.isError).not.toBe(true);
    const body = bodyOf(res) as unknown as CatalogBody;
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]?.enabled).toBe(false);
    expect(body.groups[0]?.tools.map((t) => t.name)).toContain("eval_js");
  });
});

describe("toolProfile composed with toolList", () => {
  it("core with toolList enabled lists the core set when its capabilities are on", async () => {
    const { client } = await connect({
      toolProfile: "core",
      toolList: "enabled",
      capabilities: DEFAULTS,
    });
    const names = namesOf((await client.listTools()).tools);
    expect(names.sort()).toEqual([...CORE_TOOLS, TOOL_CATALOG_TOOL].sort());
  });

  it("applies the capability filter first, then narrows to the core set", async () => {
    const narrow = "read,navigation,human";
    const enabled = await connect({
      toolProfile: "core",
      toolList: "enabled",
      capabilities: narrow,
    });
    const names = namesOf((await enabled.client.listTools()).tools);
    // `click` is an action tool, so the capability filter drops it before the profile runs.
    expect(names).not.toContain("click");
    expect(names).toContain("snapshot");
    expect(names).toContain("navigate");
    expect(names).not.toContain("get_config");
    expect(names).toContain(TOOL_CATALOG_TOOL);
  });

  it("core with toolList all keeps a core tool whose capability is off", async () => {
    const { client } = await connect({
      toolProfile: "core",
      toolList: "all",
      capabilities: "read,navigation,human",
    });
    const names = namesOf((await client.listTools()).tools);
    expect(names).toContain("click");
    expect(names.sort()).toEqual([...CORE_TOOLS, TOOL_CATALOG_TOOL].sort());
    // The gate does not change: the call is refused by name.
    const res = await client.callTool({ name: "click", arguments: { selector: "#x" } });
    const body = bodyOf(res) as { requiredCapability?: string };
    expect(body.requiredCapability).toBe("action");
  });
});

describe("toolProfile: a mistyped value", () => {
  it("stops the server at start and names the valid values", async () => {
    await expect(connect({ toolProfile: "cor", capabilities: DEFAULTS })).rejects.toThrow(
      /BROWX_TOOL_PROFILE: unknown value "cor"\. Valid: full, core/,
    );
  });
});
