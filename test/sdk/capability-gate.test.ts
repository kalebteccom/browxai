// Capability-gate hermetic test — verifies the SDK boundary's registry
// walker enforces the same capability gating as the MCP server. No browser,
// no subprocess: a mock transport stands in for dispatch so we can assert
// the gate fires BEFORE any wire call.

import { describe, it, expect } from "vitest";
import { buildClient, NOT_EXPOSED_ERROR } from "../../src/sdk/client.js";
import type { BrowxaiClient } from "../../src/sdk/types.js";
import type { SdkTransport } from "../../src/sdk/transport.js";

function mockTransport(): { transport: SdkTransport; calls: Array<{ name: string; args: unknown }> } {
  const calls: Array<{ name: string; args: unknown }> = [];
  const transport: SdkTransport = {
    dispatch: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, name }) }], data: { ok: true, name } };
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

  it("REJECTS callTool('eval_js', …) at the registry-walker layer with a NOT_EXPOSED error — does NOT reach the transport", async () => {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    expect(calls).toEqual([{ name: "navigate", args: { url: "https://example.com", session: "wright-1" } }]);
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
