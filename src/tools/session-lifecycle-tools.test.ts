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
import { ENGINE_KINDS, IMPLEMENTED_ENGINES, requirePage } from "../engine/index.js";
import type { PageCapable } from "../engine/index.js";
import { PlaywrightTargetSubstrate } from "../page/target-substrate.js";
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

// ---------------------------------------------------------------------------
// list_sessions — one dead target must not take out the listing.
//
// `list_sessions` reads each session's URL through `targetFor(e).url()` and
// guards it with `.catch(() => null)`. That guard is only reachable if the
// adapter rejects; a non-async adapter method typed `Promise<string>` throws
// SYNCHRONOUSLY out of `requirePage` on an attached (BYOB) session whose tab the
// user closed, the `.catch` never runs, the `Promise.all` rejects, and every
// HEALTHY session in the registry is lost with the dead one. These two tests pin
// the degrade: `url: null` for the dead session, full rows for the rest.

/** A session entry whose Page accessor either works or throws the attach-gone
 *  error, shaped for the two things `list_sessions` reads off it: the target
 *  substrate's URL and the tab count. */
function entryWithPage(id: string, page: (() => unknown) | "gone") {
  const gone = () => {
    throw new Error(`attach-target-gone: session "${id}" — the attached tab is closed`);
  };
  return {
    id,
    mode: "attached",
    openedAt: 0,
    session: { engine: "chromium", page: page === "gone" ? gone : page },
  };
}

/** A fake Playwright Page exposing exactly what the handler touches. */
function fakePage(url: string, tabs = 1) {
  return () => ({ url: () => url, context: () => ({ pages: () => new Array(tabs).fill({}) }) });
}

function captureListSessions(entries: unknown[]): CapturedHandler {
  const handlers: Record<string, CapturedHandler> = {};
  const host = {
    z,
    register: (name: string, _def: CapturedDef, handler: CapturedHandler) => {
      handlers[name] = handler;
    },
    registry: { list: () => entries },
    // The real Playwright adapter over the entry's own accessor — the point of
    // the test is the adapter's behaviour, so it is not stubbed.
    targetFor: (e: { session: PageCapable }) =>
      new PlaywrightTargetSubstrate(() => requirePage(e.session), e.session.engine),
  } as unknown as Parameters<typeof registerSessionLifecycleTools>[0];
  registerSessionLifecycleTools(host);
  const handler = handlers.list_sessions;
  if (!handler) throw new Error("list_sessions was not registered");
  return handler;
}

describe("list_sessions — degrades per session, never loses the listing", () => {
  it("reports url:null for a gone target and still lists the healthy sessions", async () => {
    const handler = captureListSessions([
      entryWithPage("alive-1", fakePage("https://a.test/one", 2)),
      entryWithPage("gone-1", "gone"),
      entryWithPage("alive-2", fakePage("https://b.test/two")),
    ]);
    const body = bodyOf(await handler({}));
    const rows = body.sessions as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.id)).toEqual(["alive-1", "gone-1", "alive-2"]);
    expect(rows[0]).toMatchObject({ url: "https://a.test/one", pages: 2 });
    // The dead tab degrades in place: url and pages are null, the row survives.
    expect(rows[1]).toMatchObject({ url: null, pages: null });
    expect(rows[2]).toMatchObject({ url: "https://b.test/two", pages: 1 });
  });

  it("survives every session being gone (no row, no throw)", async () => {
    const handler = captureListSessions([
      entryWithPage("gone-1", "gone"),
      entryWithPage("gone-2", "gone"),
    ]);
    const rows = bodyOf(await handler({})).sessions as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ url: null, pages: null });
  });
});
