// find() presentational-role keystone — real headless Chromium against
// `/find-statictext-page`.
//
// Once ignored nodes stopped eating their subtree, the a11y tree started
// carrying every `StaticText` Chromium emits. `scoreCandidates` ranked them
// like anything else, and `scorePhraseMatch` pays 10 for a name that IS a query
// word: a `StaticText` literally named "button" scored 11 against a real
// `button "Search (Command+K)"` scoring 3. `const top = scored.slice(0, max)`
// cuts before the probes run, so on Bootstrap's forms docs all five slots went
// to `StaticText` and the search button was not in the result at all — and each
// slot cost an auto-wait on `role=StaticText[name=…]`, a locator the engine
// never resolves, taking find from 88 ms to 643 ms.
//
// Only a real browser produces the `StaticText` interleaving: a mocked tree is
// whatever the fixture author believed Chromium emits.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;

interface Candidate {
  ref: string;
  role: string;
  name?: string;
  score: number;
  actionable: true | "disabled" | "off-screen" | "covered";
}

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
const savedEnv: Record<string, string | undefined> = {};

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const fn = handlers[name];
  if (!fn) throw new Error(`find-presentational keystone: no handler "${name}"`);
  const res = await fn(args);
  return (res.content[0] as { text: string }).text;
}

async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  return JSON.parse(await callText(name, args)) as T;
}

async function openOn(session: string): Promise<void> {
  const opened = await callJson<{ ok: boolean }>("open_session", { session, mode: "incognito" });
  expect(opened.ok).toBe(true);
  const nav = await callJson<{ ok: boolean }>("navigate", {
    session,
    url: `${fixture.url}/find-statictext-page`,
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

describe("find keystone — text leaves are not candidates", () => {
  it(
    "returns the real search button at rank 1, actionable",
    async () => {
      const session = "ks-find-presentational-rank";
      await openOn(session);
      const found = await callJson<{ candidates: Candidate[]; warnings: string[] }>("find", {
        session,
        query: "the search button",
        maxCandidates: 5,
      });

      const top = found.candidates[0];
      expect(top, "at least one candidate").toBeTruthy();
      expect(top!.name).toBe("Search (Command+K)");
      expect(top!.actionable).toBe(true);
      // The page says "button" in eight places; none of them is a target.
      expect(found.candidates.map((c) => c.role)).not.toContain("StaticText");
      expect(found.warnings.join(" ")).not.toContain("no visible candidate");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "hands back a ref that acts on the button",
    async () => {
      const session = "ks-find-presentational-act";
      await openOn(session);
      const found = await callJson<{ candidates: Candidate[] }>("find", {
        session,
        query: "the search button",
        maxCandidates: 5,
      });
      const clicked = await callJson<{ ok: boolean }>("click", {
        session,
        ref: found.candidates[0]!.ref,
      });
      expect(clicked.ok).toBe(true);
      // The log element carries a test attribute, so the DOM-walk tier reports
      // it by name. Bare page text no longer reaches a snapshot: the `status`
      // node the a11y tier emits for `<output>` has no accessible name of its
      // own, and its `StaticText` child gets no line.
      expect(await callText("snapshot", { session })).toContain("search-clicked");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "keeps a named control that merely contains a query word",
    async () => {
      // The filter is by role, not by name: `heading "Buttons"` is still ranked,
      // so a real control is never dropped for saying a query word.
      const session = "ks-find-presentational-heading";
      await openOn(session);
      const found = await callJson<{ candidates: Candidate[] }>("find", {
        session,
        query: "the Buttons heading",
        maxCandidates: 5,
      });
      expect(found.candidates.some((c) => c.name === "Buttons")).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );
});
