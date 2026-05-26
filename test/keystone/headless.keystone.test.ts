// Headless-CI keystone — the sole remaining Phase-2-close exercise, and the
// live assertion for the three [~] Phase-2.5 exit criteria (zero-env config,
// two-user isolation, incognito no-trace).
//
// This is the ONLY test that drives a real headless Chromium end-to-end
// through the actual MCP tool handlers. Everything else in the suite is
// mock-based unit coverage. It deliberately runs from a separate vitest
// config so `pnpm test` stays hermetic and browser-free.
//
// Definition of done (AGENT-RUNBOOK.md "Phase 2 close"):
//   - BROWX_HEADLESS-equivalent works end-to-end (here: createServer({headless})
//     — programmatic, NOT the env-var singleton, exercising the session model).
//   - Zero BROWX_* *config* env; config flows through set_config/get_config.
//   - Six non-trivial primitives, deterministic token asserts.
//   - Two sessions = isolated cookie jars (no bleed).
//   - incognito leaves no filesystem trace (cwd untouched, no profile dir).
//   - await_human / the __browx visual banner are headless-unusable BY DESIGN
//     — covered as a documented, deliberately-skipped gap, not silent.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
let workspace: string;
let savedEnv: Record<string, string | undefined> = {};
const cwdBefore = process.cwd();

// Parse a JSON-tool response; ActionResult / find / config tools all return
// `{ content: [{ type:"text", text: <json> }] }`.
async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const fn = handlers[name];
  if (!fn) throw new Error(`keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

// snapshot returns plain text (header + serialised tree), not JSON.
async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await handlers[name]!(args);
  return (res.content[0] as { text: string }).text;
}

beforeAll(async () => {
  // Hard zero-env: strip every BROWX_* so nothing leaks in from the dev shell
  // or CI. BROWX_WORKSPACE is a *location* anchor (not config — see
  // docs/tool-reference.md); point it at a throwaway tmp dir for hermeticity.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-keystone-"));
  process.env.BROWX_WORKSPACE = workspace;

  fixture = await startFixture();
  // headless via the programmatic option — proves the headless path without
  // BROWX_HEADLESS (the env-var singleton the runbook explicitly says NOT to
  // lean on; the keystone exercises the session/config model instead).
  server = await createServer({ headless: true });
  handlers = server.handlers;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describe("headless-CI keystone — six non-trivial primitives (incognito, zero-env)", () => {
  it(
    "drives snapshot → find → fill → choose_option → text_search → inspect with deterministic asserts",
    async () => {
      const session = "ks-flow";
      const opened = await callJson<{ ok: boolean; mode: string }>("open_session", {
        session,
        mode: "incognito",
      });
      expect(opened.ok).toBe(true);
      expect(opened.mode).toBe("incognito");

      const nav = await callJson<{ ok: boolean; navigation: { changed: boolean } }>(
        "navigate",
        { session, url: `${fixture.url}/` },
      );
      expect(nav.ok).toBe(true);

      // (1) snapshot — a11y + DOM-walk compose actually ran against a real page.
      const snap = await callText("snapshot", { session });
      expect(snap.toLowerCase()).toContain("keystone fixture"); // page <title> in the header
      expect(snap).toContain('[data-testid="save-btn"]'); // DOM-walk testIds surfaced
      expect(snap).toContain('[data-testid="record-grid"]');

      // (2) find — token-equality asserts on the stable target.
      const found = await callJson<{
        candidates: Array<{
          selectorHint: string; stability: string; actionable: unknown;
          selectorTier: number; bbox: unknown; clipped: boolean;
        }>;
      }>("find", { session, query: "the Save button", visibleOnly: true });
      const saveCand = found.candidates.find((c) => c.selectorHint.includes("save-btn"));
      expect(saveCand, "save-btn candidate present").toBeTruthy();
      expect(saveCand!.stability).toBe("high");
      expect(saveCand!.actionable).toBe(true);
      expect(saveCand!.selectorTier).toBe(1);
      expect(saveCand!.clipped).toBe(false);
      expect(saveCand!.bbox).not.toBeNull();

      // (3) fill — structured ActionResult with the post-write DOM value.
      const filled = await callJson<{
        ok: boolean; element?: { stillAttached: boolean; value?: string | null };
      }>("fill", {
        session,
        selector: '[data-testid="task-input"]',
        value: "hello-keystone",
      });
      expect(filled.ok).toBe(true);
      expect(filled.element?.stillAttached).toBe(true);
      expect(filled.element?.value).toBe("hello-keystone");

      // (4) choose_option — custom (non-<select>) combobox commit.
      const chosen = await callJson<{ ok: boolean; element?: unknown }>("choose_option", {
        session,
        selector: '[data-testid="type-select"]',
        option: "Beta",
      });
      expect(chosen.ok).toBe(true);
      expect(JSON.stringify(chosen.element)).toContain("Beta");

      // (5) text_search — presence AND absence are both deterministic.
      const present = await callJson<{ count: number }>("text_search", {
        session,
        text: "Persisted Row One",
        exact: true,
        // a bare <td>'s CDP visible-rect can be null even when rendered (the
        // W-O2 class — out of scope for text_search); presence of the grid
        // text is what this primitive verifies, not cell-level bbox.
        includeHidden: true,
      });
      expect(present.count).toBeGreaterThanOrEqual(1);
      const absent = await callJson<{ count: number }>("text_search", {
        session,
        text: "Definitely Absent Sentinel String",
        exact: true,
      });
      expect(absent.count).toBe(0);

      // (6) inspect — fixed-geometry box / computed state (round-9 surface).
      const box = await callJson<{
        found: boolean; box: { width: number; height: number }; visible: boolean;
      }>("inspect", { session, selector: '[data-testid="status-box"]' });
      expect(box.found).toBe(true);
      expect(box.visible).toBe(true);
      expect(Math.round(box.box.width)).toBe(200);
      expect(Math.round(box.box.height)).toBe(80);

      // point_probe — exercises the in-page-script-with-args path against a
      // real browser (a string passed to page.evaluate is an expression, so a
      // `function(arg){…}` string is never called and args are dropped → the
      // probe must use an arg-less IIFE). A regression here threw before
      // returning, so a non-empty `stack` is the guard.
      const probe = await callJson<{ ok: boolean; stack: unknown[] }>("point_probe", {
        session, coords: { x: 40, y: 40 },
      });
      expect(probe.ok).toBe(true);
      expect(Array.isArray(probe.stack)).toBe(true);
      expect(probe.stack.length).toBeGreaterThan(0); // html/body at minimum

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("headless-CI keystone — multi-field form fill (one dispatch, atomic resolution)", () => {
  it(
    "fills one field + clicks submit in a single action window, returning per-field probes",
    async () => {
      const session = "ks-fillform";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });

      // Atomic-resolution test 1: one bad selector → ok:false, NO partial fills.
      // The form's task-input starts blank; if atomic resolution leaked, that
      // input would carry "ALICE" after this call. We assert it's still blank.
      const rejected = await callJson<{
        ok: boolean; error?: string; fieldResolution?: Array<{ ok: boolean; targetSummary: string }>;
      }>("fill_form", {
        session,
        fields: [
          { selector: '[data-testid="task-input"]', value: "ALICE" },
          { selector: '[data-testid="this-field-does-not-exist"]', value: "BOB" },
        ],
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toMatch(/atomic pre-resolution rejected/);
      expect(rejected.fieldResolution?.some((r) => !r.ok)).toBe(true);

      // Atomic invariant: the resolvable input is still blank because the
      // call rejected before any fill landed.
      const blankCheck = await callJson<{ ok: boolean }>("verify_value", {
        session, selector: '[data-testid="task-input"]', value: "",
      });
      expect(blankCheck.ok).toBe(true);

      // Happy path: one field + submit. Asserts the loop reached the submit
      // click (saved-state flips Unsaved → Saved OK) and that `elements[0]`
      // probe reflects the post-fill DOM value.
      const filled = await callJson<{
        ok: boolean;
        element?: { stillAttached: boolean };
        elements?: Array<{ value?: string | null; stillAttached: boolean }>;
      }>("fill_form", {
        session,
        fields: [{ selector: '[data-testid="task-input"]', value: "fill-form-keystone" }],
        submit: { selector: '[data-testid="save-btn"]' },
      });
      expect(filled.ok).toBe(true);
      expect(filled.elements?.length).toBe(1);
      expect(filled.elements?.[0]?.value).toBe("fill-form-keystone");
      // `element` (singular) is the submit's post-click probe, present when
      // a submit was supplied.
      expect(filled.element?.stillAttached).toBe(true);

      // App-side proof the submit actually clicked through.
      const savedState = await callJson<{ ok: boolean }>("verify_text", {
        session, selector: '[data-testid="saved-state"]', text: "Saved OK", exact: true,
      });
      expect(savedState.ok).toBe(true);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("headless-CI keystone — MCP-driven config model (zero env)", () => {
  it("get_config reflects built-in defaults; set_config persists and re-resolves", async () => {
    const before = await callJson<{ config: { confirmRequired: string[] } }>("get_config", {
      scope: "resolved",
    });
    // No BROWX_* env → pure built-in defaults, proving config is not env-driven.
    expect(before.config.confirmRequired).toContain("byob_action");

    const set = await callJson<{ ok: boolean; resolved: { testAttributes: string[] } }>(
      "set_config",
      { scope: "project", patch: { testAttributes: ["data-ks", "data-testid"] } },
    );
    expect(set.ok).toBe(true);
    expect(set.resolved.testAttributes).toEqual(["data-ks", "data-testid"]);

    const after = await callJson<{ config: { testAttributes: string[] } }>("get_config", {
      scope: "resolved",
    });
    expect(after.config.testAttributes).toEqual(["data-ks", "data-testid"]);
  });
});

describe("headless-CI keystone — two-user cookie-jar isolation", () => {
  it("a cookie set in session A is not visible to session B", async () => {
    const a = await callJson<{ ok: boolean }>("open_session", {
      session: "ks-user-a",
      mode: "incognito",
    });
    expect(a.ok).toBe(true);
    const b = await callJson<{ ok: boolean }>("open_session", {
      session: "ks-user-b",
      mode: "incognito",
    });
    expect(b.ok).toBe(true);

    // A: visit a route that Set-Cookies, then read it back via /echo. The
    // /echo page renders the received Cookie header verbatim into the
    // serialised snapshot, so the snapshot text is an unambiguous signal.
    await callJson("navigate", { session: "ks-user-a", url: `${fixture.url}/?setcookie=1` });
    await callJson("navigate", { session: "ks-user-a", url: `${fixture.url}/echo` });
    const aEcho = await callText("snapshot", { session: "ks-user-a" });
    expect(aEcho).toContain("ks=present");

    // B: same /echo, never set the cookie — must see NONE (no jar bleed).
    await callJson("navigate", { session: "ks-user-b", url: `${fixture.url}/echo` });
    const bEcho = await callText("snapshot", { session: "ks-user-b" });
    expect(bEcho).not.toContain("ks=present");
    expect(bEcho).toContain("COOKIE=NONE");

    await callJson("close_sessions", { prefix: "ks-user-" });
  });
});

describe("headless-CI keystone — incognito no-trace", () => {
  it("an incognito session lifecycle leaves cwd untouched and no profile dir", async () => {
    const cwdListBefore = readdirSync(cwdBefore).sort();

    await callJson("open_session", { session: "ks-notrace", mode: "incognito" });
    await callJson("navigate", { session: "ks-notrace", url: `${fixture.url}/` });
    await callText("snapshot", { session: "ks-notrace" });
    await callJson("close_session", { session: "ks-notrace" });

    // cwd is never a write target (no-trace contract).
    expect(readdirSync(cwdBefore).sort()).toEqual(cwdListBefore);
    // incognito is ephemeral — it must not create a managed profile dir.
    const wsEntries = readdirSync(workspace);
    expect(wsEntries).not.toContain("profile");
    expect(wsEntries).not.toContain("profiles");
  });
});

// Documented, deliberate gap — NOT a silent skip. Under headless there is no
// human at a screen, so the `__browx` on-page banner is not visually present
// and `await_human` (confirm/choose/input/pick_element/acknowledge) cannot be
// satisfied. Everything else in the surface works headless; these are
// human-in-the-loop primitives by definition. The runbook anticipates exactly
// this and asks for it to be named, not hidden.
describe("headless-CI keystone — known headless gap (await_human / __browx banner)", () => {
  it.skip("await_human is unusable headless by design — no human at a screen", () => {
    // Intentionally skipped: documents the boundary of the headless path.
    // If a future change makes a non-blocking headless ack path exist, turn
    // this into a real assertion.
  });
});
