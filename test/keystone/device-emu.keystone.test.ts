// device-emulation keystone — drive a real headless Chromium against the
// fixture's navigator.bluetooth / navigator.usb / navigator.hid handlers,
// proving the init-script wrappers + binding behave end-to-end:
//
//   - With no staged catalog, Bluetooth/USB requestDevice() rejects with
//     NotFoundError (user-dismissed picker shape); HID resolves with [].
//   - After `emulate_*({devices:[…]})`, the page-side requestDevice()
//     resolves with synthetic objects carrying the agent-supplied fields.
//   - `device_requests` surfaces the buffered page-side calls.
//   - Without the `device-emulation` capability, the four tools are
//     rejected at the gate layer.
//
// All four tools sit under the off-by-default `device-emulation` capability,
// so we spin up our own server with the capability enabled — same pattern
// as the fs-picker keystone.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

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
  if (!fn) throw new Error(`device-emu keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await handlers[name]!(args);
  return (res.content[0] as { text: string }).text;
}

async function pollSnapshot(session: string, predicate: (s: string) => boolean): Promise<string> {
  let out = "";
  for (let i = 0; i < 60 && !predicate(out); i++) {
    out = await callText("snapshot", { session });
    if (predicate(out)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return out;
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-devemu-ks-"));
  process.env.BROWX_WORKSPACE = workspace;
  // Enable `device-emulation` so the four tools clear the gate. The other
  // defaults (read/navigation/action/human) carry the click + snapshot
  // tools the keystone drives.
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human,device-emulation";

  fixture = await startFixture();
  server = await createServer({ headless: true });
  handlers = server.handlers;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  delete process.env.BROWX_CAPABILITIES;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describe("device-emulation keystone — Web Bluetooth / WebUSB / WebHID against real Chromium", () => {
  // TODO(v1.0.x): Linux CI Chromium ships without `navigator.bluetooth`
  // (and intermittently without `navigator.usb`), so the fixture writes
  // `no-bt-api` instead of `rejected name=NotFoundError`. Local macOS
  // Chromium has the APIs and the test passes. Restore once we either
  // (a) launch Chromium with the WebBluetooth/WebUSB feature flags forced
  // on, or (b) install init-script stubs that synthesise the APIs even
  // when Chromium omits them on the host platform. See PR #16 builder
  // report.
  it.skip(
    "empty catalog → user-dismissed shape; staged catalog → synthetic device resolves",
    async () => {
      const session = "ks-device-emu";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });

      // ---- (1) No catalog staged. Bluetooth/USB reject; HID resolves with []. ----
      await callJson("click", { session, selector: '[data-testid="bt-btn"]' });
      const btDismissed = await pollSnapshot(session, (s) => /bt-result.*?rejected name=NotFoundError/.test(s));
      expect(btDismissed).toMatch(/rejected name=NotFoundError/);

      await callJson("click", { session, selector: '[data-testid="usb-btn"]' });
      const usbDismissed = await pollSnapshot(session, (s) => /usb-result.*?rejected name=NotFoundError/.test(s));
      expect(usbDismissed).toMatch(/rejected name=NotFoundError/);

      await callJson("click", { session, selector: '[data-testid="hid-btn"]' });
      const hidDismissed = await pollSnapshot(session, (s) => /hid-result.*?empty count=0/.test(s));
      expect(hidDismissed).toMatch(/empty count=0/);

      // device_requests captured all three calls.
      const reqs0 = await callJson<{
        ok: boolean;
        requests: Array<{ api: string; handledAs: string; returned: number }>;
      }>("device_requests", { session });
      expect(reqs0.ok).toBe(true);
      expect(reqs0.requests.some((r) => r.api === "bluetooth" && r.handledAs === "rejected")).toBe(true);
      expect(reqs0.requests.some((r) => r.api === "usb" && r.handledAs === "rejected")).toBe(true);
      expect(reqs0.requests.some((r) => r.api === "hid" && r.handledAs === "empty")).toBe(true);

      // ---- (2) Stage a catalog for each API. Pickers resolve with the
      // synthetic device(s). ----
      const stageBt = await callJson<{ ok: boolean; api: string; catalog: { devices: unknown[] } }>(
        "emulate_bluetooth",
        { session, devices: [{ name: "heart-rate-monitor", id: "bt-aa-bb-cc" }] },
      );
      expect(stageBt.ok).toBe(true);
      expect(stageBt.api).toBe("bluetooth");
      expect(stageBt.catalog.devices).toHaveLength(1);

      const stageUsb = await callJson<{ ok: boolean }>(
        "emulate_usb",
        { session, devices: [{ name: "browxai-usb-pen", vendorId: 0x1234, productId: 0x5678 }] },
      );
      expect(stageUsb.ok).toBe(true);

      const stageHid = await callJson<{ ok: boolean; catalog: { devices: unknown[] } }>(
        "emulate_hid",
        { session, devices: [
          { name: "hid-one", vendorId: 0x1111, productId: 0x2222 },
          { name: "hid-two", vendorId: 0x3333, productId: 0x4444 },
        ] },
      );
      expect(stageHid.ok).toBe(true);
      expect(stageHid.catalog.devices).toHaveLength(2);

      await callJson("click", { session, selector: '[data-testid="bt-btn"]' });
      const btOk = await pollSnapshot(session, (s) => /bt-result.*?resolved name=heart-rate-monitor/.test(s));
      expect(btOk).toMatch(/resolved name=heart-rate-monitor id=bt-aa-bb-cc/);

      await callJson("click", { session, selector: '[data-testid="usb-btn"]' });
      const usbOk = await pollSnapshot(session, (s) => /usb-result.*?resolved vendorId=4660/.test(s));
      expect(usbOk).toMatch(/resolved vendorId=4660 productName=browxai-usb-pen/);

      await callJson("click", { session, selector: '[data-testid="hid-btn"]' });
      const hidOk = await pollSnapshot(session, (s) => /hid-result.*?resolved count=2 first=hid-one/.test(s));
      expect(hidOk).toMatch(/resolved count=2 first=hid-one/);

      // device_requests sees the second-pass resolved calls.
      const reqs1 = await callJson<{
        requests: Array<{ api: string; handledAs: string; returned: number }>;
      }>("device_requests", { session });
      const resolvedReqs = reqs1.requests.filter((r) => r.handledAs === "resolved");
      expect(resolvedReqs.length).toBeGreaterThanOrEqual(3);
      const hidResolved = resolvedReqs.find((r) => r.api === "hid");
      expect(hidResolved?.returned).toBe(2);

      // ---- (3) Clear the bluetooth catalog. Next bt call rejects again. ----
      const clearBt = await callJson<{ ok: boolean; catalog: { devices: unknown[] } }>(
        "emulate_bluetooth",
        { session, devices: [] },
      );
      expect(clearBt.ok).toBe(true);
      expect(clearBt.catalog.devices).toEqual([]);
      const cutBeforeReclick = Date.now();
      await new Promise((r) => setTimeout(r, 20));
      await callJson("click", { session, selector: '[data-testid="bt-btn"]' });
      // Poll device_requests rather than the snapshot — the page-side output
      // already says "rejected name=NotFoundError" from step (1), so we can't
      // distinguish the new click via DOM text. The request buffer is the
      // canonical source of "what happened since the clear".
      let postClear: Array<{ api: string; handledAs: string }> = [];
      for (let i = 0; i < 60 && !postClear.some((r) => r.api === "bluetooth" && r.handledAs === "rejected"); i++) {
        const r = await callJson<{ requests: Array<{ api: string; handledAs: string }> }>(
          "device_requests",
          { session, since: cutBeforeReclick },
        );
        postClear = r.requests;
        if (postClear.some((req) => req.api === "bluetooth" && req.handledAs === "rejected")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(postClear.some((r) => r.api === "bluetooth" && r.handledAs === "rejected")).toBe(true);
      // And no `resolved` bluetooth entry was issued after the clear.
      expect(postClear.some((r) => r.api === "bluetooth" && r.handledAs === "resolved")).toBe(false);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  // TODO(v1.0.x): same Linux-CI Chromium gap as above — fixture writes
  // `no-bt-api` so the `bt-result.*?rejected` poll never resolves. Restore
  // alongside the sibling case.
  it.skip(
    "since={now} slices device_requests to the action window",
    async () => {
      const session = "ks-device-emu-window";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });
      await callJson("click", { session, selector: '[data-testid="bt-btn"]' });
      await pollSnapshot(session, (s) => /bt-result.*?rejected/.test(s));
      const cut = Date.now();
      await new Promise((r) => setTimeout(r, 20));
      await callJson("click", { session, selector: '[data-testid="usb-btn"]' });
      await pollSnapshot(session, (s) => /usb-result.*?rejected/.test(s));

      const slice = await callJson<{ requests: Array<{ api: string }> }>(
        "device_requests",
        { session, since: cut },
      );
      expect(slice.requests.length).toBeGreaterThanOrEqual(1);
      expect(slice.requests.every((r) => r.api !== "bluetooth")).toBe(true);
      expect(slice.requests.some((r) => r.api === "usb")).toBe(true);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

// Capability-off gate proof. Run on a separate server with the capability
// stripped — the four tools refuse with the standard structured error.
describe("device-emulation keystone — capability off → tools refuse at the gate", () => {
  let gatedServer: Awaited<ReturnType<typeof createServer>> | undefined;
  let gatedHandlers: Handlers;
  const gatedEnv: Record<string, string | undefined> = {};
  let gatedWorkspace: string | undefined;

  beforeAll(async () => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("BROWX_")) {
        gatedEnv[k] = process.env[k];
        delete process.env[k];
      }
    }
    gatedWorkspace = mkdtempSync(join(tmpdir(), "browx-devemu-gated-"));
    process.env.BROWX_WORKSPACE = gatedWorkspace;
    // Default capability set — `device-emulation` deliberately absent.
    process.env.BROWX_CAPABILITIES = "read,navigation,action,human";
    gatedServer = await createServer({ headless: true });
    gatedHandlers = gatedServer.handlers;
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await gatedServer?.shutdown().catch(() => undefined);
    delete process.env.BROWX_WORKSPACE;
    delete process.env.BROWX_CAPABILITIES;
    for (const [k, v] of Object.entries(gatedEnv)) if (v !== undefined) process.env[k] = v;
    if (gatedWorkspace) rmSync(gatedWorkspace, { recursive: true, force: true });
  }, KEYSTONE_TIMEOUT);

  it(
    "emulate_bluetooth / emulate_usb / emulate_hid / device_requests refuse without the capability",
    async () => {
      for (const tool of ["emulate_bluetooth", "emulate_usb", "emulate_hid", "device_requests"]) {
        const fn = gatedHandlers[tool];
        expect(fn, `${tool} should still be registered`).toBeTruthy();
        const res = await fn!({ devices: [] });
        const body = JSON.parse((res.content[0] as { text: string }).text) as {
          ok: boolean;
          error?: string;
        };
        expect(body.ok, `${tool} should refuse without device-emulation capability`).toBe(false);
        expect(body.error ?? "").toMatch(/capability/i);
      }
    },
    KEYSTONE_TIMEOUT,
  );
});
