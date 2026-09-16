// The `verify_*` family must REFUSE on an engine that cannot resolve an element,
// and the refusal must be structurally separable from a failed assertion.
//
// Before the fix, each handler called `e.session.page()` inside the same `try`
// whose `catch` renders the caught message as `failure:{source:"browxai",
// actual:<message>}`. On safari that accessor throws, so `verify_visible`
// published `ok:false` + a `failure` block for a check it had never run. An agent
// reads that as "the assertion failed"; so does the human signing off a QA
// recording. The engine gate did not cover it — the `verify_*` family is
// `capability:"read"`, not `deep:true`.
//
// RFC 0009 P2 moved the resolution behind `ElementSubstrate` and moved the gate
// with it, from `page` to `element`. That is not a rename. The family needs to
// RESOLVE AN ELEMENT; a Playwright `Page` was only ever the thing one engine
// family happened to resolve through, and the native engines RFC 0008 adds will
// declare `element` and no `page`. So the engine under test here is one that
// declares no `element`, and the second one declares `element` and answers through
// the REAL `PlaywrightElementSubstrate` over a page whose locator matches nothing
// — which is what keeps the second half of this file a genuine miss rather than a
// substrate that was told to say "miss".
//
// Two synthetic engines drive it, so the whole test is browser-free and lands in
// the default `pnpm test` suite. The assertions are on the SHAPE — a refusal
// carries `engine` + `hint` and NO `failure` key; a failed assertion carries
// `failure.source` and no `engine` — never on message text.

import { describe, it, expect, beforeAll } from "vitest";
import type { Page } from "playwright-core";
import type { EngineCapabilities, EngineKind } from "../../src/engine/index.js";
import type { BrowserSession } from "../../src/session/types.js";
import type { SessionEntry } from "../../src/session/registry.js";
import { createServer } from "../../src/server.js";
import { registerEngine } from "../../src/engine/registry.js";
import { PlaywrightElementSubstrate } from "../../src/page/element-substrate.js";
import { inMemorySubstrateBundle } from "./_synthetic-engine.js";

const NO_ELEMENT = "verify-no-element" as EngineKind;
const WITH_ELEMENT = "verify-with-element" as EngineKind;

/** The five element/count verifies that resolve through the element port.
 *  `verify_predicate` is excluded — it evaluates a caller-supplied data bag and
 *  touches no element. */
const ELEMENT_BOUND_VERIFIES = [
  "verify_visible",
  "verify_text",
  "verify_value",
  "verify_count",
  "verify_attribute",
] as const;

/** Argument bags that reach the element path on each tool. */
const ARGS: Record<(typeof ELEMENT_BOUND_VERIFIES)[number], Record<string, unknown>> = {
  verify_visible: { selector: "#absent" },
  verify_text: { selector: "#absent", text: "hello" },
  verify_value: { selector: "#absent", value: "hello" },
  verify_count: { selector: "#absent", n: 1 },
  verify_attribute: { selector: "#absent", attr: "aria-pressed" },
};

function subInterfaces(withElement: boolean): EngineCapabilities["subInterfaces"] {
  const base = ["lifecycle", "navigation", "snapshot", "input"] as const;
  return new Set(withElement ? [...base, "element" as const, "page" as const] : base);
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

function session(kind: EngineKind, withElement: boolean): BrowserSession {
  const page = withElement ? emptyPage() : null;
  return {
    mode: "managed" as const,
    ownsBrowser: true,
    engine: kind,
    page: () => {
      // The safari shape: present-but-throwing, exactly what RFC 0004 named an
      // L5 violation and what the handlers used to catch into a `failure`. It
      // stays present-and-throwing here precisely so the gate has something to
      // leak if it ever stops firing first.
      if (!page) throw new Error(`${kind}-no-playwright-page`);
      return page;
    },
    close: async () => {},
  };
}

function register(kind: EngineKind, withElement: boolean): void {
  registerEngine({
    kind,
    capabilities: { engine: kind, subInterfaces: subInterfaces(withElement), deep: false },
    makeAdapter: async () => session(kind, withElement),
    makeSubstrates: (deps) => {
      const bundle = inMemorySubstrateBundle(deps);
      if (!withElement) return bundle;
      // The real adapter over the empty page. The in-memory element substrate
      // answers "one visible element" by design (the conformance fixture needs
      // that), which would turn every case below into a PASS and prove nothing.
      return {
        ...bundle,
        element: (e: SessionEntry) =>
          new PlaywrightElementSubstrate(() => emptyPage(), {} as never, e.refs),
      };
    },
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
  tool: (typeof ELEMENT_BOUND_VERIFIES)[number],
): Promise<Body> {
  const res = await server.handlers[tool](ARGS[tool]);
  return JSON.parse((res.content[0] as { text: string }).text) as Body;
}

describe("verify_* refuses on an engine with no `element` sub-interface", () => {
  let noElement: Awaited<ReturnType<typeof createServer>>;

  beforeAll(async () => {
    register(NO_ELEMENT, false);
    register(WITH_ELEMENT, true);
    noElement = await createServer({ headless: true, browserType: NO_ELEMENT });
    await noElement.handlers.open_session({ session: "no-element" });
  });

  for (const tool of ELEMENT_BOUND_VERIFIES) {
    it(`${tool} returns a refusal, not a failed assertion, with no element sub-interface`, async () => {
      const body = await callVerify(noElement, tool);

      // THE structural claim: a refusal has no `failure` block at all. Anything
      // that reads `failure` to decide whether the product is broken cannot
      // mistake this for a broken product.
      expect(
        body.failure,
        `${tool} must not emit an assertion failure it never ran`,
      ).toBeUndefined();
      expect(body.ok).toBe(false);
      // It names the engine and the missing sub-interface (the gate's contract).
      expect(body.engine).toBe(NO_ELEMENT);
      expect(body.error).toContain(NO_ELEMENT);
      expect(body.error).toContain("element");
      expect(typeof body.hint).toBe("string");
      // And it does NOT leak the accessor's throw as the answer.
      expect(JSON.stringify(body)).not.toContain("no-playwright-page");
    });
  }

  it("the refusal envelope matches the engine gate's, so one classifier covers both", async () => {
    const refusal = await callVerify(noElement, "verify_visible");
    expect(Object.keys(refusal).sort()).toEqual([
      "engine",
      "error",
      "hint",
      "ok",
      "tokensEstimate",
    ]);
  });
});

describe("verify_* on an engine that declares `element` is unchanged", () => {
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeAll(async () => {
    server = await createServer({ headless: true, browserType: WITH_ELEMENT });
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
      // The zero-match miss is the port's `stale-element` refusal rendered as an
      // `app` failure — WebDriver's `stale element reference`, not its `no such
      // element`. The string is the one this path emitted before the port existed.
      expect(body.failure!.actual).toBe("missing (locator matched 0 nodes)");
      // The gate did NOT fire: no engine-refusal fields on the assertion path.
      expect(body.engine).toBeUndefined();
      expect(body.hint).toBeUndefined();
    });
  }
});
