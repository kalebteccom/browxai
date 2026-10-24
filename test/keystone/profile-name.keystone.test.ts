// Keystone: profile names and session ids name directories under the workspace,
// so `open_session` refuses any that are not one plain name, and a refused call
// creates nothing outside the workspace or beside `profiles/`.
//
// The workspace is `<base>/ws`, so a directory created one or two levels up from
// `profiles/` or `.downloads/` would show up as `<base>/ws/x` or `<base>/x`. Every
// refusal here lands before a browser launches.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";

const KEYSTONE_TIMEOUT = 60_000;

let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
let ws: string;
const savedEnv: Record<string, string | undefined> = {};

/** The tool's JSON body, or the thrown message when the call rejects. */
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const fn = server.handlers[name];
  if (!fn) throw new Error(`keystone: no handler "${name}"`);
  try {
    const res = await fn(args);
    return (res.content[0] as { text: string }).text;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function assertNothingOutside(): void {
  expect(readdirSync(base)).toEqual(["ws"]);
  expect(existsSync(join(ws, "x"))).toBe(false);
  expect(existsSync(join(ws, "profiles", "x"))).toBe(false);
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  base = mkdtempSync(join(tmpdir(), "browx-profile-name-ks-"));
  ws = join(base, "ws");
  mkdirSync(ws);
  process.env.BROWX_WORKSPACE = ws;
  server = await createServer({ headless: true });
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.shutdown().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (base) rmSync(base, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describe("profile and session names keystone", () => {
  it(
    'refuses open_session({profile:"../x"}) and creates nothing outside the workspace',
    async () => {
      const body = JSON.parse(
        await call("open_session", { session: "ks-a", mode: "persistent", profile: "../x" }),
      ) as { ok: boolean; code?: string; error?: string };
      expect(body.ok).toBe(false);
      expect(body.code).toBe("invalid-name");
      expect(body.error).toMatch(/^invalid-name: profile "\.\.\/x"/);
      assertNothingOutside();
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "refuses nested, absolute and backslash profile names the same way",
    async () => {
      for (const profile of ["../../x", "a/../../x", join(base, "x"), "..\\x"]) {
        const text = await call("open_session", { session: "ks-b", mode: "persistent", profile });
        expect(text, profile).toContain("invalid-name");
      }
      assertNothingOutside();
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "refuses a session id that is not a plain name, on open_session and on lazy creation",
    async () => {
      for (const session of ["../x", "../../x"]) {
        expect(await call("open_session", { session, mode: "persistent" })).toContain(
          "invalid-name",
        );
        expect(await call("navigate", { session, url: "about:blank" })).toContain("invalid-name");
      }
      assertNothingOutside();
      expect(existsSync(join(ws, ".downloads", "x"))).toBe(false);
    },
    KEYSTONE_TIMEOUT,
  );
});
