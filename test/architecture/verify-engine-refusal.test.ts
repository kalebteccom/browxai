// The `verify_*` family must REFUSE on an engine with no Playwright `Page`, and
// the refusal must be structurally separable from a failed assertion.
//
// Before the fix, each handler called `e.session.page()` inside the same `try`
// whose `catch` renders the caught message as `failure:{source:"browxai",
// actual:<message>}`. On safari that accessor throws, so `verify_visible`
// published `ok:false` + a `failure` block for a check it had never run. An agent
// reads that as "the assertion failed"; so does the human signing off a QA
// recording. The engine gate did not cover it — the `verify_*` family is
// `capability:"read"`, not `deep:true`.
//
// Two synthetic engines drive it, so the whole test is browser-free and lands in
// the default `pnpm test` suite: one declaring no `page` sub-interface (the
// safari shape) and one declaring it (the chromium shape). The assertions are on
// the SHAPE — a refusal carries `engine` + `hint` and NO `failure` key; a failed
// assertion carries `failure.source` and no `engine` — never on message text.

import { describe, it, expect, beforeAll } from "vitest";
import type { Page } from "playwright-core";
import type { EngineCapabilities, EngineKind } from "../../src/engine/index.js";
import type { BrowserSession } from "../../src/session/types.js";
import { createServer } from "../../src/server.js";
import { registerEngine } from "../../src/engine/registry.js";
import { inMemorySubstrateBundle } from "./_synthetic-engine.js";

const NO_PAGE = "verify-no-page" as EngineKind;
const WITH_PAGE = "verify-with-page" as EngineKind;

/** The five element/count verifies that reach `session.page()`. `verify_predicate`
 *  is excluded — it evaluates a caller-supplied data bag and touches no page. */
const PAGE_BOUND_VERIFIES = [
  "verify_visible",
  "verify_text",
  "verify_value",
  "verify_count",
  "verify_attribute",
] as const;

/** Argument bags that reach the page path on each tool. */
const ARGS: Record<(typeof PAGE_BOUND_VERIFIES)[number], Record<string, unknown>> = {
  verify_visible: { selector: "#absent" },
  verify_text: { selector: "#absent", text: "hello" },
  verify_value: { selector: "#absent", value: "hello" },
  verify_count: { selector: "#absent", n: 1 },
  verify_attribute: { selector: "#absent", attr: "aria-pressed" },
};

function subInterfaces(withPage: boolean): EngineCapabilities["subInterfaces"] {
  const base = ["lifecycle", "navigation", "snapshot", "input"] as const;
  return new Set(withPage ? [...base, "page" as const] : base);
}

/** A Playwright-`Page`-shaped fake whose locator matches nothing — enough for the
 *  element verifies to run to a GENUINE `source:"app"` miss. */
function emptyPage(): Page {
  const locator = () => ({
    count: () => Promise.resolve(0),
    first() {
      return this;
    },
  });
  return {
    url: () => "about:blank",
    title: () => Promise.resolve("fake"),
    locator,
  } as unknown as Page;
}

function session(kind: EngineKind, withPage: boolean): BrowserSession {
  const page = withPage ? emptyPage() : null;
  return {
    mode: "managed" as const,
    ownsBrowser: true,
    engine: kind,
    page: () => {
      // The safari shape: present-but-throwing, exactly what RFC 0004 named an
      // L5 violation and what the handlers used to catch into a `failure`.
      if (!page) throw new Error(`${kind}-no-playwright-page`);
      return page;
    },
    close: async () => {},
  };
}

function register(kind: EngineKind, withPage: boolean): void {
  registerEngine({
    kind,
    capabilities: { engine: kind, subInterfaces: subInterfaces(withPage), deep: false },
    makeAdapter: async () => session(kind, withPage),
    makeSubstrates: (deps) => inMemorySubstrateBundle(deps),
    postWire: () => {},
  });
}

type Body = {
  ok: boolean;
  error?: string;
  engine?: string;
  hint?: string;
  failure?: { source?: string; kind?: string; expected?: string; actual?: string };
};

async function callVerify(
  server: Awaited<ReturnType<typeof createServer>>,
  tool: (typeof PAGE_BOUND_VERIFIES)[number],
): Promise<Body> {
  const res = await server.handlers[tool](ARGS[tool]);
  return JSON.parse((res.content[0] as { text: string }).text) as Body;
}

describe("verify_* refuses on an engine with no `page` sub-interface", () => {
  let noPage: Awaited<ReturnType<typeof createServer>>;
  let withPage: Awaited<ReturnType<typeof createServer>>;

  beforeAll(async () => {
    register(NO_PAGE, false);
    register(WITH_PAGE, true);
    noPage = await createServer({ headless: true, browserType: NO_PAGE });
    withPage = await createServer({ headless: true, browserType: WITH_PAGE });
    await noPage.handlers.open_session({ session: "no-page" });
    await withPage.handlers.open_session({ session: "with-page" });
  });

  for (const tool of PAGE_BOUND_VERIFIES) {
    it(`${tool} returns a refusal, not a failed assertion, with no page sub-interface`, async () => {
      const body = await callVerify(noPage, tool);

      // THE structural claim: a refusal has no `failure` block at all. Anything
      // that reads `failure` to decide whether the product is broken cannot
      // mistake this for a broken product.
      expect(
        body.failure,
        `${tool} must not emit an assertion failure it never ran`,
      ).toBeUndefined();
      expect(body.ok).toBe(false);
      // It names the engine and the missing sub-interface (the gate's contract).
      expect(body.engine).toBe(NO_PAGE);
      expect(body.error).toContain(NO_PAGE);
      expect(body.error).toContain("page");
      expect(typeof body.hint).toBe("string");
      // And it does NOT leak the accessor's throw as the answer.
      expect(JSON.stringify(body)).not.toContain("no-playwright-page");
    });
  }

  it("the refusal envelope matches the engine gate's, so one classifier covers both", async () => {
    const refusal = await callVerify(noPage, "verify_visible");
    expect(Object.keys(refusal).sort()).toEqual([
      "engine",
      "error",
      "hint",
      "ok",
      "tokensEstimate",
    ]);
  });
});

describe("verify_* on an engine that declares `page` is unchanged", () => {
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeAll(async () => {
    server = await createServer({ headless: true, browserType: WITH_PAGE });
    await server.handlers.open_session({ session: "unchanged" });
  });

  // verify_count is excluded: it also needs raw CDP, which this deep:false
  // synthetic engine lacks. Its unchanged-path proof is the Chromium keystone.
  for (const tool of [
    "verify_visible",
    "verify_text",
    "verify_value",
    "verify_attribute",
  ] as const) {
    it(`${tool} still reports a genuine miss as a failed assertion`, async () => {
      const body = await callVerify(server, tool);

      expect(body.ok).toBe(false);
      expect(body.failure, `${tool} must still emit a structured failure`).toBeDefined();
      expect(body.failure!.source).toBe("app");
      // The gate did NOT fire: no engine-refusal fields on the assertion path.
      expect(body.engine).toBeUndefined();
      expect(body.hint).toBeUndefined();
    });
  }
});
