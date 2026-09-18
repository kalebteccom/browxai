// ios-app keystone — RFC 0008's first native-app engine, driven end to end
// through the real MCP tool handlers.
//
// WHAT IS REAL AND WHAT IS FAKED, stated up front because the distinction is the
// whole value of this file:
//
//   REAL — `xcrun simctl` against a real iOS Simulator on this machine. The boot,
//   the boot-completion wait, the app launch, the PNG screenshot and the
//   terminate all run. If the simulator is absent, every describe here skips
//   cleanly, the way the android and safari keystones skip on a missing device.
//
//   FAKED — WebDriverAgent. It is an Xcode project the OPERATOR builds and runs;
//   browxai does not bundle, build or fetch it, and a machine without one cannot
//   read an XCUITest hierarchy at all. So this file stands a small HTTP server in
//   its place, serving a fixed hierarchy at the endpoints `WdaClient` calls. What
//   that proves is the whole browxai stack above the transport: the engine
//   registration, the session build, the substrate bundle, ref minting, ref
//   re-resolution, the action verbs and the tool handlers. What it does NOT prove
//   is that a real WebDriverAgent answers those endpoints with these shapes. That
//   claim needs a WebDriverAgent build and it is NOT made here.
//
//   ALWAYS — the capability gate. `native-device` is off by default, and the
//   refusal at session creation needs no simulator, so it runs everywhere.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createHttpServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { IosSimulator, listSimulators } from "../../src/engine/adapters/ios/simulator.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 180_000;

/** An app on every iOS runtime, so the lifecycle assertions need no build. */
const SYSTEM_APP = "com.apple.Preferences";

/** A real, available iOS simulator on this machine? Probed synchronously at
 *  module load, the same honest device-gate the android keystone uses. */
const simulator = (() => {
  if (process.platform !== "darwin") return null;
  try {
    execFileSync("xcode-select", ["-p"], { timeout: 5000, stdio: "ignore" });
    const out = execFileSync("xcrun", ["simctl", "list", "devices", "--json"], {
      timeout: 20_000,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    const devices = JSON.parse(out) as {
      devices?: Record<string, Array<{ udid?: string; name?: string; isAvailable?: boolean }>>;
    };
    for (const [runtime, rows] of Object.entries(devices.devices ?? {})) {
      if (!/SimRuntime\.iOS-/.test(runtime)) continue;
      const row = rows.find((r) => r.isAvailable !== false && r.udid);
      if (row?.udid) return { udid: row.udid, name: row.name ?? "" };
    }
    return null;
  } catch {
    return null;
  }
})();
const describeSim = simulator ? describe : describe.skip;

// ─── the fake WebDriverAgent ──────────────────────────────────────────────────

/** The hierarchy the fake serves. `submitY` moves the identified button, which is
 *  what the re-resolution assertion needs: a ref minted at one position must
 *  resolve at the other. */
function sourceTree(submitY: number): unknown {
  return {
    type: "XCUIElementTypeApplication",
    name: "Preferences",
    label: "Preferences",
    rect: { x: 0, y: 0, width: 393, height: 852 },
    isEnabled: "true",
    isVisible: "1",
    children: [
      {
        type: "XCUIElementTypeStaticText",
        name: "Checkout",
        label: "Checkout",
        rect: { x: 20, y: 80, width: 200, height: 24 },
        isEnabled: "true",
        isVisible: "1",
        children: [],
      },
      {
        type: "XCUIElementTypeButton",
        rawIdentifier: "checkout-submit",
        name: "checkout-submit",
        label: "Pay now",
        rect: { x: 20, y: submitY, width: 353, height: 48 },
        isEnabled: "true",
        isVisible: "1",
        children: [],
      },
    ],
  };
}

interface FakeWda {
  url: string;
  taps: Array<{ x: number; y: number }>;
  setSubmitY(y: number): void;
  close(): Promise<void>;
}

async function startFakeWda(): Promise<FakeWda> {
  const taps: Array<{ x: number; y: number }> = [];
  let submitY = 700;
  const server: Server = createHttpServer((req, res) => {
    const url = req.url ?? "";
    const body: unknown[] = [];
    req.on("data", (c) => body.push(c));
    req.on("end", () => {
      const text = Buffer.concat(body as Buffer[]).toString();
      res.setHeader("content-type", "application/json");
      if (url === "/status") return res.end(JSON.stringify({ value: { ready: true } }));
      if (url === "/session") {
        return res.end(JSON.stringify({ value: { sessionId: "WDA-1" }, sessionId: "WDA-1" }));
      }
      if (url.includes("/source")) {
        return res.end(JSON.stringify({ value: sourceTree(submitY) }));
      }
      if (url.includes("/wda/activeAppInfo")) {
        return res.end(
          JSON.stringify({ value: { bundleId: SYSTEM_APP, name: "Preferences", pid: 1 } }),
        );
      }
      if (url.includes("/wda/tap")) {
        taps.push(JSON.parse(text) as { x: number; y: number });
        return res.end(JSON.stringify({ value: null }));
      }
      if (url.includes("/element") && !url.includes("/value")) {
        return res.end(JSON.stringify({ value: { "element-6066-11e4-a52e-4f735466cecf": "E1" } }));
      }
      return res.end(JSON.stringify({ value: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    taps,
    setSubmitY: (y) => {
      submitY = y;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ─── shared server harness ────────────────────────────────────────────────────

let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
let wda: FakeWda;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

function clearBrowxEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
}

function restoreEnv(): void {
  for (const k of Object.keys(process.env)) if (k.startsWith("BROWX_")) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
}

async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const fn = handlers[name];
  if (!fn) throw new Error(`ios keystone: no handler "${name}"`);
  const res = await fn(args);
  return JSON.parse((res.content[0] as { text: string }).text) as T;
}

// ─── the capability gate: no simulator needed ─────────────────────────────────

describe("ios-app keystone — the native-device capability gate", () => {
  it(
    "refuses to open an ios-app session when `native-device` is not granted",
    async () => {
      clearBrowxEnv();
      const ws = mkdtempSync(join(tmpdir(), "browx-ios-gate-"));
      process.env.BROWX_WORKSPACE = ws;
      // The DEFAULT set. Not naming `native-device` is the point.
      process.env.BROWX_CAPABILITIES = "read,navigation,action,human";
      const gated = await createServer({ browserType: "ios-app" });
      try {
        const opened = await gated.handlers
          .open_session({ session: "ios-gated" })
          .then((r) => JSON.parse((r.content[0] as { text: string }).text) as { ok?: boolean })
          .catch((err: unknown) => ({ ok: false, error: String(err) }));
        expect(opened.ok, JSON.stringify(opened)).not.toBe(true);
        expect(JSON.stringify(opened)).toMatch(/native-device/);
        // And it refuses at SESSION CREATION, so nothing was booted, installed or
        // launched before the gate ran.
        expect(JSON.stringify(opened)).toMatch(/capability-required/);
      } finally {
        await gated.shutdown().catch(() => undefined);
        rmSync(ws, { recursive: true, force: true });
        restoreEnv();
      }
    },
    KEYSTONE_TIMEOUT,
  );
});

// ─── the simulator lifecycle: real simctl ─────────────────────────────────────

describeSim("ios-app keystone — real simulator lifecycle through simctl", () => {
  it(
    "lists, boots, launches, screenshots and terminates on a REAL simulator",
    async () => {
      const devices = await listSimulators();
      expect(devices.length, "simctl listed no iOS simulators").toBeGreaterThan(0);
      expect(devices.every((d) => d.platform === "ios")).toBe(true);

      const sim = new IosSimulator(simulator!.udid);
      await sim.boot();
      const booted = (await listSimulators()).find((d) => d.id === simulator!.udid);
      expect(booted?.state, "the device reports itself booted after bootstatus").toBe("booted");

      // Idempotent: booting a booted device is success, not an error.
      await sim.boot();

      const apps = await sim.listApps();
      expect(apps.map((a) => a.bundleId)).toContain(SYSTEM_APP);

      const launched = await sim.launch(SYSTEM_APP);
      expect(launched.bundleId).toBe(SYSTEM_APP);
      expect(launched.pid, "simctl launch reported no pid").toBeGreaterThan(0);

      const png = await sim.screenshot();
      // A real PNG, not an empty buffer: the 8-byte signature plus real bytes.
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(png.length).toBeGreaterThan(10_000);

      await sim.terminate(SYSTEM_APP);
    },
    KEYSTONE_TIMEOUT,
  );
});

// ─── the full tool surface: real simctl, faked WebDriverAgent ─────────────────

describeSim("ios-app keystone — the tool surface over a faked WebDriverAgent", () => {
  const SESSION = "ios-main";

  beforeAll(async () => {
    if (!simulator) return;
    clearBrowxEnv();
    workspace = mkdtempSync(join(tmpdir(), "browx-ios-keystone-"));
    process.env.BROWX_WORKSPACE = workspace;
    process.env.BROWX_CAPABILITIES = "read,navigation,action,human,native-device";
    wda = await startFakeWda();
    process.env.BROWX_IOS_DEVICE = simulator.udid;
    process.env.BROWX_IOS_APP_ID = SYSTEM_APP;
    process.env.BROWX_IOS_WDA_URL = wda.url;
    server = await createServer({ browserType: "ios-app" });
    handlers = server.handlers;
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    if (!simulator) return;
    await server?.shutdown().catch(() => undefined);
    await wda?.close().catch(() => undefined);
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    restoreEnv();
  }, KEYSTONE_TIMEOUT);

  it(
    "opens a session the registry tags engine:ios-app, with an app:// target",
    async () => {
      const opened = await callJson<{ ok: boolean }>("open_session", { session: SESSION });
      expect(opened.ok, JSON.stringify(opened)).toBe(true);
      const listed = await callJson<{
        sessions: Array<{ id: string; engine: string; url: string }>;
      }>("list_sessions", {});
      const row = listed.sessions.find((s) => s.id === SESSION);
      expect(row?.engine).toBe("ios-app");
      // The TargetSubstrate's `app://` scope, which is also what the secret-scope
      // containment check reads.
      expect(row?.url).toContain(`app://${SYSTEM_APP}`);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "snapshot renders the XCUITest hierarchy as role/name/[ref=eN]",
    async () => {
      const res = await handlers.snapshot({ session: SESSION });
      const text = (res.content[0] as { text: string }).text;
      expect(text).toMatch(/button/);
      expect(text).toMatch(/Pay now/);
      expect(text).toMatch(/\[ref=e\d+\]/);
      // The identifier reaches the agent as a tier-1 selector naming its source.
      expect(text).toMatch(/checkout-submit/);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "find ranks over the hierarchy and hands back a resolvable ref",
    async () => {
      const found = await callJson<{
        candidates: Array<{ ref: string; selectorHint?: string; role?: string }>;
      }>("find", { session: SESSION, query: "Pay now" });
      expect(found.candidates.length).toBeGreaterThan(0);
      const top = found.candidates[0]!;
      expect(top.ref).toMatch(/^e\d+$/);
      expect(top.selectorHint).toContain("accessibilityIdentifier");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "click re-resolves the ref against a FRESH hierarchy before it taps",
    async () => {
      // The claim RFC 0008 §3 makes, driven through the real tool handlers. The
      // ref is minted while the button is at y=700; the hierarchy then MOVES it,
      // and the tap must land on the new centre. A cached coordinate would land
      // on 724.
      wda.setSubmitY(700);
      const found = await callJson<{ candidates: Array<{ ref: string }> }>("find", {
        session: SESSION,
        query: "Pay now",
      });
      const ref = found.candidates[0]!.ref;
      wda.setSubmitY(300);
      wda.taps.length = 0;
      const clicked = await callJson<{ ok: boolean }>("click", { session: SESSION, ref });
      expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
      // Centre of {x:20, y:300, w:353, h:48} — read off the hierarchy the tap
      // itself fetched, not the one the ref was minted against.
      expect(wda.taps).toEqual([{ x: 197, y: 324 }]);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "verify_visible and verify_text run through the element port on a Page-free engine",
    async () => {
      const found = await callJson<{ candidates: Array<{ ref: string }> }>("find", {
        session: SESSION,
        query: "Pay now",
      });
      const ref = found.candidates[0]!.ref;
      const visible = await callJson<{ ok: boolean }>("verify_visible", { session: SESSION, ref });
      expect(visible.ok, JSON.stringify(visible)).toBe(true);
      const texted = await callJson<{ ok: boolean }>("verify_text", {
        session: SESSION,
        ref,
        text: "Pay now",
        exact: true,
      });
      expect(texted.ok, JSON.stringify(texted)).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "screenshot returns a REAL simulator frame through the capture port",
    async () => {
      // simctl, not the fake: this image is a genuine photograph of the booted
      // device, whatever the faked hierarchy says.
      const res = await handlers.screenshot({ session: SESSION });
      const image = res.content.find((c) => (c as { type: string }).type === "image") as
        { type: string; data: string; mimeType: string } | undefined;
      expect(image, JSON.stringify(res.content).slice(0, 300)).toBeTruthy();
      expect(image!.mimeType).toBe("image/png");
      expect(Buffer.from(image!.data, "base64").subarray(0, 8).toString("hex")).toBe(
        "89504e470d0a1a0a",
      );
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "gesture_swipe dispatches, and the three CDP-deep tools structured-refuse",
    async () => {
      const swiped = await callJson<{ ok: boolean; error?: string }>("gesture_swipe", {
        session: SESSION,
        from: { x: 200, y: 700 },
        to: { x: 200, y: 200 },
      });
      expect(
        swiped.error,
        "gesture_swipe must reach the substrate on a deep:false engine",
      ).toBeUndefined();
      expect(swiped.ok).toBe(true);
      // deep:false ⇒ the CDP-hard family refuses through the existing gate, with
      // no per-engine edit.
      for (const tool of ["perf_start", "heap_snapshot"]) {
        const refused = await callJson<{ ok: boolean; error?: string }>(tool, { session: SESSION });
        expect(refused.ok).toBe(false);
        expect(refused.error).toMatch(/not supported on the "ios-app" engine/);
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "the omitted sub-interfaces refuse rather than answering a plausible empty",
    async () => {
      // The gate that exists because a Safari substrate once answered
      // `{total: 0, requests: []}` for a question it could not answer.
      for (const [tool, args] of [
        ["network_read", {}],
        ["cookies_list", {}],
        ["frames_list", {}],
      ] as const) {
        const res = await callJson<{ ok: boolean; engine?: string; hint?: string }>(tool, {
          session: SESSION,
          ...args,
        });
        expect(res.ok, `${tool} answered instead of refusing`).toBe(false);
        expect(res.engine).toBe("ios-app");
        expect(typeof res.hint).toBe("string");
      }
    },
    KEYSTONE_TIMEOUT,
  );
});
