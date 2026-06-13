// Safari keystone — the proof the engine port generalizes to a real FIFTH engine
// and the FIRST non-Playwright one. It drives REAL Safari.app
// over safaridriver end-to-end through the actual MCP tool handlers. This is the
// regression gate for the no-Playwright-Page seam: mocked unit tests pass
// regardless, so only a real-Safari run proves the adapter launches safaridriver,
// the session tags engine:safari, page() throws (no Playwright Page), the snapshot
// substrate reads via WebDriver Classic execute/sync, navigate routes through the
// Safari-native client, and the deep tools structured-refuse via the capability
// gate (deep:false).
//
// SCOPE (the curated subset — 200-tool parity on Safari is impossible):
//   RUNS on Safari (each via its capability port — engine-blind handlers):
//     - open_session(persistent) + list_sessions.engine === "safari"
//     - navigate / click / fill (ActionSubstrate → WebDriver Classic)
//     - snapshot / find         (SnapshotSubstrate — DOM-walk over execute/sync)
//     - screenshot              (CaptureSubstrate — full-document PNG)
//     - cookies_set / cookies_list (StorageSubstrate — WebDriver cookie jar)
//   ASSERTS-REFUSAL on Safari (deep:false — the CDP-deep family):
//     - perf_start / heap_snapshot  (engine gate, engine:"safari")
//
// NON-BYOB: every safari session is an isolated automation window (no cookies/
// storage/history from the real profile). There is NO headless Safari — this
// keystone opens REAL windows when it runs (mac only); it skips cleanly elsewhere.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;

// safaridriver is macOS-only — skip cleanly (not fail) when not on a Mac with it
// installed, so the lane is green on Linux/CI and on a Mac that hasn't enabled it.
const safariAvailable = (() => {
  if (process.platform !== "darwin") return false;
  try {
    statSync("/usr/bin/safaridriver");
    return true;
  } catch {
    return false;
  }
})();
const describeSafari = safariAvailable ? describe : describe.skip;

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
  if (!fn) throw new Error(`safari keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const fn = handlers[name];
  if (!fn) throw new Error(`safari keystone: no handler "${name}"`);
  const res = await fn(args);
  return (res.content[0] as { text: string }).text;
}

beforeAll(async () => {
  if (!safariAvailable) return;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-safari-keystone-"));
  process.env.BROWX_WORKSPACE = workspace;
  fixture = await startFixture();
  // browserType threads through createServer → the session factories. safari has
  // no headless; the default mode for a non-android, non-attach engine is
  // "persistent" → openManagedSession → the SafaridriverHybridAdapter.
  server = await createServer({ browserType: "safari" });
  handlers = server.handlers;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  if (!safariAvailable) return;
  await server?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describeSafari("safari keystone — the fifth engine is real (first non-Playwright)", () => {
  // safaridriver is effectively single-automation-session; reuse ONE isolated
  // window across the assertions (open_session is idempotent on the same id).
  const SESSION = "safari-main";
  it(
    "opens a real Safari session and the seam tags it engine:safari",
    async () => {
      const session = SESSION;
      const opened = await callJson<{ ok: boolean; error?: string }>("open_session", {
        session,
        mode: "persistent",
      });
      expect(opened.ok, `open_session failed: ${JSON.stringify(opened)}`).toBe(true);

      const listed = await callJson<{ sessions: Array<{ id: string; engine: string }> }>(
        "list_sessions",
        {},
      );
      const row = listed.sessions.find((s) => s.id === session);
      expect(row, "opened session present in list_sessions").toBeTruthy();
      expect(row!.engine).toBe("safari");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "navigate (WebDriver Classic) + snapshot (DOM-walk over execute/sync) + find on real Safari",
    async () => {
      const session = SESSION;
      await callJson("open_session", { session, mode: "persistent" });

      // navigate — routes through safariNavigate → WebDriver Classic POST url
      // (NOT the Playwright action envelope, which needs a Page Safari lacks).
      const nav = await callJson<{ ok: boolean; navigation: { changed: boolean; to: string } }>(
        "navigate",
        { session, url: `${fixture.url}/` },
      );
      expect(nav.ok).toBe(true);
      expect(nav.navigation.to).toContain(fixture.url);

      // snapshot — the SafariClassicSnapshotSubstrate ran browxai's DOM-walk over
      // safaridriver execute/sync against a real Safari page and surfaced the
      // DOM-walk testIds. [from-dom] is the substrate marker.
      const snap = await callText("snapshot", { session });
      expect(snap).toContain('[data-testid="save-btn"]');
      expect(snap).toContain("[from-dom]");

      // snapshot refs are STABLE across calls (content-hashed elementKey, not a
      // protocol node id) — same property as firefox/webkit.
      const refOf = (text: string, testId: string): string | undefined =>
        text.match(new RegExp(`\\[ref=(e\\d+)\\][^\\n]*\\[data-testid="${testId}"\\]`))?.[1] ??
        text.match(new RegExp(`\\[data-testid="${testId}"\\][^\\n]*\\[ref=(e\\d+)\\]`))?.[1];
      const ref1 = refOf(snap, "save-btn");
      expect(ref1, "save-btn ref present").toBeTruthy();
      const snap2 = await callText("snapshot", { session });
      expect(refOf(snap2, "save-btn"), "ref stable across re-snapshot").toBe(ref1);

      // find — ranks a target from the substrate-sourced tree.
      const found = await callJson<{
        candidates: Array<{ selectorHint: string }>;
      }>("find", { session, query: "the Save button", visibleOnly: false });
      expect(
        found.candidates.some((c) => c.selectorHint.includes("save-btn")),
        "save-btn ranked by find on safari",
      ).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "structured-refuses the CDP-deep tools on Safari with engine:safari",
    async () => {
      const session = SESSION;
      await callJson("open_session", { session, mode: "persistent" });

      for (const tool of ["perf_start", "heap_snapshot"]) {
        const res = await callJson<{
          ok: boolean;
          engine?: string;
          requiredCapability?: unknown;
        }>(tool, { session });
        expect(res.ok, `${tool} should refuse on safari`).toBe(false);
        // The ENGINE gate (deep:false), not the capability gate.
        expect(res.engine, `${tool} refusal carries engine:safari`).toBe("safari");
        expect(res.requiredCapability, `${tool} is NOT a capability denial`).toBeUndefined();
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "drives the action subset on real Safari (fill → click → eval → screenshot → cookies)",
    async () => {
      const session = SESSION;
      await callJson("open_session", { session, mode: "persistent" });
      await callJson("navigate", { session, url: `${fixture.url}/` });

      // fill — WebDriver element clear + sendKeys; the post-fill value is read
      // back via Get Element Property.
      const filled = await callJson<{ ok: boolean; element?: { value?: string } }>("fill", {
        session,
        selector: '[data-testid="task-input"]',
        value: "safari-action-keystone",
      });
      expect(filled.ok, `fill: ${JSON.stringify(filled)}`).toBe(true);
      expect(filled.element?.value).toBe("safari-action-keystone");

      // click — a REAL WebDriver elementClick (trusted; fires app handlers). The
      // fixture flips #saved to "Saved OK". The app-side re-render is async, and
      // `wait_for` isn't on Safari's curated subset, so poll text_search briefly
      // rather than assert on a single immediate read (avoids a render-timing flake).
      const clicked = await callJson<{ ok: boolean }>("click", {
        session,
        selector: '[data-testid="save-btn"]',
      });
      expect(clicked.ok, `click: ${JSON.stringify(clicked)}`).toBe(true);
      let savedCount = 0;
      for (let attempt = 0; attempt < 10 && savedCount === 0; attempt++) {
        const saved = await callJson<{ count: number }>("text_search", {
          session,
          text: "Saved OK",
          exact: true,
          includeHidden: true,
        });
        savedCount = saved.count;
        if (savedCount === 0) await new Promise((r) => setTimeout(r, 150));
      }
      expect(savedCount, 'click effect "Saved OK" should appear (polled)').toBeGreaterThanOrEqual(
        1,
      );

      // screenshot — full-document PNG via WebDriver, returned as an image item.
      const shot = await handlers.screenshot!({ session });
      const image = shot.content.find(
        (c): c is { type: "image"; data: string; mimeType: string } =>
          (c as { type: string }).type === "image",
      );
      expect(image, "screenshot returns an image item on safari").toBeTruthy();
      expect(image!.data.length).toBeGreaterThan(0);

      // cookies — set on the current document's domain, then read the jar back.
      const set = await callJson<{ ok: boolean }>("cookies_set", {
        session,
        name: "safari_ks",
        value: "present",
        url: fixture.url,
      });
      expect(set.ok, `cookies_set: ${JSON.stringify(set)}`).toBe(true);
      const list = await callJson<{ cookies: Array<{ name: string; value: string }> }>(
        "cookies_list",
        { session },
      );
      expect(list.cookies.some((c) => c.name === "safari_ks" && c.value === "present")).toBe(true);

      // localStorage — page-side JS over WebDriver execute/sync (StorageSubstrate;
      // a real working capability on the no-Page Safari engine). Round-trip proves
      // the execute/sync web-storage path against real Safari, not just a mock.
      const lsSet = await callJson<{ ok: boolean }>("localstorage_set", {
        session,
        key: "ks_key",
        value: "ks_val",
      });
      expect(lsSet.ok, `localstorage_set: ${JSON.stringify(lsSet)}`).toBe(true);
      const lsGet = await callJson<{ value: string | null }>("localstorage_get", {
        session,
        key: "ks_key",
      });
      expect(lsGet.value).toBe("ks_val");
    },
    KEYSTONE_TIMEOUT,
  );
});
