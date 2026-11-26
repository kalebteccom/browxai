// The deep tools that write a trace, audit or heap file into the workspace add
// `file-io` to their own capability, after the engine gate. Browser-free: each
// handler runs against a stub host whose gate refuses `file-io`, and the session
// has a tracker that fails the test if the handler gets as far as using it.

import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { registerDeepCoverageTools } from "./deep-coverage-tools.js";
import { registerDeepPerfTools } from "./deep-perf-tools.js";
import type { ToolResponse } from "./host.js";

type Handler = (args: Record<string, unknown>) => Promise<ToolResponse>;

const root = mkdtempSync(join(tmpdir(), "browxai-deep-file-io-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const untouched = () => {
  throw new Error("the handler ran past the file-io gate");
};
const entry = {
  id: "s1",
  mode: "incognito",
  session: { engine: "stub", cdp: untouched },
  perf: { start: untouched, stop: untouched },
  coverage: { start: untouched, stop: untouched },
};

function refusal(capability: string, reason?: string): ToolResponse {
  const text = JSON.stringify({ ok: false, requiredCapability: capability, reason });
  return { content: [{ type: "text", text }] };
}

function handlers(opts: { engineRefuses?: boolean } = {}): {
  h: Record<string, Handler>;
  gateCalls: Array<[string, readonly string[] | undefined]>;
} {
  const h: Record<string, Handler> = {};
  const gateCalls: Array<[string, readonly string[] | undefined]> = [];
  const host = {
    z,
    register: (name: string, _def: unknown, handler: Handler) => {
      h[name] = handler;
    },
    gateCheck: (tool: string, extra?: readonly string[], reason?: string) => {
      gateCalls.push([tool, extra]);
      return extra?.includes("file-io") ? refusal("file-io", reason) : null;
    },
    engineGate: () => (opts.engineRefuses ? refusal("engine") : null),
    entryFor: async () => entry,
    workspace: { root },
  };
  registerDeepPerfTools(host as never);
  registerDeepCoverageTools(host as never);
  return { h, gateCalls };
}

function bodyOf(r: ToolResponse): Record<string, unknown> {
  return JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;
}

const WRITERS = ["perf_start", "perf_stop", "perf_audit", "layout_thrash_trace", "heap_snapshot"];

describe("deep tools that write a workspace file", () => {
  it.each(WRITERS)("%s refuses without file-io and writes nothing", async (tool) => {
    const { h, gateCalls } = handlers();
    const body = bodyOf(await h[tool]!({}));
    expect(body.ok).toBe(false);
    expect(body.requiredCapability).toBe("file-io");
    expect(body.reason).toMatch(new RegExp(`^${tool} writes .+ to the workspace`));
    expect(gateCalls).toContainEqual([tool, ["file-io"]]);
    expect(readdirSync(root)).toEqual([]);
  });

  it.each(WRITERS)("%s returns the engine refusal before the file-io one", async (tool) => {
    const { h, gateCalls } = handlers({ engineRefuses: true });
    expect(bodyOf(await h[tool]!({})).requiredCapability).toBe("engine");
    expect(gateCalls.some(([, extra]) => extra?.includes("file-io"))).toBe(false);
  });

  it.each(["coverage_start", "coverage_stop"])(
    "%s writes no file and asks for no file-io",
    async (tool) => {
      const { h, gateCalls } = handlers();
      // The stub tracker throws once the handler reaches it, past every gate.
      const body = bodyOf(await h[tool]!({}));
      expect(body.requiredCapability).toBeUndefined();
      expect(gateCalls.some(([, extra]) => extra?.includes("file-io"))).toBe(false);
      expect(existsSync(join(root, "perf"))).toBe(false);
    },
  );
});
