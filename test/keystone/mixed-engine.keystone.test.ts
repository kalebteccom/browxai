// Mixed-engine keystone — the proof that per-session `open_session({engine})`
// lets ONE server drive sessions on DIFFERENT engines at the same time. A single
// chromium-DEFAULT server opens a chromium session (engine omitted) AND a real
// firefox session (engine:"firefox") side by side, and:
//   - list_sessions shows both engines simultaneously,
//   - the open_session result carries each session's engine,
//   - navigate + snapshot actually drive BOTH engines (the firefox snapshot is
//     the page-side walker [from-dom]; the chromium one is the CDP a11y tree),
//   - the CDP-deep engine gate is PER-SESSION: perf_start refuses on the firefox
//     session (engine:"firefox") but not as an engine refusal on chromium.
//
// Mocks can't prove this: only two real, different-engine browsers in one process
// exercise the effectiveEngine threading + per-session substrate/gate resolution.
// Gated on the Firefox binary — skips cleanly (not fails) on a Chromium-only box.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firefox as pwFirefox } from "playwright-core";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;

const ffPath = (() => {
  try {
    return pwFirefox.executablePath();
  } catch {
    return "";
  }
})();
const firefoxAvailable = !!ffPath && existsSync(ffPath);
const describeMixed = firefoxAvailable ? describe : describe.skip;

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
  if (!fn) throw new Error(`mixed-engine keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const fn = handlers[name];
  if (!fn) throw new Error(`mixed-engine keystone: no handler "${name}"`);
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
  workspace = mkdtempSync(join(tmpdir(), "browx-mixed-keystone-"));
  process.env.BROWX_WORKSPACE = workspace;
  fixture = await startFixture();
  // A chromium-DEFAULT server (no browserType) — exactly what a normal operator
  // runs. The firefox session is selected purely per-call via open_session.
  server = await createServer({ headless: true });
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

describeMixed("mixed-engine keystone — one server, chromium + firefox sessions", () => {
  it(
    "opens chromium (default) and firefox (per-session) in one server; result + list carry each engine",
    async () => {
      // chromium-a: engine OMITTED → inherits the server default (chromium),
      // byte-identical to the legacy path.
      const chromium = await callJson<{ ok: boolean; engine?: string }>("open_session", {
        session: "chromium-a",
        mode: "incognito",
      });
      expect(chromium.ok).toBe(true);
      expect(chromium.engine, "open_session result carries the chromium engine").toBe("chromium");

      // firefox-b: engine selected PER SESSION on the same chromium-default server.
      const firefox = await callJson<{ ok: boolean; engine?: string }>("open_session", {
        session: "firefox-b",
        engine: "firefox",
        mode: "incognito",
      });
      expect(firefox.ok).toBe(true);
      expect(firefox.engine, "open_session result carries the per-session firefox engine").toBe(
        "firefox",
      );

      // Both engines coexist in ONE server's registry.
      const listed = await callJson<{ sessions: Array<{ id: string; engine: string }> }>(
        "list_sessions",
        {},
      );
      const byId = new Map(listed.sessions.map((s) => [s.id, s.engine]));
      expect(byId.get("chromium-a")).toBe("chromium");
      expect(byId.get("firefox-b")).toBe("firefox");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "navigate + snapshot actually drive BOTH engines on real pages in one server",
    async () => {
      for (const session of ["chromium-a", "firefox-b"]) {
        const nav = await callJson<{ ok: boolean }>("navigate", {
          session,
          url: `${fixture.url}/`,
        });
        expect(nav.ok, `${session} navigates`).toBe(true);
        const snap = await callText("snapshot", { session });
        // A real snapshot of the real fixture proves the session's engine actually
        // drove a page — the chromium one via its CDP substrate, the firefox one
        // via the Playwright page-side walker, both resolved per-session.
        expect(snap, `${session} snapshot has the fixture testid`).toContain(
          '[data-testid="save-btn"]',
        );
        expect(snap, `${session} snapshot ranks the record grid`).toContain(
          '[data-testid="record-grid"]',
        );
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "the CDP-deep engine gate is PER-SESSION: perf_start refuses on firefox, not on chromium",
    async () => {
      // firefox has no `deep` capability → perf_start structured-refuses with the
      // ENGINE gate (carries engine:"firefox").
      const ff = await callJson<{ ok: boolean; engine?: string; error?: string }>("perf_start", {
        session: "firefox-b",
      });
      expect(ff.ok, "perf_start refuses on the firefox session").toBe(false);
      expect(ff.engine, "the refusal is the per-session ENGINE gate").toBe("firefox");

      // chromium has `deep` → the engine gate does NOT fire on the chromium session
      // in the SAME server (no engine:"chromium" refusal). Proves the gate keys on
      // the per-session engine, not a process-global.
      const cr = await callJson<{ ok: boolean; engine?: string }>("perf_start", {
        session: "chromium-a",
      });
      expect(cr.engine, "chromium session is not engine-refused for a deep tool").toBeUndefined();
    },
    KEYSTONE_TIMEOUT,
  );
});
