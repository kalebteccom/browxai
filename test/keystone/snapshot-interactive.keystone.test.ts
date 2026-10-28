// snapshot-interactive keystone — real headless Chromium against two pages
// shaped like the public sites a first snapshot lands on: example.com's bare
// markup, and a portal home page (banner, nav, search, main, footer).
//
// A snapshot of such a page has to list its links and buttons as interactive
// rows from the a11y tier, with `stats.a11yInteractive` above 0 and no
// extraction-failure warning. The fixture pages stand in for the live sites
// because keystones run without a network; they cannot stand in for a headed,
// installed Chrome, which this lane does not launch.

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
  if (!fn) throw new Error(`snapshot-interactive keystone: no handler "${name}"`);
  const res = await fn(args);
  return (res.content[0] as { text: string }).text;
}

async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  return JSON.parse(await callText(name, args)) as T;
}

interface Stats {
  a11yInteractive: number;
  tier: string;
  domWalkEntries: number;
}

function statsOf(snapshot: string): Stats {
  const line = snapshot.split("\n").find((l) => l.startsWith("stats: "));
  if (!line) throw new Error(`no stats line in snapshot:\n${snapshot}`);
  return JSON.parse(line.slice("stats: ".length)) as Stats;
}

/** Rows the a11y tier produced: `[from-dom]` marks a row it had no part in. */
function a11yRows(snapshot: string): string[] {
  return snapshot.split("\n").filter((l) => l.includes("[ref=") && !l.includes("[from-dom]"));
}

async function snapshotOf(session: string, path: string): Promise<string> {
  const opened = await callJson<{ ok: boolean }>("open_session", { session, mode: "incognito" });
  expect(opened.ok).toBe(true);
  const nav = await callJson<{ ok: boolean }>("navigate", {
    session,
    url: `${fixture.url}${path}`,
  });
  expect(nav.ok).toBe(true);
  return callText("snapshot", { session });
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

describe("snapshot keystone — a public-site-shaped page lists its controls", () => {
  it(
    "lists the link on example.com's markup as an a11y-tier row",
    async () => {
      const snap = await snapshotOf("ks-snapshot-example", "/example-domain-page");

      expect(a11yRows(snap).join("\n"), `snapshot:\n${snap}`).toContain(
        'link "More information..."',
      );
      expect(statsOf(snap).a11yInteractive, `snapshot:\n${snap}`).toBeGreaterThanOrEqual(1);
      expect(snap).not.toContain("accessibility tree extraction failed");
      expect(snap).not.toContain("returned no nodes");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "lists the links and the button on a portal home page",
    async () => {
      const snap = await snapshotOf("ks-snapshot-portal", "/portal-home-page");
      const rows = a11yRows(snap).join("\n");

      for (const label of ["Docs", "Pricing", "Sign in", "First topic", "Privacy"]) {
        expect(rows, `no link "${label}" in snapshot:\n${snap}`).toContain(`link "${label}"`);
      }
      expect(rows, `snapshot:\n${snap}`).toContain('button "Go"');
      // Nine links, the search field and its button.
      expect(statsOf(snap).a11yInteractive, `snapshot:\n${snap}`).toBeGreaterThanOrEqual(10);
      expect(snap).not.toContain("accessibility tree extraction failed");
    },
    KEYSTONE_TIMEOUT,
  );
});
