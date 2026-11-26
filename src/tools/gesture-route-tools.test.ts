// `route` / `route_queue` / `sw_intercept_fetch` and the `eval` capability.
// Browser-free: the gate is a stub over a capability set, and the substrate and
// worker registry record the spec they were handed. The real-Chromium proof
// lives in test/keystone/route-fulfil.keystone.test.ts.

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { registerGestureRouteTools } from "./gesture-route-tools.js";
import { registerGestureWorkerTools } from "./gesture-worker-tools.js";
import type { Capability } from "../util/capabilities.js";
import type { SessionEntry } from "../session/registry.js";
import type { ToolResponse } from "./host.js";

type Handler = (args: Record<string, unknown>) => Promise<ToolResponse>;

function setup(opts: { evalOn: boolean }) {
  const handlers: Record<string, Handler> = {};
  const routed: Array<Record<string, unknown>> = [];
  const intercepted: Array<Record<string, unknown>> = [];
  const entry = {
    id: "default",
    session: { engine: "chromium", cdp: () => ({}) },
    networkSubstrate: {
      route: async (spec: Record<string, unknown>) => {
        routed.push(spec);
        return {
          kind: "installed",
          key: `* ${String(spec.urlPattern)}`,
          ...(Array.isArray(spec.responses) ? { queued: spec.responses.length } : {}),
          fulfils: spec.allowExecutable ? "all" : "data",
          active: [`* ${String(spec.urlPattern)}`],
        };
      },
      unroute: async () => ({
        kind: "removed",
        removed: ["* **/a"],
        skippedExecutable: 3,
        active: [],
      }),
    },
    workers: {
      addFetchIntercept: async (_cdp: unknown, spec: Record<string, unknown>) => {
        intercepted.push(spec);
        return {
          key: spec.pattern,
          fulfils: spec.allowExecutable ? "all" : "data",
          active: [spec.pattern],
        };
      },
    },
  } as unknown as SessionEntry;
  const active = new Set<Capability>(["read", "navigation", "action", "human"]);
  if (opts.evalOn) active.add("eval");
  const host = {
    z,
    register: (name: string, _def: unknown, handler: Handler) => {
      handlers[name] = handler;
    },
    gateCheck: (tool: string, extra?: readonly Capability[], reason?: string) => {
      for (const cap of extra ?? []) {
        if (active.has(cap)) continue;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                tool,
                requiredCapability: cap,
                ...(reason ? { reason } : {}),
              }),
            },
          ],
        };
      }
      return null;
    },
    engineGate: () => null,
    subInterfaceGate: () => null,
    entryFor: async () => entry,
  } as unknown as Parameters<typeof registerGestureRouteTools>[0] &
    Parameters<typeof registerGestureWorkerTools>[0];
  registerGestureRouteTools(host);
  registerGestureWorkerTools(host);
  return { handlers, routed, intercepted };
}

const body = (r: ToolResponse) =>
  JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;

const RUN_CONTENT_TYPES = [
  "text/html",
  "text/html; charset=utf-8",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/javascript",
  "application/javascript",
];

describe("route — content type and the eval capability", () => {
  it.each(RUN_CONTENT_TYPES)("refuses contentType %s at install without eval", async (ct) => {
    const { handlers, routed } = setup({ evalOn: false });
    const r = body(await handlers.route!({ urlPattern: "**/x", contentType: ct, body: "x" }));
    expect(r.ok).toBe(false);
    expect(r.requiredCapability).toBe("eval");
    expect(r.reason).toContain(ct);
    expect(routed).toEqual([]);
  });

  it("installs a JSON route without eval and reports fulfils: data", async () => {
    const { handlers, routed } = setup({ evalOn: false });
    const r = body(await handlers.route!({ urlPattern: "**/api/*", body: "{}" }));
    expect(r).toEqual({ ok: true, key: "* **/api/*", fulfils: "data", active: ["* **/api/*"] });
    expect(routed[0]!.allowExecutable).toBe(false);
  });

  it("installs an HTML route with eval and reports fulfils: all", async () => {
    const { handlers, routed } = setup({ evalOn: true });
    const r = body(
      await handlers.route!({ urlPattern: "**/page", contentType: "text/html", body: "<p>" }),
    );
    expect(r.ok).toBe(true);
    expect(r.fulfils).toBe("all");
    expect(routed[0]!.allowExecutable).toBe(true);
  });
});

describe("route_queue — content type and the eval capability", () => {
  it("refuses when any queued response has a script content type", async () => {
    const { handlers, routed } = setup({ evalOn: false });
    const r = body(
      await handlers.route_queue!({
        urlPattern: "**/x",
        responses: [{ body: "{}" }, { body: "x", contentType: "text/javascript" }],
      }),
    );
    expect(r.requiredCapability).toBe("eval");
    expect(routed).toEqual([]);
  });

  it("installs a JSON queue without eval and reports fulfils: data", async () => {
    const { handlers, routed } = setup({ evalOn: false });
    const r = body(
      await handlers.route_queue!({ urlPattern: "**/q", responses: [{ body: "1" }, {}] }),
    );
    expect(r).toEqual({ ok: true, key: "* **/q", queued: 2, fulfils: "data", active: ["* **/q"] });
    expect(routed[0]!.allowExecutable).toBe(false);
  });

  it("passes allowExecutable with eval", async () => {
    const { handlers, routed } = setup({ evalOn: true });
    const r = body(await handlers.route_queue!({ urlPattern: "**/q", responses: [{}] }));
    expect(r.fulfils).toBe("all");
    expect(routed[0]!.allowExecutable).toBe(true);
  });
});

describe("unroute", () => {
  it("reports the skipped-request count the substrate returned", async () => {
    const { handlers } = setup({ evalOn: false });
    const r = body(await handlers.unroute!({}));
    expect(r).toEqual({ ok: true, removed: ["* **/a"], skippedExecutable: 3, active: [] });
  });
});

describe("sw_intercept_fetch — content type and the eval capability", () => {
  it("refuses a script contentType without eval", async () => {
    const { handlers, intercepted } = setup({ evalOn: false });
    const r = body(
      await handlers.sw_intercept_fetch!({
        pattern: "**/app.js",
        response: { body: "x", contentType: "text/javascript" },
      }),
    );
    expect(r.requiredCapability).toBe("eval");
    expect(intercepted).toEqual([]);
  });

  it("refuses a document content type set through headers, in any case", async () => {
    const { handlers, intercepted } = setup({ evalOn: false });
    const r = body(
      await handlers.sw_intercept_fetch!({
        pattern: "**/page",
        response: { body: "<p>", headers: { "Content-Type": "text/html" } },
      }),
    );
    expect(r.requiredCapability).toBe("eval");
    expect(intercepted).toEqual([]);
  });

  it("installs a JSON interceptor without eval and reports fulfils: data", async () => {
    const { handlers, intercepted } = setup({ evalOn: false });
    const r = body(
      await handlers.sw_intercept_fetch!({ pattern: "**/api/**", response: { body: "{}" } }),
    );
    expect(r.ok).toBe(true);
    expect(r.fulfils).toBe("data");
    expect(intercepted[0]!.allowExecutable).toBe(false);
  });

  it("passes allowExecutable with eval", async () => {
    const { handlers, intercepted } = setup({ evalOn: true });
    const r = body(
      await handlers.sw_intercept_fetch!({
        pattern: "**/page",
        response: { body: "<p>", contentType: "text/html" },
      }),
    );
    expect(r.fulfils).toBe("all");
    expect(intercepted[0]!.allowExecutable).toBe(true);
  });
});
