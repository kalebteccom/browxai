// Capability-gate hermetic test — verifies the SDK boundary enforces the same
// capability gating as the MCP server, over the same registered surface. No
// browser, no subprocess: a mock transport stands in for dispatch so we can
// assert the gate fires BEFORE any wire call.

import { describe, it, expect } from "vitest";
// RFC 0004 P2: the SDK capability gate reads the DERIVED `TOOL_CAPABILITY` map
// (now populated from the colocated `host.register` metadata). This test builds a
// client with a mock transport — no server — so it loads the tools-layer bootstrap
// to install the lazy collector and populate the map the gate consults.
import "../../src/tools/tool-metadata.js";
import { buildClient, NOT_EXPOSED_ERROR, UNKNOWN_TOOL_ERROR } from "../../src/sdk/client.js";
import { ALL_CAPABILITIES, TOOL_CAPABILITY, type Capability } from "../../src/util/capabilities.js";
import type { BrowxaiClient } from "../../src/sdk/types.js";
import type { SdkTransport } from "../../src/sdk/transport.js";

function mockTransport(): {
  transport: SdkTransport;
  calls: Array<{ name: string; args: unknown }>;
} {
  const calls: Array<{ name: string; args: unknown }> = [];
  const transport: SdkTransport = {
    dispatch: async (name, args) => {
      calls.push({ name, args });
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, name }) }],
        data: { ok: true, name },
      };
    },
    close: async () => undefined,
  };
  return { transport, calls };
}

describe("SDK capability gate — default posture (no posture-broadening caps)", () => {
  it("exposes the default read/navigation/action surface", () => {
    const { transport } = mockTransport();
    const client: BrowxaiClient = buildClient({
      transport,
      capabilities: new Set(["read", "navigation", "action", "human"]),
    });
    // Default surface includes these — they're under read/navigation/action.
    expect(client.exposedTools).toContain("snapshot");
    expect(client.exposedTools).toContain("navigate");
    expect(client.exposedTools).toContain("click");
    expect(client.exposedTools).toContain("extract");
    expect(client.exposedTools).toContain("verify_visible");
    // session-management is always-on (`human` capability)
    expect(client.exposedTools).toContain("open_session");
    expect(client.exposedTools).toContain("close_session");
  });

  it("does NOT expose eval_js / network_body / upload_file / register_secret by default", () => {
    const { transport } = mockTransport();
    const client = buildClient({
      transport,
      capabilities: new Set(["read", "navigation", "action", "human"]),
    });
    expect(client.exposedTools).not.toContain("eval_js");
    expect(client.exposedTools).not.toContain("network_body");
    expect(client.exposedTools).not.toContain("upload_file");
    expect(client.exposedTools).not.toContain("register_secret");
  });

  it("REJECTS callTool('eval_js', …) at the SDK gate with a NOT_EXPOSED error — does NOT reach the transport", async () => {
    const { transport, calls } = mockTransport();
    const client = buildClient({
      transport,
      capabilities: new Set(["read", "navigation", "action", "human"]),
    });
    let captured: unknown = null;
    try {
      await client.callTool("eval_js", { code: "1+1" });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain(NOT_EXPOSED_ERROR);
    expect((captured as Error).message).toContain("eval_js");
    expect((captured as Error).message).toContain('"eval"'); // required capability advertised
    expect(calls.length).toBe(0); // gate fired BEFORE any dispatch
  });

  it("REJECTS the (client as any).eval_js({...}) escape attempt — typed method is present but gated", async () => {
    const { transport, calls } = mockTransport();
    const client = buildClient({
      transport,
      capabilities: new Set(["read", "navigation", "action", "human"]),
    });
    let captured: unknown = null;
    try {
      await (client as any).callTool("eval_js", { code: "1+1" });
    } catch (err) {
      captured = err;
    }
    expect((captured as Error).message).toContain(NOT_EXPOSED_ERROR);
    expect(calls.length).toBe(0);
  });
});

describe("SDK capability gate — opting in to `eval` exposes eval_js", () => {
  it("with capabilities: [...defaults, 'eval'], eval_js becomes callable end-to-end", async () => {
    const { transport, calls } = mockTransport();
    const client = buildClient({
      transport,
      capabilities: new Set(["read", "navigation", "action", "human", "eval"]),
    });
    expect(client.exposedTools).toContain("eval_js");
    const r = await client.callTool("eval_js", { code: "1+1" });
    expect(r.data).toMatchObject({ ok: true, name: "eval_js" });
    expect(calls).toEqual([{ name: "eval_js", args: { code: "1+1" } }]);
  });
});

describe("SDK capability gate — opting in to `network-body` / `file-io` / `secrets` independently", () => {
  it("`network-body` alone exposes network_body but NOT upload_file or register_secret", () => {
    const { transport } = mockTransport();
    const client = buildClient({
      transport,
      capabilities: new Set(["read", "navigation", "action", "human", "network-body"]),
    });
    expect(client.exposedTools).toContain("network_body");
    expect(client.exposedTools).not.toContain("upload_file");
    expect(client.exposedTools).not.toContain("register_secret");
    expect(client.exposedTools).not.toContain("eval_js");
  });
});

describe("SDK session-default behaviour", () => {
  it("merges the SDK-default `session` into each call when args.session is omitted", async () => {
    const { transport, calls } = mockTransport();
    const client = buildClient({
      transport,
      capabilities: new Set(["read", "navigation", "action", "human"]),
      session: "wright-1",
    });
    await client.navigate({ url: "https://example.com" });
    expect(calls).toEqual([
      { name: "navigate", args: { url: "https://example.com", session: "wright-1" } },
    ]);
  });

  it("does NOT override an explicit args.session", async () => {
    const { transport, calls } = mockTransport();
    const client = buildClient({
      transport,
      capabilities: new Set(["read", "navigation", "action", "human"]),
      session: "wright-1",
    });
    await client.navigate({ url: "https://example.com", session: "ad-hoc" });
    expect(calls[0]?.args).toMatchObject({ session: "ad-hoc" });
  });
});

describe("SDK close() — idempotent", () => {
  it("close() can be called twice without throwing", async () => {
    let closes = 0;
    const transport: SdkTransport = {
      dispatch: async () => ({ content: [] }),
      close: async () => {
        closes++;
      },
    };
    const client = buildClient({
      transport,
      capabilities: new Set(["read"]),
    });
    await client.close();
    await client.close();
    expect(closes).toBe(1); // transport.close fires once; second client.close short-circuits
  });

  it("dispatch after close throws a clear error", async () => {
    const { transport } = mockTransport();
    const client = buildClient({
      transport,
      capabilities: new Set(["read", "navigation", "action", "human"]),
    });
    await client.close();
    let err: unknown = null;
    try {
      await client.snapshot();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("closed");
  });
});

// ── `callTool` reaches the registered surface, gated on capability alone ─────
// Regression: `callTool` used to gate on SDK_TOOLS membership as well, so 144 of
// the 199 registered tools had no SDK path at all and the refusal named a
// capability that was already active. See
// docs/ai-context/adopter-reports/2026-09-14-sdk-calltool-surface.md.

/** Tools grouped by the capability that gates them, read off the SAME derived
 *  map the server's gateCheck consults — never a hand-copied list. */
function toolsByCapability(): Map<Capability, string[]> {
  const byCap = new Map<Capability, string[]>();
  for (const [tool, cap] of TOOL_CAPABILITY) {
    const row = byCap.get(cap) ?? [];
    row.push(tool);
    byCap.set(cap, row);
  }
  return byCap;
}

const DEFAULTS: Capability[] = ["read", "navigation", "action", "human"];
const OFF_BY_DEFAULT = ALL_CAPABILITIES.filter((c) => !DEFAULTS.includes(c));

describe("SDK callTool — the documented canvas/vision example (docs/tool-reference.md)", () => {
  it("canvas_capture + gesture_chain dispatch once `canvas` is named", async () => {
    const { transport, calls } = mockTransport();
    const client = buildClient({
      transport,
      capabilities: new Set([...DEFAULTS, "canvas"]),
    });
    await client.callTool("canvas_capture", { format: "png" });
    await client.callTool("gesture_chain", { steps: [{ kind: "down", x: 1, y: 2 }] });
    expect(calls.map((c) => c.name)).toEqual(["canvas_capture", "gesture_chain"]);
  });

  it("and both still refuse without it, naming `canvas` as the remedy", async () => {
    const { transport, calls } = mockTransport();
    const client = buildClient({ transport, capabilities: new Set(DEFAULTS) });
    for (const tool of ["canvas_capture", "gesture_chain"]) {
      await expect(client.callTool(tool, {})).rejects.toThrow(
        new RegExp(`${NOT_EXPOSED_ERROR}.*"${tool}" requires the "canvas" capability`),
      );
    }
    expect(calls.length).toBe(0);
  });
});

describe("SDK callTool — the always-on capabilities carry no ceiling", () => {
  // One per always-on capability, each absent from the curated typed surface.
  it.each([
    ["sample", "read"],
    ["tab_visibility", "navigation"],
    ["double_click", "action"],
    ["start_recording", "human"],
  ])("%s (capability %s) dispatches on a default client", async (tool) => {
    const { transport, calls } = mockTransport();
    const client = buildClient({ transport, capabilities: new Set(DEFAULTS) });
    await client.callTool(tool, {});
    expect(calls).toEqual([{ name: tool, args: {} }]);
  });

  it("a `human` tool stays callable even when the caller names no capability at all", async () => {
    const { transport, calls } = mockTransport();
    const client = buildClient({ transport, capabilities: new Set([]) });
    await client.callTool("start_recording", {});
    expect(calls.length).toBe(1);
  });
});

describe("SDK capability gate — EVERY off-by-default capability still refuses when unset", () => {
  const byCap = toolsByCapability();

  // The four capabilities that gate no tool: they govern behaviour inside other
  // tools (clipboard read-back in `shortcut`, stealth patches at session wire-up,
  // the replay capture tier) or a server-start check (`byob-attach`). Pinned so
  // that a tool declaring one of them fails this suite until it gets coverage in
  // the per-capability loop below.
  //
  // `native-device` is NOT among them, and the distinction is the point. It gates
  // SESSION CREATION for both native engines, which each declare it via
  // `EngineEntry.requiresCapability` — so the refusal lands once at
  // `open_session` and nothing the engines serve can be reached around it — AND
  // it gates the ten `device_*` / `app_*` lifecycle tools, which have no browser
  // analogue and so have no substrate to ride. Two gates for one posture is
  // deliberate: the session gate is the un-reachable-around one, and the per-tool
  // rows are what the loop below enumerates.
  it("only clipboard / stealth / byob-attach / replay gate no tool at all", () => {
    const ungated = OFF_BY_DEFAULT.filter((c) => (byCap.get(c) ?? []).length === 0);
    expect(ungated.sort()).toEqual(["byob-attach", "clipboard", "replay", "stealth"]);
  });

  for (const cap of OFF_BY_DEFAULT) {
    const tools = byCap.get(cap) ?? [];
    if (tools.length === 0) continue;
    it(`\`${cap}\` — all ${tools.length} of its tools refuse, none dispatch`, async () => {
      const { transport, calls } = mockTransport();
      const client = buildClient({ transport, capabilities: new Set(DEFAULTS) });
      for (const tool of tools) {
        await expect(client.callTool(tool, {})).rejects.toThrow(
          new RegExp(`${NOT_EXPOSED_ERROR}.*"${tool}" requires the "${cap}" capability`),
        );
        expect(client.exposedTools).not.toContain(tool);
      }
      expect(calls.length).toBe(0);
    });

    it(`\`${cap}\` — naming it admits its tools and NOTHING else`, async () => {
      const { transport, calls } = mockTransport();
      const client = buildClient({ transport, capabilities: new Set([...DEFAULTS, cap]) });
      for (const tool of tools) await client.callTool(tool, {});
      expect(calls.map((c) => c.name).sort()).toEqual([...tools].sort());
      // No OTHER off-by-default capability came along for the ride.
      for (const other of OFF_BY_DEFAULT) {
        if (other === cap) continue;
        for (const tool of byCap.get(other) ?? []) {
          expect(client.exposedTools).not.toContain(tool);
        }
      }
    });
  }
});

describe("SDK callTool — an unknown tool name is its own refusal", () => {
  it("refuses a typo with UNKNOWN_TOOL_ERROR, NOT the capability branch", async () => {
    const { transport, calls } = mockTransport();
    const client = buildClient({ transport, capabilities: new Set(ALL_CAPABILITIES) });
    let captured: unknown = null;
    try {
      await client.callTool("canvs_capture", {});
    } catch (err) {
      captured = err;
    }
    const msg = (captured as Error).message;
    expect(msg).toContain(UNKNOWN_TOOL_ERROR);
    expect(msg).toContain("canvs_capture");
    expect(msg).not.toContain(NOT_EXPOSED_ERROR);
    // The old shared branch advised "pass the capability" — which cannot help.
    expect(msg).not.toContain("createBrowxai({ capabilities");
    expect(calls.length).toBe(0);
  });

  it("a dotted name defers to the server; the same name undotted does not", async () => {
    // Plugin tools are `<namespace>.<tool>` and register in the SERVER's
    // process, so this one cannot answer whether they exist. No core tool name
    // contains a dot, so the deferral can never reach one.
    const { transport, calls } = mockTransport();
    const client = buildClient({ transport, capabilities: new Set(DEFAULTS) });
    await client.callTool("figma.eval_js", {});
    expect(calls.map((c) => c.name)).toEqual(["figma.eval_js"]);
    await expect(client.callTool("eval_js", {})).rejects.toThrow(NOT_EXPOSED_ERROR);
    expect(calls.length).toBe(1);
  });

  it("does NOT fall through to the permissive `human` default", async () => {
    const { transport, calls } = mockTransport();
    // Empty capability set: if an unknown name resolved to `human`, it would be
    // admitted here — the security regression this branch exists to prevent.
    const client = buildClient({ transport, capabilities: new Set([]) });
    await expect(client.callTool("definitely_not_a_tool", {})).rejects.toThrow(UNKNOWN_TOOL_ERROR);
    expect(calls.length).toBe(0);
  });
});

describe("SDK capability gate — a nested tool name is gated too", () => {
  // `batch` / `flake_check` / `act_and_*` / `cross_session_sample` dispatch an
  // inner tool BY NAME server-side. Without this the gate would refuse
  // `eval_js` head-on and admit the same call wrapped in a `batch`.
  const NESTED: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["batch", { calls: [{ tool: "eval_js", args: { expr: "1" } }] }],
    ["flake_check", { calls: [{ tool: "network_body", args: {} }], runs: 2 }],
    ["act_and_sample", { action: { tool: "eval_js", args: {} } }],
    ["act_and_diff", { action: { tool: "upload_file", args: {} } }],
    ["act_and_wait_for_network", { action: { tool: "network_body", args: {} } }],
    ["cross_session_sample", { action: { tool: "register_secret", args: {} } }],
    // A batch carrying an act_and_* — the deepest real nesting.
    ["batch", { calls: [{ tool: "act_and_sample", args: { action: { tool: "eval_js" } } }] }],
  ];

  it.each(NESTED)(
    "%s carrying a gated inner tool is refused, nothing dispatches",
    async (outer, args) => {
      const { transport, calls } = mockTransport();
      const client = buildClient({ transport, capabilities: new Set(DEFAULTS) });
      await expect(client.callTool(outer, args)).rejects.toThrow(
        new RegExp(`${NOT_EXPOSED_ERROR}.*\\(dispatched by "${outer}"\\)`),
      );
      expect(calls.length).toBe(0);
    },
  );

  it("the same call goes through once the inner tool's capability is named", async () => {
    const { transport, calls } = mockTransport();
    const client = buildClient({ transport, capabilities: new Set([...DEFAULTS, "eval"]) });
    await client.callTool("batch", { calls: [{ tool: "eval_js", args: { expr: "1" } }] });
    expect(calls.map((c) => c.name)).toEqual(["batch"]);
  });

  it("an inner name that is not a registered tool is left to the server", async () => {
    const { transport, calls } = mockTransport();
    const client = buildClient({ transport, capabilities: new Set(DEFAULTS) });
    await client.callTool("batch", { calls: [{ tool: "not_a_tool", args: {} }] });
    expect(calls.length).toBe(1);
  });
});
