// Touch keystone — drives the CDP touch pipeline against a real headless
// Chromium. The fixture's `[data-testid="touch-pad"]` div wires
// `ontouchstart` / `ontouchmove` / `ontouchend` handlers that increment
// counters and capture `changedTouches[].identifier`, then renders both
// into a tagged `<output>` the keystone can read back via verify_text.
//
// The unit suite proves each tool dispatches the right CDP shape; this
// keystone proves the dispatched events actually fire DOM handlers on a
// real browser — the headless-CI guarantee ships.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await handlers[name]!(args);
  return (res.content[0] as { text: string }).text;
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-touch-keystone-"));
  process.env.BROWX_WORKSPACE = workspace;
  fixture = await startFixture();
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

// Resolve touch-pad centre once per test — page layout doesn't shift after
// the initial render, so a stale bbox isn't a risk inside one test scope.
async function touchPadCentre(session: string): Promise<{ x: number; y: number }> {
  const box = await callJson<{
    found: boolean;
    box: { x: number; y: number; width: number; height: number };
  }>("inspect", { session, selector: '[data-testid="touch-pad"]' });
  expect(box.found).toBe(true);
  return { x: box.box.x + box.box.width / 2, y: box.box.y + box.box.height / 2 };
}

describe("touch keystone — primitives fire DOM handlers on the touch pipeline", () => {
  it(
    "touch_start → touch_move → touch_end land on the fixture's ontouch* handlers",
    async () => {
      const session = "ks-touch-primitives";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });

      const centre = await touchPadCentre(session);

      const r1 = await callJson<{ ok: boolean; tokensEstimate: number }>("touch_start", {
        session,
        coords: centre,
      });
      expect(r1.ok).toBe(true);
      expect(r1.tokensEstimate).toBeGreaterThan(0);

      const r2 = await callJson<{ ok: boolean; tokensEstimate: number }>("touch_move", {
        session,
        coords: { x: centre.x + 10, y: centre.y },
      });
      expect(r2.ok).toBe(true);

      const r3 = await callJson<{ ok: boolean; tokensEstimate: number }>("touch_end", {
        session,
      });
      expect(r3.ok).toBe(true);

      const log = await callText("snapshot", { session });
      expect(log).toMatch(/start=1 move=1 end=1/);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "gesture_swipe fires multiple touchmoves with a single identifier",
    async () => {
      const session = "ks-touch-swipe";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });
      const centre = await touchPadCentre(session);

      const r = await callJson<{
        ok: boolean;
        steps: number;
        durationMs: number;
        tokensEstimate: number;
      }>("gesture_swipe", {
        session,
        from: { x: centre.x - 50, y: centre.y },
        to: { x: centre.x + 50, y: centre.y },
        durationMs: 0, // skip real waits in CI
        steps: 6,
      });
      expect(r.ok).toBe(true);
      expect(r.steps).toBe(6);

      const log = await callText("snapshot", { session });
      // 1 start, 6 moves, 1 end; identifier should be a single value (1).
      expect(log).toMatch(/start=1 move=6 end=1 ids=1/);
      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "gesture_pinch fires two distinct identifiers — multi-touch fan-out",
    async () => {
      const session = "ks-touch-pinch";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });
      const centre = await touchPadCentre(session);

      const r = await callJson<{
        ok: boolean;
        scale: number;
        steps: number;
        startOffset: number;
        endOffset: number;
        tokensEstimate: number;
      }>("gesture_pinch", {
        session,
        coords: centre,
        scale: 0.5,
        steps: 4,
        startOffset: 30,
      });
      expect(r.ok).toBe(true);
      expect(r.endOffset).toBe(15);

      const log = await callText("snapshot", { session });
      // Chromium fires one `touchstart` per new finger (not one event with
      // both finger ids in `changedTouches`), so two fingers in one CDP
      // dispatch surface as start=2. Same for the final lift: end=2. Moves
      // coalesce per dispatch — 4 CDP touchMoves = 4 handler invocations.
      // The keystone's guarantee is: both ids land on the DOM side
      // (multi-touch fan-out works) — that's the `ids=1,2` assertion.
      expect(log).toMatch(/start=2 move=4 end=2 ids=1,2/);
      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "touch primitives accept a custom identifier — agent-controlled fan-out",
    async () => {
      const session = "ks-touch-id";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });
      const centre = await touchPadCentre(session);

      await callJson("touch_start", { session, coords: centre, identifier: 42 });
      await callJson("touch_end", { session, identifier: 42 });

      const log = await callText("snapshot", { session });
      expect(log).toMatch(/start=1 move=0 end=1 ids=42/);
      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});
