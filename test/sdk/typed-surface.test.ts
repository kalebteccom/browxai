// The curated typed surface — `SDK_TOOLS` ≡ the methods on a built client.
//
// `SDK_TOOLS` is the list of tools that get a typed method on `BrowxaiClient`.
// Nothing derives the wrappers from it (they are hand-written in the client
// literal so each keeps its own signature), so the two can drift — and did:
// `frames_list` had a wrapper and no entry, which under the old
// SDK_TOOLS-as-ceiling gate made `client.frames_list()` throw on every call.
// This pins them to each other, and both to the registered surface.

import { describe, it, expect } from "vitest";
import "../../src/tools/tool-metadata.js";
import { buildClient } from "../../src/sdk/client.js";
import { SDK_TOOLS, capabilityFor, registeredTools } from "../../src/sdk/registry.js";
import { ALL_CAPABILITIES } from "../../src/util/capabilities.js";
import type { SdkTransport } from "../../src/sdk/transport.js";

/** Client members that are not tool wrappers. */
const NON_TOOL_MEMBERS = new Set(["callTool", "close"]);

const transport: SdkTransport = {
  dispatch: async (name) => ({ content: [], data: { ok: true, name } }),
  close: async () => undefined,
};

function typedMethodNames(): string[] {
  const client = buildClient({ transport, capabilities: new Set(ALL_CAPABILITIES) });
  return Object.entries(client)
    .filter(([name, value]) => typeof value === "function" && !NON_TOOL_MEMBERS.has(name))
    .map(([name]) => name)
    .sort();
}

describe("SDK typed surface", () => {
  it("every SDK_TOOLS entry has a typed method, and every typed method an entry", () => {
    expect(typedMethodNames()).toEqual([...SDK_TOOLS].sort());
  });

  it("every SDK_TOOLS entry names a tool the server actually registers", () => {
    const registered = new Set(registeredTools());
    expect(SDK_TOOLS.filter((t) => !registered.has(t))).toEqual([]);
  });

  it("the typed methods are a strict SUBSET of what callTool reaches", () => {
    // Curation, not a ceiling: `callTool` reaches the whole registered surface.
    expect(SDK_TOOLS.length).toBeLessThan(registeredTools().length);
  });

  it("each typed method routes through the gate — no direct dispatch slot", async () => {
    // Empty capability set: every typed method whose capability is NOT `human`
    // must refuse. This is what makes `(client as any).<method>()` indexing
    // harmless — there is no wrapper that reaches the transport ungated.
    const client = buildClient({ transport, capabilities: new Set([]) });
    const gated = SDK_TOOLS.filter((t) => capabilityFor(t) !== "human");
    expect(gated.length).toBeGreaterThan(0);
    for (const tool of gated) {
      const method = (client as unknown as Record<string, () => Promise<unknown>>)[tool];
      await expect(method()).rejects.toThrow(/BROWXAI_SDK_NOT_EXPOSED/);
    }
  });
});
