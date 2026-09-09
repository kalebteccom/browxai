// challenge-detection keystone — drive the `challenge` block against real
// headless Chromium.
//
// The page-side half (CHALLENGE_MARKERS_FN) is only proven here: a mocked
// `page.evaluate` calls the function in Node and passes even when the in-page
// path is broken. Every assertion below that names a DOM marker (the
// challenge-platform script, the Turnstile element, the Anubis asset path, the
// document title) can only be satisfied by the function actually running in the
// page and its RETURN VALUE crossing back over CDP.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

interface ChallengeBlock {
  kind: string;
  vendor: string;
  evidence: string[];
}
interface ActionJson {
  ok: boolean;
  error?: string;
  challenge?: ChallengeBlock;
}

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
  if (!fn) throw new Error(`challenge keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

async function navigateTo(session: string, path: string): Promise<ActionJson> {
  return callJson<ActionJson>("navigate", { session, url: `${fixture.url}${path}` });
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-challenge-ks-"));
  process.env.BROWX_WORKSPACE = workspace;
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human";

  fixture = await startFixture();
  server = await createServer({ headless: true });
  handlers = server.handlers;
  await callJson("open_session", { session: "ks-challenge", mode: "incognito" });
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  delete process.env.BROWX_CAPABILITIES;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describe("challenge keystone — markers on a completed action", () => {
  it(
    "reports the Cloudflare interstitial with header, script, title and status evidence",
    async () => {
      const r = await navigateTo("ks-challenge", "/challenge-cloudflare");
      // Detection never changes the outcome: the document was served.
      expect(r.ok).toBe(true);
      expect(r.challenge?.kind).toBe("interstitial");
      expect(r.challenge?.vendor).toBe("cloudflare");
      expect(r.challenge?.evidence).toContain('response header "cf-mitigated: challenge"');
      // Page-realm evidence — undefined here means CHALLENGE_MARKERS_FN did not
      // run in-page or its return value did not survive CDP serialization.
      expect(r.challenge?.evidence).toContain('script src contains "cdn-cgi/challenge-platform"');
      expect(r.challenge?.evidence).toContain('document title "Just a moment..."');
      expect(r.challenge?.evidence).toContain("document HTTP status 503");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "reports a Turnstile on a normal 200 login page as a widget, not an interstitial",
    async () => {
      const r = await navigateTo("ks-challenge", "/challenge-turnstile");
      expect(r.ok).toBe(true);
      expect(r.challenge).toEqual({
        kind: "widget",
        vendor: "cloudflare",
        evidence: ['element ".cf-turnstile[data-sitekey]"'],
      });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "reports the Anubis proof-of-work gate as an interstitial",
    async () => {
      const r = await navigateTo("ks-challenge", "/challenge-anubis");
      expect(r.challenge?.kind).toBe("interstitial");
      expect(r.challenge?.vendor).toBe("anubis");
      expect(r.challenge?.evidence).toContain(
        'asset path contains "/.within.website/x/cmd/anubis/"',
      );
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "carries no challenge block on an ordinary page",
    async () => {
      const r = await navigateTo("ks-challenge", "/");
      expect(r.ok).toBe(true);
      expect(r.challenge).toBeUndefined();
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("challenge keystone — deadline expiry behind a gate", () => {
  it(
    "names the challenge and await_human instead of the generic timeout",
    async () => {
      await navigateTo("ks-challenge", "/challenge-cloudflare");
      const r = await callJson<ActionJson>("click", {
        session: "ks-challenge",
        selector: "#not-on-this-page",
        timeoutMs: 600,
      });
      expect(r.ok).toBe(false);
      expect(r.challenge?.vendor).toBe("cloudflare");
      expect(r.error).toContain("Cloudflare interstitial");
      expect(r.error).toContain("await_human");
      expect(r.error).not.toContain("anti-wedge timeout");
    },
    KEYSTONE_TIMEOUT,
  );
});
