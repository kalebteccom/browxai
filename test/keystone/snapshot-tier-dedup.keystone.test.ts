// Snapshot tier-dedup keystone — real headless Chromium against
// `/tier-dedup-page`.
//
// `snapshot` composes two tiers: the CDP accessibility tree and a page-side DOM
// walk. They used to duplicate every element, because their ref keys speak
// different vocabularies — ARIA role plus accessibility path against bare tag
// plus DOM path — so the same `<a>` was `link` at one key and `a` at another
// and no entry could ever match. `domWalkCombined` was 0 on every page measured
// and Hacker News reported its 228 anchors twice.
//
// The join is the backend node id, resolved through one `DOM.getDocument` sweep
// by the `:nth-child` path the DOM walk already builds. Only a real browser
// proves it: the identity is CDP's, the path is the live DOM's, and a mocked
// sweep is whatever the fixture author believed Chromium reports.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
const savedEnv: Record<string, string | undefined> = {};

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const fn = handlers[name];
  if (!fn) throw new Error(`tier-dedup keystone: no handler "${name}"`);
  const res = await fn(args);
  return (res.content[0] as { text: string }).text;
}

async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  return JSON.parse(await callText(name, args)) as T;
}

/** Every `[ref=…]` line, provenance markers included. */
function bodyOf(snapshot: string): string[] {
  return snapshot.split("\n").filter((l) => l.includes("[ref="));
}

function statsOf(snapshot: string): {
  tier: string;
  a11yInteractive: number;
  domWalkEntries: number;
  domWalkNew: number;
  domWalkCombined: number;
} {
  const line = snapshot.split("\n").find((l) => l.startsWith("stats: "));
  if (!line) throw new Error(`no stats line in snapshot:\n${snapshot}`);
  return JSON.parse(line.slice("stats: ".length));
}

function refOf(line: string): string {
  const ref = /\[ref=(e\d+)\]/.exec(line)?.[1];
  if (!ref) throw new Error(`no ref on line: ${line}`);
  return ref;
}

async function openOn(session: string): Promise<void> {
  const opened = await callJson<{ ok: boolean }>("open_session", { session, mode: "incognito" });
  expect(opened.ok).toBe(true);
  const nav = await callJson<{ ok: boolean }>("navigate", {
    session,
    url: `${fixture.url}/tier-dedup-page`,
  });
  expect(nav.ok).toBe(true);
}

/** The page's click log, as a pass/fail assertion against the live DOM. */
async function expectLog(session: string, expected: string): Promise<void> {
  const res = await callJson<{ ok: boolean; failure?: unknown }>("verify_text", {
    session,
    selector: "#dedup-log",
    text: expected,
    exact: true,
  });
  expect(res.ok, `#dedup-log should read "${expected}": ${JSON.stringify(res.failure)}`).toBe(true);
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

describe("snapshot keystone — the two tiers report one element once", () => {
  it(
    "gives one anchor one ref, and that ref clicks",
    async () => {
      const session = "ks-dedup-anchor";
      await openOn(session);
      const snap = await callText("snapshot", { session });
      const anchorLines = bodyOf(snap).filter((l) => l.includes('"Only Once"'));
      // Pre-join this was two lines: `link "Only Once" [ref=eN]` from the a11y
      // tier and `a "Only Once" [ref=eM] [from-dom]` from the DOM walk.
      expect(anchorLines, `anchor lines:\n${anchorLines.join("\n")}`).toHaveLength(1);
      expect(anchorLines[0]).toContain("link ");
      expect(anchorLines[0]).toContain("[from-both]");

      const clicked = await callJson<{ ok: boolean }>("click", {
        session,
        ref: refOf(anchorLines[0]!),
      });
      expect(clicked.ok).toBe(true);
      await expectLog(session, "anchor-clicked");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "keeps two same-role, same-name, same-testid elements apart",
    async () => {
      // The false-merge guard. `role + name` would have collapsed these two
      // buttons into one ref — they share their role, their accessible name AND
      // their test attribute, and differ only in position and in state. The
      // backend node id does not collapse them, because it is an identity
      // rather than a resemblance.
      const session = "ks-dedup-twins";
      await openOn(session);
      const snap = await callText("snapshot", { session });
      const saveLines = bodyOf(snap).filter((l) => l.includes('button "Save"'));
      expect(saveLines, `save lines:\n${saveLines.join("\n")}`).toHaveLength(2);
      expect(new Set(saveLines.map(refOf)).size).toBe(2);
      // Two lines that really are two elements: the second button is disabled
      // and the first is not, so a single element reported twice could not
      // produce this pair.
      expect(saveLines.filter((l) => l.includes("disabled"))).toHaveLength(1);
      // Both went through the join, so neither is a leftover duplicate.
      expect(saveLines.every((l) => l.includes("[from-both]"))).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "leaves an element only the DOM walk reports on its own line",
    async () => {
      // The `tabindex` div is a nameless `generic` in the accessibility tree —
      // a node the serialiser emits no line for. Folding the DOM walk's entry
      // into it would take the div out of the snapshot entirely, so the merge
      // refuses and the `[from-dom]` line stands.
      const session = "ks-dedup-dom-only";
      await openOn(session);
      const snap = await callText("snapshot", { session });
      const widget = bodyOf(snap).filter((l) => l.includes("opaque-widget"));
      expect(widget, `widget lines:\n${widget.join("\n")}`).toHaveLength(1);
      expect(widget[0]).toContain("[from-dom]");
      expect(statsOf(snap).domWalkNew).toBeGreaterThanOrEqual(1);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "counts the join in stats.domWalkCombined",
    async () => {
      const session = "ks-dedup-stats";
      await openOn(session);
      const stats = statsOf(await callText("snapshot", { session }));
      // Was 0 on every page measured, because no entry could ever match.
      expect(stats.domWalkCombined).toBeGreaterThan(0);
      expect(stats.domWalkNew + stats.domWalkCombined).toBe(stats.domWalkEntries);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "reports the same body and the same stats on the second snapshot",
    async () => {
      // `[from-both]` used to mean "this key was already in the registry", so
      // every `[from-dom]` flipped to `[from-both]` on the second snapshot of an
      // unchanged page. It means what it says now, and it has to say the same
      // thing twice.
      const session = "ks-dedup-second-snapshot";
      await openOn(session);
      const first = await callText("snapshot", { session });
      const second = await callText("snapshot", { session });
      expect(first).toContain("[from-both]");
      expect(bodyOf(second)).toEqual(bodyOf(first));
      expect(statsOf(second)).toEqual(statsOf(first));
    },
    KEYSTONE_TIMEOUT,
  );
});
