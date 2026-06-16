// open_session per-session `engine` — schema surface + handler-level validation.
//
// Both are browser-free: the schema is read off the `register` def, and the
// unknown-engine refusal short-circuits in the handler BEFORE `registry.get`
// (so the mock registry's `get` is never reached). This is the regression gate
// for the "validate in the handler, not only via Zod" rule — direct / in-process
// (SDK) callers bypass the MCP schema parse, so the boundary check must live in
// the handler.

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { registerSessionLifecycleTools } from "./session-lifecycle-tools.js";
import { ENGINE_KINDS, IMPLEMENTED_ENGINES } from "../engine/index.js";
import type { ToolResponse } from "./host.js";

interface CapturedDef {
  description: string;
  inputSchema?: z.ZodRawShape;
}
type CapturedHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;

/** Register the lifecycle tools against a minimal mock host and return the
 *  `open_session` def + handler. The registry's `get` throws a sentinel so a
 *  test can prove a code path did (or did NOT) reach it. */
function captureOpenSession(): { def: CapturedDef; handler: CapturedHandler } {
  const defs: Record<string, CapturedDef> = {};
  const handlers: Record<string, CapturedHandler> = {};
  const host = {
    z,
    register: (name: string, def: CapturedDef, handler: CapturedHandler) => {
      defs[name] = def;
      handlers[name] = handler;
    },
    registry: {
      has: () => false,
      get: () => {
        throw new Error("registry.get must not be reached");
      },
    },
  } as unknown as Parameters<typeof registerSessionLifecycleTools>[0];
  registerSessionLifecycleTools(host);
  const def = defs.open_session;
  const handler = handlers.open_session;
  if (!def || !handler) throw new Error("open_session was not registered");
  return { def, handler };
}

function bodyOf(res: ToolResponse): Record<string, unknown> {
  const item = res.content[0] as { text: string };
  return JSON.parse(item.text) as Record<string, unknown>;
}

describe("open_session — per-session engine surface + validation", () => {
  it("exposes an `engine` enum matching the implemented engines (drift guard)", () => {
    const { def } = captureOpenSession();
    const engineSchema = def.inputSchema?.engine as z.ZodOptional<z.ZodEnum<[string, ...string[]]>>;
    expect(engineSchema).toBeDefined();
    expect(engineSchema.unwrap().options).toEqual([...ENGINE_KINDS]);
  });

  it("rejects an unknown engine with a structured unknown-engine error (no browser)", async () => {
    const { handler } = captureOpenSession();
    const body = bodyOf(await handler({ session: "x", engine: "opera" }));
    expect(body.ok).toBe(false);
    expect(body.code).toBe("unknown-engine");
    expect(body.engine).toBe("opera");
    expect(body.implementedEngines).toEqual([...IMPLEMENTED_ENGINES]);
    // The message names the valid engines so the fix is in the error.
    expect(String(body.error)).toContain("opera");
  });

  it("accepts a valid engine and proceeds past validation to the registry", async () => {
    // engine:"firefox" is valid, so validation passes and the handler reaches
    // `registry.get` — our mock throws the sentinel, proving we got there (a real
    // launch is the keystone's job, not this browser-free unit).
    const { handler } = captureOpenSession();
    const body = bodyOf(await handler({ session: "x", engine: "firefox" }));
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("registry.get must not be reached");
  });

  it("omitting engine skips engine validation entirely (legacy path)", async () => {
    const { handler } = captureOpenSession();
    const body = bodyOf(await handler({ session: "x" }));
    // No unknown-engine code — it went straight to the registry (sentinel throw).
    expect(body.code).toBeUndefined();
    expect(String(body.error)).toContain("registry.get must not be reached");
  });
});
