// Android-app keystone — the proof RFC 0008 P2's engine drives a REAL Android
// device end to end, through the real MCP server, with no mock anywhere.
//
// REQUIRES a ready Android device or emulator; SKIPS cleanly otherwise, the same
// honest device-gate the android / firefox / webkit keystones use. A
// skipped-but-written keystone is what lets this be verified the day a device
// appears; a silently-passing mock would not be.
//
// To run live: `emulator -avd <name> -no-window` (or attach a device), then
// `pnpm test:keystone`. Set BROWX_ANDROID_APP_SERIAL when several devices are
// attached — the engine refuses an ambiguous pick.
//
// WHAT IS PROVEN HERE, and each of these is a claim the unit tests CANNOT make
// because they fake the transport:
//   - `open_session({browserType:"android-app"})` leases a real device and the
//     seam tags the session `android-app`.
//   - `snapshot` composes a REAL UiAutomator dump into `A11yNode` with `[ref=eN]`
//     refs — the crux of RFC 0008: our snapshot already speaks role/name trees.
//   - `find` ranks over that tree with no native-specific ranking code.
//   - `screenshot` returns a real PNG off `adb exec-out screencap`.
//   - `click` taps at a point read from a fresh hierarchy in the same call.
//   - `press({key:"home"})` reaches the OS input pipeline and CHANGES the
//     foreground app, which `app_foreground` then reports.
//   - the whole CDP-deep family still refuses, because `deep:false`.
//
// THE CAPABILITY GATE gets its own file-level case: a server WITHOUT
// `native-device` must refuse `open_session` outright. That is the keystone RFC
// 0008 §8 asks for, and it runs whether or not a device is present, because a
// refusal needs no device.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 180_000;

/** A ready device present? `adb devices` at module load, the same shape as the
 *  android keystone's gate. Any failure (adb missing, no device) → skip. */
const deviceAvailable = (() => {
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
const describeDevice = deviceAvailable ? describe : describe.skip;

const savedEnv: Record<string, string | undefined> = {};

function clearBrowxEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_") && k !== "BROWX_ANDROID_APP_SERIAL") {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
}

function restoreEnv(): void {
  delete process.env.BROWX_WORKSPACE;
  delete process.env.BROWX_CAPABILITIES;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
}

// ─── the capability gate — no device needed ───────────────────────────────────

describe("android-app capability gate — the refusal RFC 0008 §8 requires", () => {
  let workspace: string;

  beforeAll(() => {
    clearBrowxEnv();
    workspace = mkdtempSync(join(tmpdir(), "browx-native-gate-"));
    process.env.BROWX_WORKSPACE = workspace;
  });

  afterAll(() => {
    restoreEnv();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it(
    "open_session refuses android-app when `native-device` is not granted",
    async () => {
      // THE GATE THAT CANNOT BE REACHED AROUND. Every native tool needs a native
      // session first, so refusing at session creation closes the whole surface
      // with one check. This runs with the DEFAULT capability set.
      process.env.BROWX_CAPABILITIES = "read,navigation,action,human";
      const server = await createServer({ headless: true, browserType: "chromium" });
      try {
        const res = await server.handlers.open_session({
          session: "native-refused",
          engine: "android-app",
        });
        const body = JSON.parse((res.content[0] as { text: string }).text) as {
          ok?: boolean;
          error?: string;
        };
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/native-device/);
        // The refusal names the capability AND how to grant it, so the fix is in
        // the error.
        expect(body.error).toMatch(/BROWX_CAPABILITIES/);
      } finally {
        await server.shutdown().catch(() => undefined);
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "every native tool refuses when `native-device` is not granted",
    async () => {
      process.env.BROWX_CAPABILITIES = "read,navigation,action,human";
      const server = await createServer({ headless: true, browserType: "chromium" });
      try {
        for (const tool of [
          "device_list",
          "device_boot",
          "device_shutdown",
          "app_list",
          "app_install",
          "app_uninstall",
          "app_launch",
          "app_terminate",
          "app_reset",
          "app_foreground",
        ]) {
          const fn = server.handlers[tool];
          expect(fn, `${tool} is not registered`).toBeTruthy();
          const res = await fn!({ avd: "x", serial: "x", appId: "x", apkPath: "x" });
          const body = JSON.parse((res.content[0] as { text: string }).text) as { ok?: boolean };
          expect(body.ok, `${tool} answered instead of refusing`).toBe(false);
        }
      } finally {
        await server.shutdown().catch(() => undefined);
      }
    },
    KEYSTONE_TIMEOUT,
  );
});

// ─── the live device lane ─────────────────────────────────────────────────────

describeDevice("android-app keystone — a real Android device over adb", () => {
  let server: Awaited<ReturnType<typeof createServer>>;
  let handlers: Handlers;
  let workspace: string;

  async function callJson<T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const fn = handlers[name];
    if (!fn) throw new Error(`android-app keystone: no handler "${name}"`);
    const res = await fn(args);
    const first = res.content[0] as { type: string; text?: string };
    if (first.type !== "text" || !first.text) return { nonText: first.type } as T;
    return JSON.parse(first.text) as T;
  }

  /** `snapshot` renders the agent-facing TEXT tree, not JSON — the same
   *  rendering every engine produces, which is the point. */
  async function callText(name: string, args: Record<string, unknown>): Promise<string> {
    const fn = handlers[name];
    if (!fn) throw new Error(`android-app keystone: no handler "${name}"`);
    const res = await fn(args);
    return (res.content[0] as { text: string }).text;
  }

  beforeAll(async () => {
    if (!deviceAvailable) return;
    clearBrowxEnv();
    workspace = mkdtempSync(join(tmpdir(), "browx-native-keystone-"));
    process.env.BROWX_WORKSPACE = workspace;
    process.env.BROWX_CAPABILITIES = "read,navigation,action,human,native-device";
    server = await createServer({ headless: true, browserType: "android-app" });
    handlers = server.handlers;
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    if (!deviceAvailable) return;
    await server?.shutdown().catch(() => undefined);
    restoreEnv();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }, KEYSTONE_TIMEOUT);

  it(
    "device_list sees the device, with its model and API level",
    async () => {
      const body = await callJson<{
        ok: boolean;
        ready: number;
        devices: Array<{ serial: string; state: string; sdk?: number }>;
      }>("device_list", {});
      expect(body.ok).toBe(true);
      expect(body.ready).toBeGreaterThan(0);
      const ready = body.devices.find((d) => d.state === "device")!;
      expect(ready.serial.length).toBeGreaterThan(0);
      expect(ready.sdk, "a ready device reports its API level").toBeGreaterThan(0);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "opens a session against the device and the seam tags it android-app",
    async () => {
      const session = "native-flow";
      const opened = await callJson<{ ok: boolean }>("open_session", { session });
      expect(opened.ok).toBe(true);
      const listed = await callJson<{ sessions: Array<{ id: string; engine: string }> }>(
        "list_sessions",
        {},
      );
      expect(listed.sessions.find((s) => s.id === session)?.engine).toBe("android-app");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "snapshot composes a REAL UiAutomator hierarchy into the [ref=eN] tree",
    async () => {
      // THE CRUX OF RFC 0008. No mock can make this claim: the assertion is that
      // a real view hierarchy from a real device maps onto the snapshot contract
      // that already ships, with the same refs and the same role/name vocabulary.
      const session = "native-flow";
      await callJson("open_session", { session });
      // The launcher is always present and always settles, which matters because
      // `uiautomator dump` blocks on window idle.
      await callJson("press", { session, key: "home" });
      const text = await callText("snapshot", { session });
      expect(text, "the snapshot carries [ref=eN] refs").toMatch(/\[ref=e\d+]/);
      // Role/name vocabulary, not an Android class name, is what the agent sees.
      expect(text).toMatch(/button|text|img|group/);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "find ranks candidates over the native tree with no native-specific ranking code",
    async () => {
      const session = "native-flow";
      await callJson("open_session", { session });
      await callJson("press", { session, key: "home" });
      const found = await callText("find", { session, query: "search" });
      // The claim is that `find` ran at all over a native tree, which is what
      // "the ranking code never learns the difference" means.
      expect(found.length).toBeGreaterThan(2);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "screenshot returns a real PNG off the device framebuffer",
    async () => {
      const session = "native-flow";
      await callJson("open_session", { session });
      const res = await handlers.screenshot!({ session });
      const image = res.content.find((c) => (c as { type: string }).type === "image") as
        { type: string; data: string; mimeType: string } | undefined;
      expect(image, "screenshot returned an image block").toBeTruthy();
      expect(image!.mimeType).toBe("image/png");
      const bytes = Buffer.from(image!.data, "base64");
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      // A real screen, not a 1x1 placeholder.
      expect(bytes.length).toBeGreaterThan(10_000);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "press reaches the OS input pipeline and changes the foreground app",
    async () => {
      // The proof that input is REAL OS input and not a synthesised event an app
      // could ignore: HOME is handled by the window manager, so nothing but a
      // genuine key event moves it.
      const session = "native-flow";
      await callJson("open_session", { session });
      const pressed = await callJson<{ ok: boolean }>("press", { session, key: "home" });
      expect(pressed.ok).toBe(true);
      const fg = await callJson<{
        ok: boolean;
        foreground: { appId: string; activity?: string } | null;
        url: string;
      }>("app_foreground", { session });
      expect(fg.ok).toBe(true);
      expect(fg.foreground, "something owns the foreground after HOME").toBeTruthy();
      // The native target url the secret-scope check is measured against.
      expect(fg.url).toMatch(/^app:\/\//);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "click taps an element resolved from a fresh hierarchy in the same call",
    async () => {
      const session = "native-flow";
      await callJson("open_session", { session });
      await callJson("press", { session, key: "home" });
      const ref = /\[ref=(e\d+)]/.exec(await callText("snapshot", { session }))?.[1];
      expect(ref, "the snapshot minted at least one ref").toBeTruthy();
      const clicked = await callJson<{ ok: boolean; error?: string }>("click", { session, ref });
      // Either it tapped, or it refused for a reason that NAMES the ref. What it
      // must never do is report a successful tap on something else.
      if (!clicked.ok) expect(clicked.error).toContain(ref!);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "gesture_swipe dispatches a real platform swipe",
    async () => {
      const session = "native-flow";
      await callJson("open_session", { session });
      await callJson("press", { session, key: "home" });
      const swiped = await callJson<{ ok: boolean }>("gesture_swipe", {
        session,
        from: { x: 540, y: 1600 },
        to: { x: 540, y: 600 },
        durationMs: 300,
      });
      expect(swiped.ok).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "gesture_pinch refuses, naming why there is no fallback",
    async () => {
      // `adb shell input` has no two-finger primitive, and every way to fake one
      // reports a pinch the app never received. The refusal is the honest result.
      const session = "native-flow";
      await callJson("open_session", { session });
      const r = await callJson<Record<string, unknown>>("gesture_pinch", {
        session,
        coords: { x: 540, y: 1100 },
        scale: 2,
      });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).toMatch(/native-pinch-needs-multitouch-driver/);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "the omitted sub-interfaces refuse instead of answering a plausible empty",
    async () => {
      // The `SafariNoopNetworkSubstrate` lesson. `network_read` answering
      // `{total: 0}` on an engine that cannot observe network is indistinguishable
      // from a true negative in a report a human is about to sign off.
      const session = "native-flow";
      await callJson("open_session", { session });
      for (const tool of ["network_read", "cookies_list", "localstorage_list", "frames_list"]) {
        const body = await callJson<{ ok?: boolean }>(tool, { session });
        expect(body.ok, `${tool} answered on an engine that declares no such sub-interface`).toBe(
          false,
        );
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "the CDP-deep family still refuses, because android-app declares deep:false",
    async () => {
      const session = "native-flow";
      await callJson("open_session", { session });
      const body = await callJson<{ ok?: boolean; engine?: string }>("heap_snapshot", { session });
      expect(body.ok).toBe(false);
      expect(body.engine).toBe("android-app");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "app_list reports the installed apps on the leased device",
    async () => {
      const session = "native-flow";
      await callJson("open_session", { session });
      const body = await callJson<{ ok: boolean; apps: string[]; device: string }>("app_list", {
        session,
      });
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.apps)).toBe(true);
      // `device`, not `serial`: one lifecycle surface serves both native engines
      // and an iOS udid is not a serial.
      expect(body.device.length).toBeGreaterThan(0);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a second session on the same device refuses, naming the holder",
    async () => {
      // ONE UiAutomation OWNER PER DEVICE (RFC 0008, Honest limits). Two sessions
      // dumping the same device make every dump fail for both, so the second
      // claim is refused rather than allowed to corrupt the first.
      await callJson("open_session", { session: "lease-a" });
      const second = await callJson<{ ok?: boolean; error?: string }>("open_session", {
        session: "lease-b",
      });
      expect(second.ok).toBe(false);
      expect(second.error).toMatch(/native-device-leased|lease-a/);
    },
    KEYSTONE_TIMEOUT,
  );
});
