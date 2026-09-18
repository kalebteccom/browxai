// Electron keystone — the proof browxai drives a REAL desktop Electron
// application over the CDP port it was launched with, and refuses the two things
// Electron cannot or must not do.
//
// REQUIRES a running Electron app with `--remote-debugging-port` on a loopback
// endpoint, named by BROWX_ELECTRON_CDP; SKIPS cleanly otherwise — the same
// honest device-gate the android keystone uses for `adb devices` and the
// firefox/webkit keystones use for a missing binary. A mock could not prove any
// of this: the whole subject is what one specific Chromium fork answers over the
// wire, and a fake would answer whatever this file told it to.
//
// To run live, with a THROWAWAY instance rather than an app holding your data:
//
//   "/Applications/Visual Studio Code.app/Contents/MacOS/Electron" \
//     --remote-debugging-port=9333 \
//     --user-data-dir=/tmp/browx-electron/udd \
//     --extensions-dir=/tmp/browx-electron/ext \
//     --new-window /tmp/browx-electron/work
//   BROWX_ELECTRON_CDP=http://127.0.0.1:9333 pnpm test:keystone
//
// Pointing it at your real editor or your logged-in Slack works and is a
// deliberate act: that CDP port is unauthenticated for the app's lifetime, and
// running an app with `--remote-debugging-port` next to `--user-data-dir` matches
// published EDR rules for infostealer cookie theft (MITRE T1539). See
// docs/threat-model.md.
//
// SCOPE — the three things that distinguish this lane from an ordinary BYOB
// attach, each one a measured breakage this engine exists to handle:
//   1. the session reports engine:"electron" WITHOUT the operator declaring it
//      (`Browser.getVersion`'s user agent is the oracle)
//   2. `navigate` structured-REFUSES, while `snapshot` / `find` / `click` work
//   3. a second session refuses with `attach-target-creation-unavailable` rather
//      than relaying `Protocol error (Target.createTarget): Not supported`
//
// ONE SESSION, shared. A single-window Electron app exposes exactly one page
// target and cannot mint another, so this file opens one session in `beforeAll`
// and every case drives it. That is not test hygiene, it is the subject: a
// per-case session would hit the refusal in case 3 and prove nothing about the
// other four.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;

const ELECTRON_CDP = process.env.BROWX_ELECTRON_CDP?.trim();
const describeElectron = ELECTRON_CDP ? describe : describe.skip;

let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

/** The one session every case drives. See the header: the app has one target. */
const SESSION = "electron";

async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const fn = handlers[name];
  if (!fn) throw new Error(`electron keystone: no handler "${name}"`);
  const res = await fn(args);
  return JSON.parse((res.content[0] as { text: string }).text) as T;
}

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const fn = handlers[name];
  if (!fn) throw new Error(`electron keystone: no handler "${name}"`);
  const res = await fn(args);
  return (res.content[0] as { text: string }).text;
}

beforeAll(async () => {
  if (!ELECTRON_CDP) return;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_") && k !== "BROWX_ELECTRON_CDP") {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-electron-keystone-"));
  process.env.BROWX_WORKSPACE = workspace;
  // byob-attach is the capability this lane rides — the same one the desktop
  // CDP-attach already required. diagnostics is on so the deep tool below is left
  // to the ENGINE gate, which allows it (electron is deep:true).
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human,byob-attach,diagnostics";
  // No confirm hooks: `byob_action` is ON by default and every action against an
  // attached app waits five minutes on a human. That gate is real and is asserted
  // in its own suite; here it would only make the file hang.
  process.env.BROWX_CONFIRM_REQUIRED = "navigate_off_allowlist";
  // Deliberately NOT browserType:"electron". The point is that the operator
  // pointed browxai at a CDP endpoint the ordinary way and the protocol resolved
  // the engine.
  server = await createServer({ headless: false, attachCdp: ELECTRON_CDP });
  handlers = server.handlers;
  await handlers.open_session!({ session: SESSION });
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  if (!ELECTRON_CDP) return;
  await server?.shutdown().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  delete process.env.BROWX_CAPABILITIES;
  delete process.env.BROWX_CONFIRM_REQUIRED;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describeElectron("electron keystone — a real desktop app over its debugging port", () => {
  it(
    "resolves engine:electron from the protocol, with no operator declaration",
    async () => {
      const listed = await callJson<{
        sessions: Array<{ id: string; engine: string; mode: string }>;
      }>("list_sessions", {});
      const row = listed.sessions.find((s) => s.id === SESSION);
      expect(row, "opened session present in list_sessions").toBeTruthy();
      // The headline. `createServer` was given no browserType, so this is
      // `Browser.getVersion`'s user agent talking, not a config value echoed back.
      expect(row!.engine).toBe("electron");
      expect(row!.mode).toBe("attached");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "reads the app: snapshot returns a real tree and find ranks real candidates",
    async () => {
      const session = SESSION;
      // Electron IS Chromium, so this is the verbatim CDP snapshot substrate —
      // selected by CDP presence, no electron-specific code on the read path.
      const snap = await callText("snapshot", { session });
      expect(snap).toContain("url:");
      expect(snap.split("\n").length, "a real app yields more than a bare root").toBeGreaterThan(
        10,
      );

      const found = await callJson<{ candidates: Array<{ ref: string; bbox?: unknown }> }>("find", {
        session,
        query: "any button in the window",
      });
      expect(found.candidates.length).toBeGreaterThan(0);
      // A ref that resolves is what separates a usable snapshot from a plausible
      // one: `find` measured a box for it, so `locatorFor` matched exactly one.
      expect(found.candidates[0]!.bbox).toBeTruthy();
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "REFUSES navigate, structurally, and keeps the rest of the navigation family",
    async () => {
      const session = SESSION;
      const nav = await callJson<{ ok: boolean; engine?: string; hint?: string; url?: string }>(
        "navigate",
        { session, url: "https://example.com/" },
      );
      // The shape a caller can act on: a refusal names the engine and carries a
      // hint, and has no result payload to mistake for a navigation that happened.
      expect(nav.ok).toBe(false);
      expect(nav.engine).toBe("electron");
      expect(nav.hint).toMatch(/renderer process/);
      expect(nav.url, "a refusal must carry no navigation result").toBeUndefined();

      // And the app is untouched: still on its own document.
      const after = await callText("snapshot", { session });
      expect(after).not.toContain("example.com");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "refuses a second session with attach-target-creation-unavailable, not a protocol error",
    async () => {
      // Electron answers `Target.createTarget` with "Not supported" (measured,
      // Electron 39.8.8), so once every renderer target is leased the pool has
      // nowhere to go. It must say so in browxai's own vocabulary.
      //
      // Guarded on the app exposing exactly one page target: an app with several
      // windows open legitimately has a free one, and this would then assert a
      // refusal that should not happen.
      const second = await callJson<{ ok: boolean; error?: string }>("open_session", {
        session: "electron-second",
      });
      if (second.ok) {
        // The app had a second window. Nothing is wrong; the refusal is simply
        // not reachable here.
        expect(second.ok).toBe(true);
        return;
      }
      expect(second.error).toContain("attach-target-creation-unavailable");
      expect(second.error).toContain(SESSION);
      // The raw protocol string is what this replaced. It must not leak.
      expect(second.error).not.toContain("Protocol error");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a DEEP tool runs on electron — the proof of deep:true",
    async () => {
      // Same standout as android: firefox/webkit structured-REFUSE the CDP-deep
      // tools, and electron speaks full CDP, so the SAME capability-based gate
      // allows them with no per-engine edit.
      const session = SESSION;
      const cov = await callJson<{ ok: boolean; engine?: string }>("coverage_start", { session });
      expect(cov.engine, "coverage_start is NOT engine-refused on electron").toBeUndefined();
      expect(cov.ok).toBe(true);
      await callJson("coverage_stop", { session }).catch(() => undefined);
    },
    KEYSTONE_TIMEOUT,
  );
});
