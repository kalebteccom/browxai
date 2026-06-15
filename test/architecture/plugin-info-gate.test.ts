// L2 — the plugin-info MCP tools (`plugins_list` / `plugins_info`) enforce their
// declared `read` capability AT THE HANDLER (RFC 0004 P2 / D3).
//
// Both tools gained a derived `read` capability row in P2, but a derived row only
// makes the SDK registry / `resolveCapabilities` aware of the gate — it does NOT
// gate a direct server dispatch. Each handler must itself early-return via
// `gateCheck(name)`, the same per-handler idiom the gesture-network tools use
// (gesture-network-tools.ts). Before D3 these two handlers omitted it, so a direct
// dispatch under BROWX_CAPABILITIES=human EXECUTED them despite the `read` row.
//
// This test builds a server with `read` ABSENT (human-only) in a hermetic
// workspace and dispatches both handlers, asserting each returns the structured
// capability-denied envelope carrying `requiredCapability: "read"` — never the
// real plugin listing.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";

type Server = Awaited<ReturnType<typeof createServer>>;

const servers: Server[] = [];

/** Build a server with the given capability set, hermetic workspace + env. The
 *  plugin-info handlers don't touch a browser, so this stays in the fast lane. */
async function serverWithCapabilities(capabilities: string): Promise<Server> {
  const prevCaps = process.env.BROWX_CAPABILITIES;
  const prevWs = process.env.BROWX_WORKSPACE;
  process.env.BROWX_CAPABILITIES = capabilities;
  process.env.BROWX_WORKSPACE = mkdtempSync(join(tmpdir(), "browxai-plugin-gate-"));
  try {
    const server = await createServer({ headless: true });
    servers.push(server);
    return server;
  } finally {
    if (prevCaps === undefined) delete process.env.BROWX_CAPABILITIES;
    else process.env.BROWX_CAPABILITIES = prevCaps;
    if (prevWs === undefined) delete process.env.BROWX_WORKSPACE;
    else process.env.BROWX_WORKSPACE = prevWs;
  }
}

afterAll(async () => {
  await Promise.all(servers.map((s) => s.shutdown().catch(() => undefined)));
});

function parse(res: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = res.content[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("L2 — plugins_list / plugins_info enforce `read` at the handler (D3)", () => {
  it("both DENY with requiredCapability:read when `read` is absent (human-only)", async () => {
    const server = await serverWithCapabilities("human");

    const list = parse(await server.handlers.plugins_list({}));
    expect(list.ok, "plugins_list must be denied under human-only").toBe(false);
    expect(list.requiredCapability).toBe("read");

    const info = parse(await server.handlers.plugins_info({ name: "@browxai/plugin-example" }));
    expect(info.ok, "plugins_info must be denied under human-only").toBe(false);
    expect(info.requiredCapability).toBe("read");
  });

  it("both EXECUTE when `read` is in the active set (no spurious gate)", async () => {
    const server = await serverWithCapabilities("read,navigation,action,human");

    const list = parse(await server.handlers.plugins_list({}));
    // Hermetic workspace => zero plugins declared, but the handler RAN (ok:true,
    // empty list) rather than being capability-denied.
    expect(list.ok).toBe(true);
    expect(Array.isArray(list.plugins)).toBe(true);

    const info = parse(await server.handlers.plugins_info({ name: "nope" }));
    // Unknown plugin => ok:false but for the NOT-DECLARED reason, not a gate
    // denial — so no `requiredCapability` field.
    expect(info.ok).toBe(false);
    expect(info.requiredCapability).toBeUndefined();
    expect(String(info.error)).toContain("not in the declared set");
  });
});
