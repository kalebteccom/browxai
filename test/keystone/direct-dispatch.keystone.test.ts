// direct-dispatch keystone — `click({ dispatch: "direct" })` against real
// headless Chromium.
//
// The load-bearing assertion is the CONTRAST, not the success: the fixture at
// `/unsettled-page` rebuilds the target's subtree on a timer while a rAF loop
// saturates the main thread, and on that page the default `click` — including
// its automatic `force: true` recovery — cannot land the click inside its
// budget. The same target IS clicked by `dispatch:"direct"`, and the page-side
// handler observes `isTrusted: true` plus the full
// pointerdown/mousedown/pointerup/mouseup/click chain. Drop the option and the
// first half still passes while the second fails, so this cannot pass without
// the fix.
//
// The posture test pins what direct dispatch does NOT bypass, which is the
// argument for shipping it opt-in-per-call rather than behind a capability: the
// browser still hit-tests the coordinate (an overlay eats the click) and a
// disabled control still fires nothing.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;
const CHURN_TARGET = '[data-testid="churn-target"]';

interface ActionResultShape {
  ok: boolean;
  warnings: string[];
  error?: string;
  element?: {
    stillAttached: boolean;
    hit?: {
      before?: { tag: string; text?: string } | null;
      after?: { tag: string; text?: string } | null;
    };
  };
}

interface VerifyShape {
  ok: boolean;
  failure?: { actual?: string };
}

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
const savedEnv: Record<string, string | undefined> = {};

async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const fn = handlers[name];
  if (!fn) throw new Error(`direct-dispatch keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

/** Assert one of the fixture's `data-testid` readouts through the public read
 *  surface, so the keystone never needs the `eval` capability. */
async function expectReadout(session: string, testId: string, text: string): Promise<void> {
  const r = await callJson<VerifyShape>("verify_text", {
    session,
    selector: `[data-testid="${testId}"]`,
    text,
  });
  expect(
    r.ok,
    `[${testId}] expected to contain "${text}", read "${r.failure?.actual ?? "?"}"`,
  ).toBe(true);
}

async function openOn(session: string, path: string): Promise<void> {
  const opened = await callJson<{ ok: boolean }>("open_session", { session, mode: "incognito" });
  expect(opened.ok).toBe(true);
  const nav = await callJson<{ ok: boolean }>("navigate", {
    session,
    url: `${fixture.url}${path}`,
    timeoutMs: 30_000,
  });
  expect(nav.ok).toBe(true);
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human";

  fixture = await startFixture();
  server = await createServer({ headless: true });
  handlers = server.handlers;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_CAPABILITIES;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
}, KEYSTONE_TIMEOUT);

describe("direct-dispatch keystone — the target the actionability path cannot reach", () => {
  it(
    'default click (with its force recovery) fails on the unsettled view; dispatch:"direct" lands a TRUSTED click on the same target',
    async () => {
      const session = "ks-direct-contrast";
      await openOn(session, "/unsettled-page");

      // Control: the shipped default path, which already auto-recovers to
      // `force: true` after its actionability budget. Both halves of the
      // contrast run on the shipped default deadline (5s — 3.5s actionability
      // then 1.5s force); a bigger budget for the control would only let the
      // force recovery win a race, which is a different claim.
      const control = await callJson<ActionResultShape>("click", {
        session,
        selector: CHURN_TARGET,
      });
      expect(control.ok).toBe(false);
      await expectReadout(session, "dispatch-log", "clicks=0");

      const direct = await callJson<ActionResultShape>("click", {
        session,
        selector: CHURN_TARGET,
        dispatch: "direct",
      });
      expect(direct.error).toBeUndefined();
      expect(direct.ok).toBe(true);

      await expectReadout(session, "dispatch-log", "clicks=1");
      await expectReadout(session, "dispatch-log", "trusted=true");
      await expectReadout(
        session,
        "dispatch-log",
        "seq=pointerdown,mousedown,pointerup,mouseup,click",
      );

      const warned = direct.warnings.join(" ");
      expect(warned).toContain('dispatch:"direct"');
      expect(warned).toContain("isTrusted:true");
      expect(direct.element?.hit?.before?.text).toContain("Send");

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "the browser still hit-tests: an overlay over the target eats the click, and a disabled control fires nothing",
    async () => {
      const session = "ks-direct-posture";
      await openOn(session, "/unsettled-page?churn=0");

      const covered = await callJson<ActionResultShape>("click", {
        session,
        selector: '[data-testid="covered-target"]',
        dispatch: "direct",
      });
      expect(covered.ok).toBe(true);
      // The dispatch happened at the covered button's coordinates, but the
      // overlay is what the browser hit-tested — the button's handler never ran,
      // and the result's own evidence names the overlay.
      await expectReadout(session, "covered-log", "covered=0");
      expect(covered.element?.hit?.before?.tag).toBe("div");

      const disabled = await callJson<ActionResultShape>("click", {
        session,
        selector: '[data-testid="disabled-target"]',
        dispatch: "direct",
      });
      expect(disabled.ok).toBe(true);
      await expectReadout(session, "disabled-log", "disabled=0");

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "an unset dispatch is the default path unchanged — a settled target still clicks, with no bypass warning",
    async () => {
      const session = "ks-direct-default";
      await openOn(session, "/unsettled-page?churn=0");

      const r = await callJson<ActionResultShape>("click", {
        session,
        selector: CHURN_TARGET,
      });
      expect(r.ok).toBe(true);
      await expectReadout(session, "dispatch-log", "clicks=1");
      expect(r.warnings.join(" ")).not.toContain('dispatch:"direct"');

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});
