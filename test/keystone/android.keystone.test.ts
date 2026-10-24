// Android keystone — the proof the engine port generalizes to REAL Chrome-on-
// Android over adb + CDP. The surviving full-fidelity real-
// profile BYOB lane.
//
// REQUIRES a USB-connected Android device with Chrome open + USB debugging
// enabled; SKIPS cleanly otherwise (the same honest device-gate pattern as the
// firefox / webkit keystones — when their binary is absent they `describe.skip`).
// This is doctrine-conforming: it is NOT a silently-passing mock. The whole point
// is that mocks cannot prove the adb forward → /json/version → connectOverCDP
// chain reaches a real phone — only a real device run does.
//
// To run live: connect a phone over USB, enable Developer Options → USB
// debugging, open Chrome on the device (and enable the on-device USB
// web-debugging toggle), then `pnpm test:keystone`. Pick a specific device with
// BROWX_ANDROID_SERIAL when several are connected.
//
// SCOPE — Android Chrome speaks FULL CDP, so the CDP substrate serves it:
//   - open_session(android, attached) + list_sessions.engine === "android"
//   - navigate → snapshot → find  (the CDP a11y substrate, selected by CDP
//     presence — Android falls into the SAME chromium-substrate path, no new
//     substrate code)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;

// A ready Android device present? Run `adb devices` at module load (synchronously,
// the same shape as the firefox/webkit keystones' sync `executablePath()` gate)
// and require a `device`-state row. Any failure (adb missing, no device) → skip
// cleanly. This is the honest device-gate, not a silently-passing mock.
const androidDeviceAvailable = (() => {
  try {
    const out = execFileSync("adb", ["devices"], { timeout: 5000, encoding: "utf8" });
    return out
      .split("\n")
      .slice(1)
      .some((line) => /\sdevice\s*$/.test(line.trimEnd()));
  } catch {
    return false;
  }
})();
const describeAndroid = androidDeviceAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const fn = handlers[name];
  if (!fn) throw new Error(`android keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const fn = handlers[name];
  if (!fn) throw new Error(`android keystone: no handler "${name}"`);
  const res = await fn(args);
  return (res.content[0] as { text: string }).text;
}

beforeAll(async () => {
  if (!androidDeviceAvailable) return;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_") && k !== "BROWX_ANDROID_SERIAL") {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-android-keystone-"));
  process.env.BROWX_WORKSPACE = workspace;
  // diagnostics ON so the deep tool (coverage_start) we run to prove deep:true is
  // not refused by the CAPABILITY gate — leaving only the ENGINE gate as the
  // thing under test (and on android the engine gate ALLOWS it: deep:true).
  // byob-attach because every android session is an attach to the phone's
  // real Chrome.
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human,byob-attach,diagnostics";
  // The android engine attaches to the user's real Chrome-on-Android over adb +
  // CDP — the server defaults android to mode:"attached" (endpoint discovered
  // over adb, no BROWX_ATTACH_CDP).
  server = await createServer({ headless: false, browserType: "android" });
  handlers = server.handlers;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  if (!androidDeviceAvailable) return;
  await server?.shutdown().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  delete process.env.BROWX_CAPABILITIES;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describeAndroid("android keystone — real Chrome-on-Android over adb + CDP (BYOB)", () => {
  it(
    "attaches to real Chrome-on-Android tagged engine:android and drives navigate → snapshot → find (CDP substrate)",
    async () => {
      const session = "android-read";
      const opened = await callJson<{ ok: boolean }>("open_session", {
        session,
        mode: "attached",
      });
      expect(opened.ok).toBe(true);
      // A real Chrome-on-Android session is tagged android through the
      // BrowserEngine port.
      const listed = await callJson<{ sessions: Array<{ id: string; engine: string }> }>(
        "list_sessions",
        {},
      );
      expect(listed.sessions.find((s) => s.id === session)?.engine).toBe("android");

      // navigate the real device's Chrome to a stable public page.
      const nav = await callJson<{ ok: boolean }>("navigate", {
        session,
        url: "https://example.com/",
      });
      expect(nav.ok).toBe(true);

      // snapshot — Android Chrome has the CDP a11y tree, so the CDP substrate is
      // selected by CDP presence (the SAME chromium path — no new substrate).
      const snap = await callText("snapshot", { session });
      expect(snap.toLowerCase()).toContain("example");

      // find — ranks a real candidate on the real device.
      const found = await callJson<{ candidates: Array<{ selectorHint: string }> }>("find", {
        session,
        query: "the More information link",
      });
      expect(found.candidates.length).toBeGreaterThan(0);
    },
    KEYSTONE_TIMEOUT,
  );
});
