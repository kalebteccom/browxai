// WebKit keystone — the proof the engine port generalizes to a real THIRD
// engine (RFC 0002 D7, P2c). It drives a real headless WebKit (Playwright's
// bundled WebKit build — the WebKit-ENGINE correctness lane, NOT Safari) end-to-
// end through the actual MCP tool handlers, the same way the firefox keystone
// drives real Firefox. This is the regression gate for the WebKit lane: mocked
// unit tests pass regardless of engine, so only a real-WebKit run proves the
// adapter launches, the seam tags the session webkit, the CDP-free class-A tools
// work via the page-side snapshot walker, and the CDP-deep tools structured-
// refuse through the CAPABILITY-based engine gate (no per-engine gate edit —
// WEBKIT_CAPABILITIES declares deep:false).
//
// SCOPE (mirrors the firefox keystone — both substrates are engine-agnostic, so
// WebKit gets the same surface):
//   RUNS on WebKit (class-A, CDP-free — Playwright's cross-browser surface):
//     - open_session(webkit) + list_sessions.engine === "webkit"
//     - cookies_set / cookies_list   (context-level cookie jar)
//     - dump_storage_state            (context.storageState)
//     - screenshot                    (page.screenshot)
//   RUNS on WebKit (P2a substrate — the page-side ARIA/DOM walker behind the
//   SnapshotSubstrate interface serves WebKit by CDP-absence, not engine name):
//     - navigate                      (page.goto + framenavigated nav detection)
//     - snapshot                      (the walker tree — real refs, [from-dom])
//     - find                          (ranks a target, locatorBoundingBox bbox)
//     - click / fill                  (action window over the walker a11y delta;
//                                      the network slice is empty — that is P2b)
//     - text_search                   (walker-sourced tree)
//   ASSERTS-REFUSAL on WebKit (CDP-deep — audit class B + live-CDP class C):
//     - perf_start / coverage_start / heap_snapshot / cpu_emulate
//     - pdf_save / set_user_agent / network_emulate
//     - shadow_trees  (closed-shadow pierce is CDP-only — RFC D4)
//   SKIPS on WebKit (P2b — needs the network CDP tap ported onto Playwright
//   events before the network slice of the envelope is populated):
//     - network_read / ws_read / network_body
//
// The per-engine expectation matrix lives in
// docs/ai-context/architecture/engine-adapters.md (the capability matrix table).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webkit as pwWebKit } from "playwright-core";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;

// WebKit is the opt-in third engine — skip cleanly (not fail) when its binary
// isn't installed, so the lane is green on a machine that only has Chromium.
const wkPath = (() => {
  try {
    return pwWebKit.executablePath();
  } catch {
    return "";
  }
})();
const webkitAvailable = !!wkPath && existsSync(wkPath);
const describeWk = webkitAvailable ? describe : describe.skip;

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
  if (!fn) throw new Error(`webkit keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

// snapshot returns plain text (header + serialised tree), not JSON.
async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const fn = handlers[name];
  if (!fn) throw new Error(`webkit keystone: no handler "${name}"`);
  const res = await fn(args);
  return (res.content[0] as { text: string }).text;
}

beforeAll(async () => {
  if (!webkitAvailable) return;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-wk-keystone-"));
  process.env.BROWX_WORKSPACE = workspace;
  // perf / coverage / heap / cpu / pdf / network_emulate / set_user_agent are all
  // in the default capability set (read/action), so the REFUSAL we observe is the
  // ENGINE gate (deep:false on webkit), not the capability gate.
  fixture = await startFixture();
  // The browserType knob threads through createServer → the session factories
  // (StartOptions.browserType). This is the WebKit keystone lane.
  server = await createServer({ headless: true, browserType: "webkit" });
  handlers = server.handlers;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  if (!webkitAvailable) return;
  await server?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describeWk("webkit keystone — the third engine is real (adapter + seam)", () => {
  it(
    "opens a real WebKit session and the seam tags it engine:webkit",
    async () => {
      const session = "wk-flow";
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
      // The headline of P2c: a real-browser session is tagged webkit through the
      // BrowserEngine port — the port generalized to a third engine.
      expect(row!.engine).toBe("webkit");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "drives the CDP-free class-A surface on real WebKit (cookies, storageState, screenshot)",
    async () => {
      const session = "wk-classA";
      await callJson("open_session", { session, mode: "incognito" });

      // cookies_set / cookies_list — context-level jar, Playwright cross-browser.
      const set = await callJson<{ ok: boolean }>("cookies_set", {
        session,
        name: "wk_ks",
        value: "present",
        url: fixture.url,
      });
      expect(set.ok).toBe(true);
      const list = await callJson<{ ok: boolean; cookies: Array<{ name: string; value: string }> }>(
        "cookies_list",
        { session, urls: [fixture.url] },
      );
      expect(list.ok).toBe(true);
      expect(list.cookies.some((c) => c.name === "wk_ks" && c.value === "present")).toBe(true);

      // dump_storage_state — context.storageState(), cross-browser.
      const dump = await callJson<{ ok: boolean; state?: { cookies?: unknown[] } }>(
        "dump_storage_state",
        { session },
      );
      expect(dump.ok).toBe(true);

      // screenshot — page.screenshot(), cross-browser. Default (no `path`) mode
      // returns an inline base64 image item (NOT a JSON envelope), so assert on
      // the raw content shape. Proves real-WebKit capture works.
      const shotRes = await handlers.screenshot!({ session });
      const imageItem = shotRes.content.find(
        (c): c is { type: "image"; data: string; mimeType: string } =>
          (c as { type: string }).type === "image",
      );
      expect(imageItem, "screenshot returns an image item on webkit").toBeTruthy();
      expect(imageItem!.data.length).toBeGreaterThan(0);
      expect(imageItem!.mimeType).toContain("image/");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "structured-refuses the CDP-deep tools on WebKit with engine:webkit + a hint",
    async () => {
      const session = "wk-refuse";
      await callJson("open_session", { session, mode: "incognito" });

      // A representative sample across the audit class-B families + the three
      // D6-reclassified tools. Each must refuse with the ENGINE gate (carries
      // `engine:"webkit"` + a hint), NOT crash and NOT a capability denial. This
      // is the proof the CAPABILITY-based gate auto-gates webkit (deep:false)
      // with no per-engine tool-gate.ts edit.
      const deepSample = [
        "perf_start",
        "coverage_start",
        "heap_snapshot",
        "cpu_emulate",
        "pdf_save",
        "set_user_agent",
        "network_emulate",
        "shadow_trees",
      ];
      for (const tool of deepSample) {
        const res = await callJson<{
          ok: boolean;
          engine?: string;
          error?: string;
          hint?: string;
          requiredCapability?: unknown;
        }>(tool, { session });
        expect(res.ok, `${tool} should refuse on webkit`).toBe(false);
        // The engine gate, not the capability gate (no requiredCapability key).
        expect(res.engine, `${tool} refusal carries engine`).toBe("webkit");
        expect(res.requiredCapability, `${tool} is NOT a capability denial`).toBeUndefined();
        expect(res.error).toContain(tool);
        expect(res.hint).toContain("chromium");
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "P2a substrate — snapshot/find/navigate/click/fill run on real WebKit via the walker",
    async () => {
      // The page-side snapshot/a11y walker behind the SnapshotSubstrate interface
      // serves WebKit (selected by CDP-absence), so the read + action core works
      // on real WebKit. This is the proof mocks cannot give (evaluate-
      // serialization only fails on a real engine — the page-side-function
      // discipline). Mirrors the firefox keystone's snapshot → find → fill → click
      // flow against the same fixture.
      const session = "wk-substrate";
      await callJson("open_session", { session, mode: "incognito" });

      // (0) navigate — page.goto + the Playwright `framenavigated` nav detector.
      // The action window builds its envelope with an EMPTY network slice (the
      // CDP tap is P2b) but a real a11y delta from the walker.
      const nav = await callJson<{ ok: boolean; navigation: { changed: boolean } }>("navigate", {
        session,
        url: `${fixture.url}/`,
      });
      expect(nav.ok).toBe(true);

      // (1) snapshot — the page-side walker actually ran against a real WebKit
      // page and surfaced the DOM-walk testIds. [from-dom] is the substrate
      // marker (WebKit has no CDP a11y tree; the walker is the source).
      const snap = await callText("snapshot", { session });
      expect(snap).toContain('[data-testid="save-btn"]');
      expect(snap).toContain('[data-testid="record-grid"]');
      expect(snap).toContain("[from-dom]");

      // (2) snapshot refs are STABLE across calls — the content-hashed ref for
      // the same element survives a re-snapshot (elementKey hashes
      // role/name/path/testId, not CDP node ids).
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
      // mints no backendDOMNodeId, so the CDP visible-rect path is skipped) —
      // proof the bbox story works off Chromium.
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
      expect(saveCand, "save-btn candidate ranked by find on webkit").toBeTruthy();
      expect(saveCand!.stability).toBe("high");
      expect(saveCand!.selectorTier).toBe(1);
      expect(saveCand!.actionable).toBe(true);
      expect(saveCand!.clipped).toBe(false);
      expect(saveCand!.bbox).not.toBeNull();

      // (4) fill — the action window dispatches via the Playwright locator and
      // builds the post-state probe from the walker a11y delta. The post-write
      // DOM value proves the action landed on real WebKit.
      const filled = await callJson<{
        ok: boolean;
        element?: { stillAttached: boolean; value?: string | null };
      }>("fill", {
        session,
        selector: '[data-testid="task-input"]',
        value: "webkit-substrate-keystone",
      });
      expect(filled.ok).toBe(true);
      expect(filled.element?.stillAttached).toBe(true);
      expect(filled.element?.value).toBe("webkit-substrate-keystone");

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
});
