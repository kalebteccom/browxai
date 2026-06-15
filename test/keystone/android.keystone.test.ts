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
// SCOPE — the STANDOUT vs firefox/webkit: Android Chrome speaks FULL CDP, so
// EVERYTHING works, including the CDP-deep tools (the gate auto-allows on
// deep:true):
//   - open_session(android, attached) + list_sessions.engine === "android"
//   - navigate → snapshot → find  (the CDP a11y substrate, selected by CDP
//     presence — Android falls into the SAME chromium-substrate path, no new
//     substrate code)
//   - a DEEP tool (coverage_start) RUNS — the proof of deep:true (this is what
//     firefox/webkit structured-refuse; on Android it works because it's CDP)

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
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human,diagnostics";
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
    "attaches to real Chrome-on-Android and the seam tags it engine:android",
    async () => {
      const session = "android-flow";
      const opened = await callJson<{ ok: boolean }>("open_session", {
        session,
        mode: "attached",
      });
      expect(opened.ok).toBe(true);

      const listed = await callJson<{
        sessions: Array<{ id: string; engine: string }>;
      }>("list_sessions", {});
      const row = listed.sessions.find((s) => s.id === session);
      expect(row, "opened session present in list_sessions").toBeTruthy();
      // The headline behavior: a real Chrome-on-Android session is tagged android
      // through the BrowserEngine port — the BYOB-to-real-profile win.
      expect(row!.engine).toBe("android");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "drives navigate → snapshot → find on real Chrome-on-Android (CDP substrate)",
    async () => {
      const session = "android-read";
      await callJson("open_session", { session, mode: "attached" });

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

  it(
    "a DEEP tool (coverage_start) WORKS on android — the proof of deep:true",
    async () => {
      // The standout vs firefox/webkit: those structured-REFUSE the CDP-deep tools
      // (deep:false). Android speaks full CDP (deep:true), so the SAME capability-
      // based gate ALLOWS them — coverage_start actually runs (it does not return
      // an engine-refusal envelope). This is what distinguishes the android lane.
      const session = "android-deep";
      await callJson("open_session", { session, mode: "attached" });
      await callJson("navigate", { session, url: "https://example.com/" });

      const cov = await callJson<{ ok: boolean; engine?: string; error?: string }>(
        "coverage_start",
        { session },
      );
      // It must NOT be the engine-refusal envelope (which carries engine:"android"
      // + an error naming the tool). On android the deep tool runs.
      expect(cov.engine, "coverage_start is NOT engine-refused on android").toBeUndefined();
      expect(cov.ok, "coverage_start runs on android (deep:true — full CDP)").toBe(true);

      await callJson("coverage_stop", { session }).catch(() => undefined);
    },
    KEYSTONE_TIMEOUT,
  );
});
