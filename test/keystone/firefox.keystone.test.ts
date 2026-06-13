// Firefox keystone — the proof the engine port generalizes to a real SECOND
// engine. It drives a real headless Firefox (Playwright's bundled Juggler) end-
// to-end through the actual MCP tool handlers, the same way headless.keystone
// drives real Chromium. This is the regression gate for the multi-engine work:
// mocked unit tests pass regardless of engine, so only a real-Firefox run proves
// the adapter launches, the seam tags the session firefox, the CDP-free class-A
// tools work, and the CDP-deep tools structured-refuse.
//
// SCOPE (RFC 0002 P1 — the network/a11y CDP substrate is P2):
//   RUNS on Firefox (class-A, CDP-free — they ride Playwright's cross-browser
//   surface directly, not the CDP envelope/substrate):
//     - open_session(firefox) + list_sessions.engine === "firefox"
//     - cookies_set / cookies_list   (context-level cookie jar)
//     - dump_storage_state            (context.storageState)
//     - screenshot                    (page.screenshot)
//   ASSERTS-REFUSAL on Firefox (CDP-deep — audit class B + live-CDP class C):
//     - perf_start / coverage_start / heap_snapshot / cpu_emulate
//     - pdf_save / set_user_agent / network_emulate
//   SKIPS on Firefox (P2 — needs the snapshot/network CDP substrate ported, so
//   their ActionResult envelope can be built off Playwright events instead of
//   the CDP tap):
//     - navigate / snapshot / find / click / fill / network_read  (the
//       ActionResult envelope + a11y substrate are CDP-fed today; see the
//       per-engine matrix in engine-adapters.md)
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
      // The headline of P1: a real-browser session is tagged firefox through the
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
});
