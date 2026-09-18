// The THIRD gate dimension — `EngineCapabilities.refusedTools` — must refuse a
// tool the engine can run and must not.
//
// The two existing dimensions both answer "can it". `deep` answers "is the
// raw-CDP escape hatch there", `subInterfaces` answers "is the port implemented
// at all". Neither can express `navigate` on an attached Electron app, which has
// a Playwright Page, a CDP handle and a declared `navigation` sub-interface, and
// whose `page.goto()` returns a 200 — having just run a web page inside the
// application's own privileged renderer and thrown away everything that renderer
// held in memory. It works, and it must not run.
//
// So the declaration says which tools an engine refuses BY NAME and why, and this
// file is what keeps the declaration load-bearing. The fixture is a synthetic
// engine whose substrates ANSWER (`inMemorySubstrateBundle(deps, "answering")`),
// for the same reason `sub-interface-conformance.test.ts` uses answering
// substrates: against a throwing substrate a missing gate looks like a present
// one. Here an ungated `navigate` returns a well-formed ActionResult, and that is
// the failure this file reports.
//
// The refusal shape matches the other two dimensions — `{ok:false, error, engine,
// hint}` — because a caller must be able to tell "the engine will not" from "the
// navigation failed".

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineKind } from "../../src/engine/index.js";
import { capabilitiesFor, assertEngineRefuses } from "../../src/engine/index.js";
import type { BrowserSession } from "../../src/session/types.js";
import { createServer } from "../../src/server.js";
import { registerEngine } from "../../src/engine/registry.js";
import { inMemorySubstrateBundle } from "./_synthetic-engine.js";

const REFUSER = "probe-refuses-navigate" as EngineKind;
const PLAIN = "probe-refuses-nothing" as EngineKind;

const WHY = "the probe engine declares navigate refused so this file can assert the gate fires";

/** Every sub-interface chromium declares — so the ONLY thing standing between
 *  `navigate` and a well-formed result is the `refusedTools` entry. */
const ALL_SUBS = capabilitiesFor("chromium")!.subInterfaces;

function syntheticSession(kind: EngineKind): BrowserSession {
  return {
    mode: "managed" as const,
    ownsBrowser: true,
    engine: kind,
    page: () =>
      ({
        url: () => "about:blank",
        title: () => Promise.resolve("synthetic"),
        locator: () => ({
          count: () => Promise.resolve(0),
          first() {
            return this;
          },
        }),
      }) as never,
    close: async () => {},
  };
}

function register(kind: EngineKind, refusedTools?: ReadonlyMap<string, string>): void {
  registerEngine({
    kind,
    capabilities: { engine: kind, subInterfaces: ALL_SUBS, deep: false, refusedTools },
    makeAdapter: async () => syntheticSession(kind),
    makeSubstrates: (deps) => inMemorySubstrateBundle(deps, "answering"),
    postWire: () => {},
  });
}

type Body = { ok?: boolean; error?: string; engine?: string; hint?: string };

describe("refusedTools — a tool the engine CAN run and must not", () => {
  const servers = new Map<EngineKind, Awaited<ReturnType<typeof createServer>>>();
  const priorWorkspace = process.env.BROWX_WORKSPACE;

  beforeAll(async () => {
    // Hermetic workspace: the persisted config store's `user` layer outranks the
    // env, so a developer machine with saved config must not drive this file
    // differently from CI.
    process.env.BROWX_WORKSPACE = mkdtempSync(join(tmpdir(), "browxai-refused-"));
    register(REFUSER, new Map([["navigate", WHY]]));
    register(PLAIN, undefined);
    for (const kind of [REFUSER, PLAIN]) {
      const server = await createServer({ headless: true, browserType: kind });
      await server.handlers.open_session({ session: `s-${kind}` });
      servers.set(kind, server);
    }
    if (priorWorkspace === undefined) delete process.env.BROWX_WORKSPACE;
    else process.env.BROWX_WORKSPACE = priorWorkspace;
  }, 30_000);

  it("navigate refuses, and the refusal names the engine and carries the reason", async () => {
    const res = await servers.get(REFUSER)!.handlers.navigate({ url: "https://example.com" });
    const body = JSON.parse((res.content[0] as { text: string }).text) as Body;
    expect(
      { ok: body.ok, engine: body.engine, hint: body.hint },
      "navigate answered on an engine that declares it refused. A well-formed " +
        "ActionResult for a navigation the engine must never perform is the worst " +
        "answer: the caller cannot tell it from a navigation that happened.",
    ).toEqual({ ok: false, engine: REFUSER, hint: WHY });
  });

  it("the same tool answers normally on an engine that refuses nothing", async () => {
    // The control. Without it, a gate that refused `navigate` unconditionally
    // would pass the case above.
    const res = await servers.get(PLAIN)!.handlers.navigate({ url: "https://example.com" });
    const body = JSON.parse((res.content[0] as { text: string }).text) as Body;
    expect(body.ok, "navigate must still work on an engine with no refusedTools").toBe(true);
  });

  it("refuses only the named tool, never its neighbours on the same engine", async () => {
    // `snapshot` renders a plain-text tree, not JSON — so the assertion is that
    // it produced one at all. A refusal would have been JSON with `ok:false`.
    const res = await servers.get(REFUSER)!.handlers.snapshot({});
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("url:");
    expect(text).not.toContain('"ok": false');
  });
});

describe("electron's shipped declaration", () => {
  it("refuses navigate and says where the page would have run", () => {
    const refusal = assertEngineRefuses("navigate", "electron");
    expect(refusal).not.toBeNull();
    expect(refusal!.error).toContain("electron");
    expect(refusal!.hint).toMatch(/INSIDE the application's own renderer process/);
  });

  it("keeps the rest of the navigation family, which operates inside the app", () => {
    // `reload` on VS Code is its own Cmd-R; `go_back` / `go_forward` walk the
    // renderer's own history. Refusing these to gate `navigate` would cost three
    // working tools for one, and `navigation` is one of the four sub-interfaces
    // no engine may omit — so the by-name declaration is the only shape that fits.
    for (const tool of ["reload", "go_back", "go_forward", "click", "snapshot", "find"]) {
      expect(assertEngineRefuses(tool, "electron"), `${tool} must not be refused`).toBeNull();
    }
  });

  it("is the only engine that refuses anything by name", () => {
    // A second engine growing a `refusedTools` entry is a deliberate act that
    // should be read, not inherited from a copy-paste.
    const withRefusals = (["chromium", "firefox", "webkit", "android", "safari"] as const).filter(
      (e) => (capabilitiesFor(e)!.refusedTools?.size ?? 0) > 0,
    );
    expect(withRefusals).toEqual([]);
  });
});
