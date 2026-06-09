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
const savedEnv: Record<string, string | undefined> = {};
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

      const nav = await callJson<{ ok: boolean; navigation: { changed: boolean } }>("navigate", {
        session,
        url: `${fixture.url}/`,
      });
      expect(nav.ok).toBe(true);

      // (1) snapshot — a11y + DOM-walk compose actually ran against a real page.
      const snap = await callText("snapshot", { session });
      expect(snap.toLowerCase()).toContain("keystone fixture"); // page <title> in the header
      expect(snap).toContain('[data-testid="save-btn"]'); // DOM-walk testIds surfaced
      expect(snap).toContain('[data-testid="record-grid"]');

      // (2) find — token-equality asserts on the stable target.
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
      expect(saveCand, "save-btn candidate present").toBeTruthy();
      expect(saveCand!.stability).toBe("high");
      expect(saveCand!.actionable).toBe(true);
      expect(saveCand!.selectorTier).toBe(1);
      expect(saveCand!.clipped).toBe(false);
      expect(saveCand!.bbox).not.toBeNull();

      // (3) fill — structured ActionResult with the post-write DOM value.
      const filled = await callJson<{
        ok: boolean;
        element?: { stillAttached: boolean; value?: string | null };
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
        // a bare <td>'s CDP visible-rect can be null even when rendered
        // (out of scope for text_search); presence of the grid text is what
        // this primitive verifies, not cell-level bbox.
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
        found: boolean;
        box: { width: number; height: number };
        visible: boolean;
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
        session,
        coords: { x: 40, y: 40 },
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
        ok: boolean;
        error?: string;
        fieldResolution?: Array<{ ok: boolean; targetSummary: string }>;
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
        session,
        selector: '[data-testid="task-input"]',
        value: "",
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
        session,
        selector: '[data-testid="saved-state"]',
        text: "Saved OK",
        exact: true,
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

// Regression-style perf assertion for find() against DOM-walk-sourced
// candidates whose selector hint is NOT a valid Playwright locator. Pre-v0.2.1
// the per-candidate probe loop ran serially and let each Playwright probe
// call (`boundingBox`, `isEnabled`) auto-wait the full action-timeout window
// (default 5 s) when the hint didn't resolve to a real locator — and DOM-walk
// emits a bare tag name as `role` (e.g. `role="a"` for an <a>), which is not
// a valid ARIA role token, so Playwright's role-locator misses and the probe
// burns the full timeout per candidate. The outer 5 s actionTimeoutMs anti-
// wedge would clip this in default operation, so the *observed* pre-fix cost
// against a fixture with multiple such fall-through nodes was ~5 s (the anti-
// wedge ceiling) rather than candidates × 5 s; without the cap, pathological
// pages could still bump up against the 60 s keystone-suite deadline. Post-fix, find()
// bounds each probe at `PROBE_TIMEOUT_MS` (500 ms) and runs the per-candidate
// loop in parallel — bringing this case well under 1 s.
//
// The fixture node targeted below (<a data-testid="info-link">More info</a>)
// is deliberately chosen so its DOM-walked role-locator (`role=a`) is invalid
// and Playwright falls through the probe path that auto-waits. A different
// query that landed on a valid role-locator candidate (e.g. `role=button`
// from a native <button>) would NOT exercise the regression and the
// assertion would have no bite. The 3 s bound is the observed-after-fix
// number with headroom for slower CI hardware, not aspirational.
describe("headless-CI keystone — find() wall-clock regression", () => {
  it(
    "find() against a fall-through-role candidate completes well under the anti-wedge deadline",
    async () => {
      const session = "ks-find-perf";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });

      // Target the <a>More info link</a> fixture node (no testid). DOM-walk
      // emits `role="a"` (bare tag), buildSelectorHint() falls through to a
      // `role=a[name="More info link"]` hint, and Playwright's role-locator
      // can't resolve "a" as an ARIA role. Pre-fix the per-candidate probe
      // loop would auto-wait the action-timeout window on this hint until
      // the outer 5 s anti-wedge clipped the whole call; post-fix the
      // per-probe cap returns each miss in ≤500 ms and parallel execution
      // brings the total well inside 1 s.
      const t0 = Date.now();
      const found = await callJson<{
        candidates: Array<{ selectorHint: string }>;
      }>("find", { session, query: "More info link" });
      const elapsed = Date.now() - t0;

      expect(found.candidates.length).toBeGreaterThan(0);
      // Wall-clock bound chosen from observed post-fix numbers with headroom
      // for CI variance. A failure here means a probe call's auto-wait cap
      // has regressed — see PROBE_TIMEOUT_MS in src/page/find.ts.
      expect(elapsed).toBeLessThan(3_000);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

// permission_policy keystone: the simplest non-camera path (geolocation).
// Exercises the full stack — CDP `Browser.setPermission` baseline + in-page
// init-script wrapper around `navigator.geolocation.getCurrentPosition` —
// against a real Chromium. Asserts both directions (deny → error callback,
// allow → success callback after `set_permission_policy({mode:"allow"})`),
// captures `permissionRequests[]` on the click action's result, and confirms
// `permission_state` reports the CDP-side state matches.
describe("headless-CI keystone — permission_policy (geolocation, real Chromium)", () => {
  it(
    'default raise rejects, set_permission_policy({mode:"allow"}) lets it through, permissionRequests captured',
    async () => {
      const session = "ks-perm";
      await callJson("open_session", { session, mode: "incognito" });
      // Seed a deterministic geolocation reading so the allow branch has
      // numbers to assert on. The permission is gated independently — the
      // wrapper rejects regardless of whether coords are set.
      await callJson("set_geolocation", { session, latitude: 40.7128, longitude: -74.006 });
      await callJson("navigate", { session, url: `${fixture.url}/` });

      // (1) DEFAULT raise — the click triggers getCurrentPosition which the
      // wrapper rejects; the result text shows "denied" and the ActionResult
      // surfaces permissionRequests[{permission:"geolocation",handledAs:"raised"}].
      const clickRaised = await callJson<{
        ok: boolean;
        permissionRequests?: Array<{ permission: string; handledAs: string }>;
      }>("click", { session, selector: '[data-testid="geo-btn"]' });
      // The action probably completed as a Playwright click; raise mode flips
      // ok:false via UNHANDLED_PERMISSION_HINT. Either way the request was
      // recorded.
      expect(Array.isArray(clickRaised.permissionRequests)).toBe(true);
      const geoReq = clickRaised.permissionRequests!.find((r) => r.permission === "geolocation");
      expect(geoReq, "geolocation request recorded under raise mode").toBeTruthy();
      expect(geoReq!.handledAs).toBe("raised");
      // The page's async getCurrentPosition needs a beat to write the result;
      // poll the output until it transitions out of "pending".
      let resultText = "";
      for (let i = 0; i < 30 && !resultText.includes("denied"); i++) {
        resultText = await callText("snapshot", { session });
        if (resultText.includes("denied code=")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(resultText).toMatch(/denied code=1/);

      // (2) Flip policy to allow + re-trigger. The CDP baseline re-applies
      // (granted), the wrapper calls through, the page reports the seeded
      // coords back.
      const setPol = await callJson<{ ok: boolean; policy: { mode: string } }>(
        "set_permission_policy",
        { session, mode: "allow" },
      );
      expect(setPol.ok).toBe(true);
      expect(setPol.policy.mode).toBe("allow");

      const clickAllowed = await callJson<{
        ok: boolean;
        permissionRequests?: Array<{ permission: string; handledAs: string }>;
      }>("click", { session, selector: '[data-testid="geo-btn"]' });
      const allowReq = (clickAllowed.permissionRequests ?? []).find(
        (r) => r.permission === "geolocation",
      );
      expect(allowReq, "geolocation request recorded under allow mode").toBeTruthy();
      expect(allowReq!.handledAs).toBe("allowed");
      let allowText = "";
      for (let i = 0; i < 60 && !allowText.includes("allowed lat="); i++) {
        allowText = await callText("snapshot", { session });
        if (allowText.includes("allowed lat=")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(allowText).toMatch(/allowed lat=40\.7128 lng=-74\.006/);

      // (3) permission_state — CDP read-side reports "granted" now that the
      // baseline was re-applied under the allow mode.
      const state = await callJson<{ ok: boolean; states: Record<string, string> }>(
        "permission_state",
        { session, permissions: ["geolocation", "camera"] },
      );
      expect(state.ok).toBe(true);
      expect(state.states.geolocation).toBe("granted");
      // camera was never set per-permission; falls back to top-level "allow".
      expect(state.states.camera).toBe("granted");

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

// notification_policy keystone — exercises the full stack against a real
// Chromium: the page's `new Notification(...)` constructor is intercepted
// by attachNotificationPolicy's init-script wrapper, captured on
// ActionResult.notifications[], and the policy mode controls whether the
// constructor returns or throws NotAllowedError. This is the constructor-
// surface analog of the permission_policy keystone above (which covers
// Notification.requestPermission / the permission check — disjoint surface).
describe("headless-CI keystone — notification_policy (Notification constructor, real Chromium)", () => {
  it(
    "allow → constructor returns + recorded; deny → throws + recorded; raise flips ok:false",
    async () => {
      const session = "ks-notif";
      // Open with notificationPolicy:"allow" so the constructor returns;
      // permissionPolicy:"allow" (no "raise" deadlock) so the page side has
      // permission to construct in the first place.
      await callJson("open_session", {
        session,
        mode: "incognito",
        permissionPolicy: "allow",
        notificationPolicy: "allow",
      });
      await callJson("navigate", { session, url: `${fixture.url}/` });

      // (1) allow — the constructor returns a stub; notifications[] captures
      // the call.
      const clickAllow = await callJson<{
        ok: boolean;
        notifications?: Array<{ title: string; body?: string; tag?: string; handledAs: string }>;
      }>("click", { session, selector: '[data-testid="notif-btn"]' });
      expect(Array.isArray(clickAllow.notifications)).toBe(true);
      const nAllow = clickAllow.notifications!.find((n) => n.title === "hello");
      expect(nAllow, "Notification constructor captured under allow").toBeTruthy();
      expect(nAllow!.handledAs).toBe("allowed");
      expect(nAllow!.body).toBe("world");
      expect(nAllow!.tag).toBe("kt");
      // The page-side result text shows the stub's `title` property was
      // readable.
      let outText = "";
      for (let i = 0; i < 30 && !outText.includes("constructed"); i++) {
        outText = await callText("snapshot", { session });
        if (outText.includes("constructed title=hello")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(outText).toMatch(/constructed title=hello/);

      // (2) flip to deny — the constructor throws NotAllowedError.
      const setDeny = await callJson<{ ok: boolean; policy: { mode: string } }>(
        "set_notification_policy",
        { session, mode: "deny" },
      );
      expect(setDeny.ok).toBe(true);
      expect(setDeny.policy.mode).toBe("deny");

      const clickDeny = await callJson<{
        ok: boolean;
        notifications?: Array<{ title: string; handledAs: string }>;
      }>("click", { session, selector: '[data-testid="notif-btn"]' });
      expect(Array.isArray(clickDeny.notifications)).toBe(true);
      // The denied call's async binding records `handledAs: "denied"`; the
      // sync throw fires from the wrapper's pre-check hint.
      const nDeny = clickDeny.notifications!.find((n) => n.title === "hello");
      expect(nDeny, "deny call captured").toBeTruthy();
      let denyText = "";
      for (let i = 0; i < 30 && !denyText.includes("threw"); i++) {
        denyText = await callText("snapshot", { session });
        if (denyText.includes("threw name=NotAllowedError")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(denyText).toMatch(/threw name=NotAllowedError/);

      // (3) flip to raise — the constructor throws + flips ok:false on the
      // next action with the documented hint.
      const setRaise = await callJson<{ ok: boolean; policy: { mode: string } }>(
        "set_notification_policy",
        { session, mode: "raise" },
      );
      expect(setRaise.ok).toBe(true);
      expect(setRaise.policy.mode).toBe("raise");

      const clickRaise = await callJson<{
        ok: boolean;
        notifications?: Array<{ title: string; handledAs: string }>;
        failure?: { source: string; hint: string };
      }>("click", { session, selector: '[data-testid="notif-btn"]' });
      expect(clickRaise.ok).toBe(false);
      expect(clickRaise.failure?.source).toBe("app");
      expect(clickRaise.failure?.hint).toMatch(/notification/i);
      const nRaise = clickRaise.notifications!.find((n) => n.title === "hello");
      expect(nRaise?.handledAs).toBe("raised");

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

// Phase-7 frame-scoped observation — exercises frames_list, frame-scoped
// snapshot, frame-scoped find, and a frame-scoped action that fires inside
// the iframe (state mutation observable in a follow-up frame-scoped snapshot).
describe("headless-CI keystone — frame-scoped observation (Phase 7)", () => {
  it(
    "frames_list discovers iframes; snapshot/find/action scope to a child frame",
    async () => {
      const session = "ks-frames";
      const opened = await callJson<{ ok: boolean }>("open_session", {
        session,
        mode: "incognito",
      });
      expect(opened.ok).toBe(true);

      const nav = await callJson<{ ok: boolean }>("navigate", {
        session,
        url: `${fixture.url}/with-iframe`,
      });
      expect(nav.ok).toBe(true);

      // (1) frames_list — main + 2 iframes (same-origin /child + srcdoc).
      // Wait a moment for iframes to attach + load.
      let listing:
        | {
            ok: boolean;
            frames: Array<{ frameId: string; url: string; name: string; isMainFrame: boolean }>;
          }
        | undefined;
      for (let i = 0; i < 40; i++) {
        listing = await callJson("frames_list", { session });
        if ((listing!.frames ?? []).length >= 3) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(listing!.ok).toBe(true);
      expect(listing!.frames.length).toBeGreaterThanOrEqual(3);
      const main = listing!.frames.find((f) => f.isMainFrame)!;
      expect(main.frameId).toBe("f0");
      const sameOrigin = listing!.frames.find((f) => f.name === "same");
      const srcDoc = listing!.frames.find((f) => f.name === "data");
      expect(sameOrigin, "same-origin iframe present").toBeTruthy();
      expect(srcDoc, "srcdoc iframe present").toBeTruthy();

      // (2) Frame-scoped snapshot — child markup surfaces under the child frame.
      const childSnap = await callText("snapshot", { session, frame: sameOrigin!.frameId });
      expect(childSnap).toContain(`frame: ${sameOrigin!.frameId}`);
      expect(childSnap).toContain('[data-testid="child-save"]');
      expect(childSnap).toContain('[data-testid="child-input"]');
      // The CDP-a11y skip is surfaced as a warning per design.
      expect(childSnap.toLowerCase()).toContain("dom-walk-sourced");

      // (3) Frame-scoped find — returns a ref bound to the same-origin frame.
      const found = await callJson<{
        candidates: Array<{
          ref: string;
          selectorHint: string;
          stability: string;
          actionable: unknown;
        }>;
      }>("find", { session, query: "child save", frame: sameOrigin!.frameId, visibleOnly: true });
      const childSaveCand = found.candidates.find((c) => c.selectorHint.includes("child-save"));
      expect(childSaveCand, "child-save candidate present").toBeTruthy();
      expect(childSaveCand!.stability).toBe("high");
      expect(childSaveCand!.actionable).toBe(true);

      // (4) Frame-scoped action — clicking the ref fires inside the iframe.
      // State mutation in the iframe is observable in a follow-up frame-scoped snapshot.
      const clicked = await callJson<{ ok: boolean }>("click", {
        session,
        ref: childSaveCand!.ref,
      });
      expect(clicked.ok).toBe(true);
      let post = "";
      for (let i = 0; i < 60; i++) {
        post = await callText("snapshot", { session, frame: sameOrigin!.frameId });
        if (post.includes("child-saved")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(post).toContain("child-saved");

      // (5) Cross-origin-ish (srcdoc) frame — read works via the DOM-walk path.
      const dataSnap = await callText("snapshot", { session, frame: srcDoc!.frameId });
      expect(dataSnap).toContain('[data-testid="inside-data"]');

      // (6) Main-frame snapshot still works AND is unaffected by the iframe scope.
      const mainSnap = await callText("snapshot", { session });
      expect(mainSnap).toContain('[data-testid="host-btn"]');
      // child-* test ids belong to the iframe — they must NOT leak into the main-frame snapshot.
      expect(mainSnap).not.toContain('[data-testid="child-save"]');

      // (7) Unknown frameId → structured error, not a throw.
      const bogus = await callJson<{ ok: boolean; error?: string }>("snapshot", {
        session,
        frame: "f99",
      });
      expect(bogus.ok).toBe(false);
      expect(bogus.error).toMatch(/unknown frame/);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

// Phase 7 — Shadow DOM deep piercing. Exercises the three new surfaces
// (find/snapshot pierce options + shadow_trees) against a real Chromium
// page that defines one open-shadow and one closed-shadow custom element.
//
// The closed-shadow assertions are the load-bearing ones — they prove the
// CDP DOM.getDocument({pierce:true}) path actually surfaces content that
// is genuinely inaccessible from page-side JavaScript. Open-shadow is
// already covered by Playwright's a11y tree; this test is here to keep
// the pierce surface from regressing.
describe("headless-CI keystone — Shadow DOM deep piercing (Phase 7)", () => {
  it(
    "shadow_trees surfaces open + closed shadow hosts, find({pierce:'closed'}) sees closed-shadow content",
    async () => {
      const session = "ks-shadow";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });
      // Custom-element upgrades + the shadow attachment happen on
      // `connectedCallback`, which is microtask-deferred relative to
      // navigation settlement. Give it a beat to land.
      await new Promise((r) => setTimeout(r, 50));

      // (1) Default `snapshot` (no `includeShadow`) — back-compat. The
      // shadow content must NOT leak into the standard tree (Playwright's
      // a11y tree covers open-shadow at the AX level, but the DOM-walk
      // fallback's `[from-dom]` markers don't apply to shadow content
      // unless pierce is requested).
      const defaultSnap = await callText("snapshot", { session });
      expect(defaultSnap.toLowerCase()).toContain("keystone fixture");

      // (2) `shadow_trees` with no ref — walks the whole document, must
      // discover BOTH the open and closed widget hosts via the CDP path.
      const trees = await callJson<{
        trees: Array<{
          hostTag: string;
          mode: "open" | "closed";
          children: Array<{ tag: string; text?: string }>;
        }>;
        closedShadowAvailable: boolean;
        warnings: string[];
        tokensEstimate: number;
      }>("shadow_trees", { session });
      expect(typeof trees.tokensEstimate).toBe("number");
      expect(trees.tokensEstimate).toBeGreaterThan(0);
      const openHost = trees.trees.find((t) => t.hostTag === "open-widget");
      const closedHost = trees.trees.find((t) => t.hostTag === "closed-widget");
      expect(openHost, "open-widget host surfaced").toBeTruthy();
      expect(openHost!.mode).toBe("open");
      expect(openHost!.children.some((c) => c.tag === "button")).toBe(true);
      expect(closedHost, "closed-widget host surfaced — proves CDP pierce works").toBeTruthy();
      expect(closedHost!.mode).toBe("closed");
      expect(closedHost!.children.some((c) => c.tag === "button")).toBe(true);
      expect(trees.closedShadowAvailable).toBe(true);

      // (3) `find({pierce:'closed'})` discovers the closed-shadow CTA's
      // test-attr, but warns it's inspect-only. The selectorHint will be
      // tier-1 ([data-testid=…]) because the CDP walker reads the attr.
      const found = await callJson<{
        candidates: Array<{ selectorHint: string; stability: string; testId?: string }>;
        warnings: string[];
      }>("find", { session, query: "closed-widget-cta", pierce: "closed" });
      const closedCand = found.candidates.find((c) => c.testId === "closed-widget-cta");
      expect(closedCand, "closed-shadow candidate surfaced under pierce:'closed'").toBeTruthy();
      expect(closedCand!.selectorHint).toContain("closed-widget-cta");
      expect(found.warnings.some((w) => w.includes("CLOSED shadow root"))).toBe(true);

      // (4) Back-compat — find() without `pierce` MUST NOT surface
      // closed-shadow candidates (the CDP pierce call wasn't made).
      const foundDefault = await callJson<{ candidates: Array<{ testId?: string }> }>("find", {
        session,
        query: "closed-widget-cta",
      });
      const leaked = foundDefault.candidates.find((c) => c.testId === "closed-widget-cta");
      expect(leaked, "closed-shadow content must not leak into pierce-less find").toBeFalsy();

      // (5) `snapshot({includeShadow:'closed'})` — header surfaces the
      // closed-shadow stat and the inspect-only warning.
      const piercedSnap = await callText("snapshot", { session, includeShadow: "closed" });
      expect(piercedSnap).toMatch(/closedShadowEntries/);
      expect(piercedSnap).toMatch(/CLOSED shadow root/);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
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

// fs_picker_policy keystone lives in fs-picker.keystone.test.ts — it
// needs the off-by-default `file-io` capability (for fs_picker_respond),
// so it spins up its own server with the right env, same pattern as the
// page-archive keystone.
