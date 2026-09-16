// L5 — an engine's DECLARED sub-interfaces and what its tools actually do agree.
//
// `EngineCapabilities.subInterfaces` is a ten-valued declaration each adapter
// makes about itself, and until RFC 0009 P1 it had ZERO production readers: every
// reference outside `types.ts` and the `capabilities.ts` tables was in a test.
// P1 promotes it to load-bearing control flow — `sub-interface.ts`,
// `session-page.ts` and the substrate selectors all read it — so this phase is
// also the one that has to start enforcing it. A declaration nothing checks rots;
// that is the documented LSP failure, and the DAP spec says as much about its own
// capabilities ("no guarantees"). The reader and the enforcer land together.
//
// The drift is not hypothetical. Safari declares no `network` sub-interface and
// `SafariNoopNetworkSubstrate` answers `http.recent()` with
// `{summary:{total:0,…}, requests:[]}` — a well-formed "no traffic occurred" for
// a question the engine cannot answer. `capabilities.ts` says in so many words
// that "the network tools must REFUSE on Safari, not skip"; they did not.
//
// THE FIXTURE. One synthetic engine per sub-interface, each declaring all ten
// EXCEPT its own, driven through the real server. Its substrates ANSWER
// plausibly (`inMemorySubstrateBundle(deps, "answering")`), which is the whole
// design: a throwing substrate would make an ungated tool fail for the wrong
// reason and the missing gate would look like a present one. Here an ungated tool
// returns a well-formed result, and that is the failure this file reports.
//
// A refusal is structurally distinguishable from a result: `{ok:false, error,
// engine, hint}` with no payload key. That is the same shape
// `verify-engine-refusal.test.ts` asserts, for the same reason — a caller must be
// able to tell "the engine cannot" from "the answer is no".

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineCapabilities, EngineKind, EngineSubInterface } from "../../src/engine/index.js";
import { ENGINE_KINDS, capabilitiesFor } from "../../src/engine/index.js";
import type { BrowserSession } from "../../src/session/types.js";
import { createServer } from "../../src/server.js";
import { registerEngine } from "../../src/engine/registry.js";
import { inMemorySubstrateBundle } from "./_synthetic-engine.js";

const ALL_SUBS: readonly EngineSubInterface[] = [
  "lifecycle",
  "navigation",
  "snapshot",
  "input",
  "network",
  "storage",
  "script",
  "emulation",
  "capture",
  "page",
];

/** The four sub-interfaces every engine MUST declare. They are not optional
 *  capabilities, they are what makes something an engine at all: it opens and
 *  closes a session, it goes somewhere, it can be read, and it can be acted on.
 *  RFC 0008's `ios-app` / `android-app` declare all four — a native engine has a
 *  lifecycle, a deep-link navigation, an accessibility tree and a touch surface.
 *
 *  So the claim for these is DECLARATION, not refusal, and it is the stronger
 *  claim: no engine may omit one. The alternative — building a refusal path into
 *  `snapshot` / `navigate` / `click` for an engine that could never register — is
 *  the speculative generality architecture-principles.md §4a forbids, and it
 *  would be a branch no shipped engine could ever take, which is to say untested
 *  code on the hottest path in the server. */
const MANDATORY: readonly EngineSubInterface[] = ["lifecycle", "navigation", "snapshot", "input"];

/** The tools whose implementation NEEDS each OPTIONAL sub-interface, with the
 *  reason. A tool listed here must refuse on an engine that omits it. */
const CONSUMERS: Record<
  EngineSubInterface,
  { why: string; tools: Array<{ name: string; args: Record<string, unknown> }> }
> = {
  network: {
    why: "all three serve the protocol-level network rings the engine's network substrate attaches",
    tools: [
      { name: "network_read", args: {} },
      { name: "ws_read", args: {} },
      { name: "network_body", args: { requestId: "r1" } },
    ],
  },
  storage: {
    why: "cookies / web-storage / IndexedDB / Cache API all dispatch to the storage substrate",
    tools: [
      { name: "cookies_list", args: {} },
      { name: "localstorage_list", args: {} },
      { name: "idb_list_databases", args: {} },
      { name: "caches_list_storages", args: {} },
    ],
  },
  script: {
    why: "page-side evaluation dispatches to the script substrate",
    tools: [{ name: "eval_js", args: { expr: "1+1" } }],
  },
  emulation: {
    why: "the three live-mutator emulation knobs dispatch to the emulation substrate",
    tools: [
      { name: "set_geolocation", args: { latitude: 1, longitude: 2 } },
      { name: "set_color_scheme", args: { scheme: "dark" } },
      { name: "set_reduced_motion", args: { motion: "reduce" } },
    ],
  },
  capture: {
    why: "screenshot dispatches to the capture substrate",
    tools: [{ name: "screenshot", args: {} }],
  },
  page: {
    why: "the element verifies resolve through a Playwright Locator off the session's Page",
    tools: [
      { name: "verify_visible", args: { selector: "#absent" } },
      { name: "verify_count", args: { selector: "#absent", n: 1 } },
    ],
  },
  snapshot: {
    why: "MANDATORY — the read core is universal; every engine answers snapshot/find or it is not an engine",
    tools: [],
  },
  input: {
    why: "MANDATORY — the action verbs are universal; an engine that cannot be acted on is not an engine",
    tools: [],
  },
  navigation: {
    why: "MANDATORY — every engine goes somewhere (a URL, a deep link, a screen id)",
    tools: [],
  },
  lifecycle: {
    why: "MANDATORY — session open/close is the adapter itself; an engine that cannot open one never reaches a tool",
    tools: [],
  },
};

type Body = {
  ok?: boolean;
  error?: string;
  engine?: string;
  hint?: string;
};

function subInterfacesExcept(omit: EngineSubInterface): EngineCapabilities["subInterfaces"] {
  return new Set(ALL_SUBS.filter((s) => s !== omit));
}

function syntheticSession(kind: EngineKind, hasPage: boolean): BrowserSession {
  const base = {
    mode: "managed" as const,
    ownsBrowser: true,
    engine: kind,
    close: async (): Promise<void> => {},
  };
  // The declaration is the oracle: an engine declaring `"page"` supplies the
  // handle and one that does not omits it, which is what port-conformance holds
  // every shipped engine to.
  return hasPage
    ? {
        ...base,
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
      }
    : base;
}

function registerProbe(kind: EngineKind, subs: EngineCapabilities["subInterfaces"]): void {
  registerEngine({
    kind,
    capabilities: { engine: kind, subInterfaces: subs, deep: false },
    makeAdapter: async () => syntheticSession(kind, subs.has("page")),
    makeSubstrates: (deps) => inMemorySubstrateBundle(deps, "answering"),
    postWire: () => {},
  });
}

const OMITTING = ALL_SUBS.filter((s) => CONSUMERS[s].tools.length > 0);

describe("L5 — declared sub-interfaces match what the tools do", () => {
  const servers = new Map<EngineSubInterface, Awaited<ReturnType<typeof createServer>>>();

  const priorCaps = process.env.BROWX_CAPABILITIES;
  const priorWorkspace = process.env.BROWX_WORKSPACE;

  beforeAll(async () => {
    // Hermetic workspace: the persisted config store lives at
    // `<workspace>/config.json` and its `user` layer OUTRANKS the env var below,
    // so a developer machine with a capability set saved would silently drive
    // this file with different capabilities than CI.
    process.env.BROWX_WORKSPACE = mkdtempSync(join(tmpdir(), "browxai-sub-iface-"));
    // `network-body`, `eval` and `device-emulation` are off by default, and the
    // capability gate runs BEFORE the sub-interface gate — correct order, since a
    // disabled tool must not open a session. Without them enabled, `network_body`
    // / `eval_js` / `set_geolocation` would refuse for the CAPABILITY and this
    // file would never reach the assertion it exists for.
    process.env.BROWX_CAPABILITIES =
      "read,navigation,action,human,network-body,eval,device-emulation";
    for (const sub of OMITTING) {
      const kind = `probe-no-${sub}` as EngineKind;
      registerProbe(kind, subInterfacesExcept(sub));
      const server = await createServer({ headless: true, browserType: kind });
      await server.handlers.open_session({ session: `s-${sub}` });
      servers.set(sub, server);
    }
    if (priorCaps === undefined) delete process.env.BROWX_CAPABILITIES;
    else process.env.BROWX_CAPABILITIES = priorCaps;
    if (priorWorkspace === undefined) delete process.env.BROWX_WORKSPACE;
    else process.env.BROWX_WORKSPACE = priorWorkspace;
  }, 30_000);

  it("names a consumer set and a reason for every sub-interface", () => {
    for (const sub of ALL_SUBS) {
      expect(CONSUMERS[sub], `${sub} has no consumer entry`).toBeDefined();
      expect(CONSUMERS[sub].why.length, `${sub} has no rationale`).toBeGreaterThan(20);
    }
  });

  it.each(ENGINE_KINDS)("[%s] declares every mandatory sub-interface", (engine) => {
    const caps = capabilitiesFor(engine)!;
    for (const sub of MANDATORY) {
      expect(
        caps.subInterfaces.has(sub),
        `${engine} omits the mandatory "${sub}" sub-interface. These four are not ` +
          "optional capabilities — they are what makes something an engine. If a new " +
          "engine genuinely cannot do one of them, it needs a refusal path in the tools " +
          "that consume it and an entry in CONSUMERS, in the same commit.",
      ).toBe(true);
    }
  });

  it("splits the ten sub-interfaces into exactly mandatory and gated", () => {
    // No third class. A sub-interface is either universal (asserted above) or
    // optional and therefore refusable (asserted below); one that is neither is a
    // declaration nothing reads, which is how this drift started.
    const gated = ALL_SUBS.filter((s) => CONSUMERS[s].tools.length > 0);
    expect([...MANDATORY, ...gated].sort()).toEqual([...ALL_SUBS].sort());
  });

  for (const sub of OMITTING) {
    for (const tool of CONSUMERS[sub].tools) {
      it(`${tool.name} refuses when the engine omits "${sub}"`, async () => {
        const server = servers.get(sub)!;
        let body: Body;
        try {
          const res = await server.handlers[tool.name](tool.args);
          const first = res.content[0] as { type: string; text?: string };
          body =
            first.type === "text" && first.text
              ? (JSON.parse(first.text) as Body)
              : { ok: true, error: `non-text content: ${first.type}` };
        } catch (err) {
          body = { ok: true, error: `threw: ${err instanceof Error ? err.message : String(err)}` };
        }
        expect(
          { ok: body.ok, engine: body.engine, hasHint: typeof body.hint === "string" },
          `${tool.name} answered instead of refusing on an engine with no "${sub}" ` +
            `sub-interface (${CONSUMERS[sub].why}). A plausible-looking result for a check ` +
            "that never ran is the worst answer: it is indistinguishable from a real one. " +
            `Gate it with subInterfaceGate("${tool.name}", "${sub}", e). Body: ` +
            JSON.stringify(body).slice(0, 300),
        ).toEqual({ ok: false, engine: `probe-no-${sub}`, hasHint: true });
      });
    }
  }

  it.each(ENGINE_KINDS)("[%s] every omitted sub-interface has a refusing gate", (engine) => {
    const caps = capabilitiesFor(engine)!;
    const omitted = ALL_SUBS.filter((s) => !caps.subInterfaces.has(s));
    for (const sub of omitted) {
      expect(
        CONSUMERS[sub].tools.length,
        `${engine} omits "${sub}" and no tool is listed as needing it — either the ` +
          "sub-interface is dead declaration data or its consumers are unlisted",
      ).toBeGreaterThan(0);
    }
  });
});
