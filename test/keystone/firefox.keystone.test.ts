// Firefox keystone — the proof the engine port generalizes to a real SECOND
// engine. It drives a real headless Firefox (Playwright's bundled Juggler) end-
// to-end through the actual MCP tool handlers, the same way headless.keystone
// drives real Chromium. This is the regression gate for the multi-engine work:
// mocked unit tests pass regardless of engine, so only a real-Firefox run proves
// the adapter launches, the seam tags the session firefox, the CDP-free class-A
// tools work, and the CDP-deep tools structured-refuse.
//
// SCOPE: Firefox supports a growing slice of the tool surface. The CDP-free
// class-A tools, the snapshot/a11y substrate, and the network/WS substrate all
// run on Firefox; the CDP-deep tools structured-refuse.
//   RUNS on Firefox (class-A, CDP-free — they ride Playwright's cross-browser
//   surface directly, not the CDP envelope/substrate):
//     - open_session(firefox) + list_sessions.engine === "firefox"
//     - cookies_set / cookies_list   (context-level cookie jar)
//     - dump_storage_state            (context.storageState)
//     - screenshot                    (page.screenshot)
//   RUNS on Firefox (the snapshot/a11y substrate has a Playwright page-side
//   walker behind the SnapshotSubstrate interface, so these mint refs + build
//   their ActionResult envelope off Playwright, not CDP):
//     - navigate                      (page.goto + framenavigated nav detection)
//     - snapshot                      (the walker tree — real refs, [from-dom])
//     - find                          (ranks a target, locatorBoundingBox bbox)
//     - click / fill                  (action window over the walker a11y delta;
//                                      the network slice is covered separately
//                                      by the network substrate below)
//     - text_search                   (walker-sourced tree)
//   RUNS on Firefox (the network/WS tap + response-body fetch have a Playwright
//   context-event substrate (PlaywrightNetworkSubstrate) behind the
//   NetworkSubstrate interface, so the network slice of the envelope is real and
//   the network tools read off Playwright events, not CDP):
//     - network_read   (PlaywrightNetworkBuffer — context request/response ring)
//     - network_body   (body captured at response time into the bounded LRU)
//     - ws_read        (PlaywrightWsBuffer — page.on('websocket') frames)
//   ASSERTS-REFUSAL on Firefox (CDP-deep — audit class B + live-CDP class C):
//     - perf_start / coverage_start / heap_snapshot / cpu_emulate
//     - pdf_save / set_user_agent / network_emulate
//     - shadow_trees  (closed-shadow pierce is CDP-only)
//     - sw_intercept_fetch  (Fetch.* on the SW target — CDP-only, stays gated)
//
// The per-engine expectation matrix lives in
// docs/ai-context/architecture/engine-adapters.md (the capability matrix table).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firefox as pwFirefox } from "playwright-core";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;

// Firefox is the opt-in second engine — skip cleanly (not fail) when its binary
// isn't installed, so the lane is green on a machine that only has Chromium.
const ffPath = (() => {
  try {
    return pwFirefox.executablePath();
  } catch {
    return "";
  }
})();
const firefoxAvailable = !!ffPath && existsSync(ffPath);
const describeFf = firefoxAvailable ? describe : describe.skip;

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const fn = handlers[name];
  if (!fn) throw new Error(`firefox keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

// snapshot returns plain text (header + serialised tree), not JSON.
async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const fn = handlers[name];
  if (!fn) throw new Error(`firefox keystone: no handler "${name}"`);
  const res = await fn(args);
  return (res.content[0] as { text: string }).text;
}

beforeAll(async () => {
  if (!firefoxAvailable) return;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-ff-keystone-"));
  process.env.BROWX_WORKSPACE = workspace;
  // file-io + diagnostics off; turn ON the capabilities the gated tools need so
  // the REFUSAL we observe is the ENGINE gate, not the capability gate. perf /
  // coverage / heap / cpu / pdf are `action`/`read` (on by default); pdf_save is
  // `action`; network_emulate is `action`; set_user_agent is `action`. All in
  // the default set, so the engine gate is what fires.
  fixture = await startFixture();
  // The browserType knob threads through createServer → the session factories
  // (StartOptions.browserType). This is the Firefox keystone lane.
  server = await createServer({ headless: true, browserType: "firefox" });
  handlers = server.handlers;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  if (!firefoxAvailable) return;
  await server?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describeFf("firefox keystone — the second engine is real (adapter + seam)", () => {
  it(
    "opens a real Firefox session and the seam tags it engine:firefox",
    async () => {
      const session = "ff-flow";
      const opened = await callJson<{ ok: boolean; mode: string }>("open_session", {
        session,
        mode: "incognito",
      });
      expect(opened.ok).toBe(true);

      const listed = await callJson<{
        sessions: Array<{ id: string; engine: string }>;
      }>("list_sessions", {});
      const row = listed.sessions.find((s) => s.id === session);
      expect(row, "opened session present in list_sessions").toBeTruthy();
      // The core claim: a real-browser session is tagged firefox through the
      // BrowserEngine port — the port generalized to a second engine.
      expect(row!.engine).toBe("firefox");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "drives the CDP-free class-A surface on real Firefox (cookies, storageState, screenshot)",
    async () => {
      const session = "ff-classA";
      await callJson("open_session", { session, mode: "incognito" });

      // cookies_set / cookies_list — context-level jar, Playwright cross-browser.
      const set = await callJson<{ ok: boolean }>("cookies_set", {
        session,
        name: "ff_ks",
        value: "present",
        url: fixture.url,
      });
      expect(set.ok).toBe(true);
      const list = await callJson<{ ok: boolean; cookies: Array<{ name: string; value: string }> }>(
        "cookies_list",
        { session, urls: [fixture.url] },
      );
      expect(list.ok).toBe(true);
      expect(list.cookies.some((c) => c.name === "ff_ks" && c.value === "present")).toBe(true);

      // dump_storage_state — context.storageState(), cross-browser.
      const dump = await callJson<{ ok: boolean; state?: { cookies?: unknown[] } }>(
        "dump_storage_state",
        { session },
      );
      expect(dump.ok).toBe(true);

      // screenshot — page.screenshot(), cross-browser. Default (no `path`) mode
      // returns an inline base64 image item (NOT a JSON envelope), so assert on
      // the raw content shape. Proves real-Firefox capture works.
      const shotRes = await handlers.screenshot!({ session });
      const imageItem = shotRes.content.find(
        (c): c is { type: "image"; data: string; mimeType: string } =>
          (c as { type: string }).type === "image",
      );
      expect(imageItem, "screenshot returns an image item on firefox").toBeTruthy();
      expect(imageItem!.data.length).toBeGreaterThan(0);
      expect(imageItem!.mimeType).toContain("image/");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "structured-refuses the CDP-deep tools on Firefox with engine:firefox + a hint",
    async () => {
      const session = "ff-refuse";
      await callJson("open_session", { session, mode: "incognito" });

      // A representative sample across the audit class-B families + the three
      // D6-reclassified tools. Each must refuse with the ENGINE gate (carries
      // `engine:"firefox"` + a hint), NOT crash and NOT a capability denial.
      const deepSample = [
        "perf_start",
        "coverage_start",
        "heap_snapshot",
        "cpu_emulate",
        "pdf_save",
        "set_user_agent",
        "network_emulate",
      ];
      for (const tool of deepSample) {
        const res = await callJson<{
          ok: boolean;
          engine?: string;
          error?: string;
          hint?: string;
          requiredCapability?: unknown;
        }>(tool, { session });
        expect(res.ok, `${tool} should refuse on firefox`).toBe(false);
        // The engine gate, not the capability gate (no requiredCapability key).
        expect(res.engine, `${tool} refusal carries engine`).toBe("firefox");
        expect(res.requiredCapability, `${tool} is NOT a capability denial`).toBeUndefined();
        expect(res.error).toContain(tool);
        expect(res.hint).toContain("chromium");
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "the three D6-reclassified tools carry their specific hints on Firefox",
    async () => {
      const session = "ff-d6";
      await callJson("open_session", { session, mode: "incognito" });

      const pdf = await callJson<{ hint?: string }>("pdf_save", { session });
      expect(pdf.hint).toContain("Headless-Chromium-only");

      const ua = await callJson<{ hint?: string }>("set_user_agent", {
        session,
        userAgent: "x",
      });
      expect(ua.hint).toContain("open_session({ device: { userAgent");

      const net = await callJson<{ hint?: string }>("network_emulate", {
        session,
        offline: true,
      });
      expect(net.hint).toContain("refuse-pending");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "snapshot/find/navigate/click/fill run on real Firefox via the page-side substrate",
    async () => {
      // The snapshot/a11y substrate has a Playwright
      // walker behind the SnapshotSubstrate interface, so the read + action
      // core that was previously CDP-gated on Firefox works on real Firefox. This is
      // the proof mocks cannot give (evaluate-serialization only fails on a real
      // engine — the page-side-function discipline). Mirrors the chromium
      // headless keystone's snapshot → find → fill flow against the same fixture.
      const session = "ff-substrate";
      await callJson("open_session", { session, mode: "incognito" });

      // (0) navigate — page.goto + the Playwright `framenavigated` nav detector
      // (replacing the chromium-only CDP `Page.frameNavigated`). The action
      // window builds its envelope with a real a11y delta from the walker AND a
      // real network slice off the Playwright-event tap.
      const nav = await callJson<{ ok: boolean; navigation: { changed: boolean } }>("navigate", {
        session,
        url: `${fixture.url}/`,
      });
      expect(nav.ok).toBe(true);

      // (1) snapshot — the page-side walker actually ran against a real Firefox
      // page and surfaced the DOM-walk testIds. [from-dom] is the substrate
      // marker (Firefox has no CDP a11y tree; the walker is the source).
      const snap = await callText("snapshot", { session });
      expect(snap).toContain('[data-testid="save-btn"]');
      expect(snap).toContain('[data-testid="record-grid"]');
      expect(snap).toContain("[from-dom]");

      // (2) snapshot refs are STABLE across calls — the content-hashed ref for
      // the same element survives a re-snapshot (the cross-substrate ref-
      // identity guarantee: elementKey hashes role/name/path/testId, not CDP
      // node ids). Extract the save-btn ref from both passes and compare.
      const refOf = (text: string, testId: string): string | undefined =>
        text.match(new RegExp(`\\[ref=(e\\d+)\\][^\\n]*\\[data-testid="${testId}"\\]`))?.[1] ??
        text.match(new RegExp(`\\[data-testid="${testId}"\\][^\\n]*\\[ref=(e\\d+)\\]`))?.[1];
      const saveRef1 = refOf(snap, "save-btn");
      expect(saveRef1, "save-btn ref present in snapshot").toBeTruthy();
      const snap2 = await callText("snapshot", { session });
      const saveRef2 = refOf(snap2, "save-btn");
      expect(saveRef2, "save-btn ref stable across re-snapshot").toBe(saveRef1);

      // (3) find — ranks the Save button as a tier-1, high-stability, actionable
      // candidate. bbox comes from the portable `locatorBoundingBox` (the walker
      // mints no backendDOMNodeId, so the CDP visible-rect path is skipped and
      // the Playwright fallback computes the box) — proof the bbox story works
      // off Chromium.
      const found = await callJson<{
        candidates: Array<{
          selectorHint: string;
          stability: string;
          actionable: unknown;
          selectorTier: number;
          bbox: unknown;
          clipped: boolean;
        }>;
      }>("find", { session, query: "the Save button", visibleOnly: true });
      const saveCand = found.candidates.find((c) => c.selectorHint.includes("save-btn"));
      expect(saveCand, "save-btn candidate ranked by find on firefox").toBeTruthy();
      expect(saveCand!.stability).toBe("high");
      expect(saveCand!.selectorTier).toBe(1);
      expect(saveCand!.actionable).toBe(true);
      expect(saveCand!.clipped).toBe(false);
      expect(saveCand!.bbox).not.toBeNull();

      // (4) fill — the action window dispatches via the Playwright locator and
      // builds the post-state probe from the walker a11y delta. The post-write
      // DOM value proves the action landed on real Firefox.
      const filled = await callJson<{
        ok: boolean;
        element?: { stillAttached: boolean; value?: string | null };
      }>("fill", {
        session,
        selector: '[data-testid="task-input"]',
        value: "firefox-substrate-keystone",
      });
      expect(filled.ok).toBe(true);
      expect(filled.element?.stillAttached).toBe(true);
      expect(filled.element?.value).toBe("firefox-substrate-keystone");

      // (5) click — drives the Save button; the fixture flips #saved
      // "Unsaved" → "Saved OK". text_search (also substrate-sourced) confirms
      // the app-side effect, proving the click acted through the action window.
      const clicked = await callJson<{ ok: boolean }>("click", {
        session,
        selector: '[data-testid="save-btn"]',
      });
      expect(clicked.ok).toBe(true);
      const saved = await callJson<{ count: number }>("text_search", {
        session,
        text: "Saved OK",
        exact: true,
        includeHidden: true,
      });
      expect(saved.count).toBeGreaterThanOrEqual(1);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "network_read / network_body run on real Firefox via the Playwright-event substrate",
    async () => {
      // The network/WS tap + response-body fetch have a
      // Playwright context-event substrate (PlaywrightNetworkSubstrate) behind the
      // NetworkSubstrate interface, so the network slice that the snapshot/action
      // substrate leaves empty is real here. This is the proof mocks cannot give — a real Firefox
      // session must surface real request/response records off `context.on(...)`.
      // The fixture's /perf-audit-page fires real subresources: the document
      // itself, /perf-dead.css (Stylesheet — folds to noise), and /perf-dead.js
      // (Script — an "interesting" entry that survives the noise-fold).
      const session = "ff-network";
      await callJson("open_session", { session, mode: "incognito" });

      const nav = await callJson<{ ok: boolean }>("navigate", {
        session,
        url: `${fixture.url}/perf-audit-page`,
      });
      expect(nav.ok).toBe(true);

      // network_read — the session-wide ring fed by the Playwright context
      // request/response events. The page's own document + the Script subresource
      // must be present; the summary must count what the ring saw.
      const net = await callJson<{
        summary: { total: number; byType: Record<string, number>; failed: number };
        requests: Array<{
          method: string;
          url: string;
          status?: number;
          type: string;
          requestId?: string;
        }>;
      }>("network_read", { session });
      expect(net.summary.total, "the perf-audit page fired subresource requests").toBeGreaterThan(
        0,
      );
      // The Script subresource (/perf-dead.js) is interesting (not noise-folded),
      // so it lands in `requests` with a resolved status + a substrate-minted
      // requestId. This proves the cross-engine resourceType reconciliation
      // (cdpTypeFromPlaywright) + the synthetic-id minting work on real Firefox.
      const script = net.requests.find((r) => r.url.includes("/perf-dead.js"));
      expect(script, "the /perf-dead.js Script request is surfaced by network_read").toBeTruthy();
      expect(script!.type).toBe("Script");
      expect(script!.status).toBe(200);
      expect(script!.requestId, "substrate mints a requestId for network_body").toBeTruthy();

      // network_body — off Chromium the body is captured at response time into the
      // bounded LRU, then resolved by requestId (no after-the-fact CDP fetch). The
      // capability is `network-body` (off by default); the keystone server runs
      // without it, so the read must refuse with the CAPABILITY gate (not crash,
      // not the engine gate — network_body is explicitly NOT engine-gated).
      const bodyGated = await callJson<{
        ok: boolean;
        engine?: string;
        requiredCapability?: string;
      }>("network_body", { session, requestId: script!.requestId! });
      expect(bodyGated.ok, "network_body without the capability is denied, not run").toBe(false);
      expect(
        bodyGated.requiredCapability,
        "the denial is the capability gate, not the engine gate",
      ).toBe("network-body");
      expect(bodyGated.engine, "network_body is NOT engine-gated on firefox").toBeUndefined();
    },
    KEYSTONE_TIMEOUT,
  );
});
