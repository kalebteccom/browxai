// Per-session Web Bluetooth / WebUSB / WebHID device emulation. Sibling of
// `permission` / `notification` / `fs-picker` — but a posture step further:
// where those modules govern access to APIs the browser already exposes,
// this one synthesises *responses* for three powerful platform APIs whose
// real semantics talk to physical devices the agent doesn't have. The use
// case is letting agents drive a page that gates a flow behind a Web
// Bluetooth / WebUSB / WebHID device picker without owning the hardware —
// the page believes it found and connected to a device because the
// init-script-wrapped `navigator.bluetooth.requestDevice()` /
// `navigator.usb.requestDevice()` / `navigator.hid.requestDevice()` resolve
// with synthetic objects matching the W3C shapes.
//
// Why this is its own capability (`device-emulation`, off-by-default):
//   The wrappers tell the page it has access to physical devices that don't
//   exist. A page that scans, names, and pairs against a Bluetooth heart-rate
//   monitor will believe one is present. That's a posture-broadening change
//   distinct from the surrounding policies — those say "the page CAN'T do X
//   (and we record it)"; this one says "the page CAN do X (and we lie about
//   what it found)". Off by default and loud-warned at boot, same posture
//   class as `eval` / `network-body` / `secrets` / `extensions`.
//
// What the wrappers cover (v1 scope):
//   - `navigator.bluetooth.requestDevice(options)` →
//     resolves to a synthetic BluetoothDevice (`{ id, name, gatt }`); empty
//     catalog rejects with `NotFoundError` ("User cancelled the requestDevice
//     chooser") — same as the real picker when the human dismisses it.
//   - `navigator.usb.requestDevice(options)` →
//     resolves to a synthetic USBDevice (`{ vendorId, productId, productName,
//     manufacturerName, serialNumber, deviceClass, … }`); empty catalog
//     rejects with `NotFoundError`.
//   - `navigator.hid.requestDevice(options)` →
//     resolves to an Array<HIDDevice> (the HID API is multi-result by
//     construction); empty catalog resolves with `[]` (real HID picker
//     returns `[]` when the user picks nothing).
//
// The page-side requestDevice CATALOG (the synthetic device list) is set by
// the three tools (`emulate_bluetooth` / `emulate_usb` / `emulate_hid`).
// Calling with `{}` (no `devices`) clears the catalog — the next
// `requestDevice` rejects (Bluetooth/USB) or returns `[]` (HID), same as a
// human dismissing the picker. Calling with `{devices:[…]}` installs a new
// catalog — the next `requestDevice` resolves with the matching synthetic
// device. The pattern intentionally mirrors `fs_picker_respond`'s "stage
// the agent-supplied response, let the page's own action trigger the API
// call" model — the agent doesn't drive a tool when the page calls
// `requestDevice`; the page does, and the wrapper consults the catalog.
//
// What the wrappers DELIBERATELY do not cover (v1):
//   - GATT service emulation for Bluetooth. The synthetic `BluetoothDevice`
//     carries a stub `gatt` with `connect()` resolving to a stub server
//     whose `getPrimaryService()` rejects with `NotFoundError`. A page that
//     only needs the device-picker step to clear (a common pattern in BLE-
//     onboarding flows) works as-is; a page that then exchanges
//     characteristic reads/writes does not. Surfaced as deferred follow-up.
//   - WebUSB transfer endpoints. `USBDevice.open()` / `selectConfiguration()`
//     / `transferIn()` / `transferOut()` are stubs that resolve with empty/
//     zero-byte results. Same justification: enough for picker-clearing.
//   - HID input/output reports. `HIDDevice.open()` resolves; `sendReport()`
//     resolves; `oninputreport` never fires (no synthetic device traffic).
//   - Permission-style `getDevices()` enumeration (the W3C API has a
//     post-permission read-side: `navigator.bluetooth.getDevices()`,
//     `navigator.usb.getDevices()`, `navigator.hid.getDevices()`). v1
//     wraps requestDevice only; getDevices returns the native value (which
//     is `[]` on a Chromium without any granted devices). Surfaced as
//     deferred follow-up.
//
// Per-action capture. Every page-side `requestDevice` call is appended to a
// buffer with a timestamp + the API + the agent-facing outcome (`resolved`
// / `rejected` / `empty`). `device_requests({session})` is the read-side
// view — separate from `ActionResult`'s policy-failure flips because
// `device-emulation` is an opt-in capability (you don't get a no-op-flips-
// ActionResult.ok footgun from a capability you explicitly enabled).

import type { BrowserContext, Page } from "playwright-core";
import { log } from "../util/logging.js";

/** The three Web platform APIs browxai's device-emulation governs. */
export const SUPPORTED_DEVICE_APIS = ["bluetooth", "usb", "hid"] as const;
export type DeviceApi = (typeof SUPPORTED_DEVICE_APIS)[number];

/** Agent-supplied synthetic device entry. All three APIs share the union
 *  shape; the wrapper picks the fields relevant to its API (Bluetooth uses
 *  `name` + `id` + `services`; USB uses the vendor/product/class fields;
 *  HID uses `vendorId` + `productId` + `productName`). A single entry can
 *  carry every field — the page sees only what the spec exposes for its API. */
export interface SyntheticDevice {
  /** Display name. Bluetooth uses this as `.name`; USB exposes it as
   *  `.productName`; HID as `.productName`. Default `"browxai-virtual"`. */
  name?: string;
  /** Bluetooth: stable device id (UUID-style string). Default
   *  `"browxai-<api>-<index>"`. */
  id?: string;
  /** USB / HID: 16-bit USB-IF vendor id. Default `0x0000`. */
  vendorId?: number;
  /** USB / HID: 16-bit product id. Default `0x0000`. */
  productId?: number;
  /** USB: human-readable manufacturer string. Default `"browxai virtual"`. */
  manufacturerName?: string;
  /** USB: serial number string. Default `"BROWX-VIRTUAL"`. */
  serialNumber?: string;
  /** USB: 8-bit device class (e.g. 0x03 = HID). Default 0xFF (vendor-
   *  specific). */
  deviceClass?: number;
  /** USB: 8-bit device subclass. Default 0x00. */
  deviceSubclass?: number;
  /** USB: 8-bit device protocol. Default 0x00. */
  deviceProtocol?: number;
  /** Bluetooth: GATT primary service UUIDs the device advertises. Default
   *  `[]`. The synthetic `gatt.getPrimaryService()` still rejects (no
   *  full GATT emulation in v1) — the list is exposed only via the
   *  picker-time filter match + on the resolved device's metadata for
   *  pages that introspect `device.uuids`-style fields. */
  services?: string[];
  /** HID: report descriptor's collection topology (output only — the
   *  agent describes what `collections[]` looks like). Default `[]`. */
  collections?: unknown[];
}

/** Public, runtime-mutable per-API catalog. Empty list → next requestDevice
 *  rejects (Bluetooth/USB) or returns [] (HID). */
export interface DeviceCatalog {
  devices: SyntheticDevice[];
}

/** One captured `requestDevice` call, surfaced on `device_requests`. */
export interface DeviceRequestRecord {
  api: DeviceApi;
  /** What the wrapper actually did:
   *    - `"resolved"`  — catalog non-empty; picker resolved with a synthetic
   *                      device (Bluetooth/USB) or device list (HID).
   *    - `"rejected"`  — catalog empty for Bluetooth/USB; picker rejected
   *                      with NotFoundError ("user dismissed").
   *    - `"empty"`     — catalog empty for HID; picker resolved with []
   *                      (the HID picker's user-dismissed shape).
   *    - `"refused"`   — capability `device-emulation` was OFF at the time
   *                      of the call; the wrapper let the native API run
   *                      (which in headless Chromium rejects/returns empty
   *                      anyway). Recorded so the read-side surfaces "the
   *                      page asked but you didn't have the capability on". */
  handledAs: "resolved" | "rejected" | "empty" | "refused";
  /** Filter the page supplied in `requestDevice(options.filters[])` /
   *  `acceptAllDevices` / etc. — sliced down to a single JSON-safe shape
   *  the agent can read. Best-effort: shapes that exceed 4KB stringified
   *  are truncated with a `…` marker. */
  filters?: unknown;
  /** Count of devices returned to the page on this call. For Bluetooth/USB:
   *  always 0 or 1. For HID: 0..N. */
  returned: number;
  /** epoch ms — used by `device_requests({since?})` slice. */
  ts: number;
}

/** Mutable per-session state. The page-side wrapper consults `catalog(api)`
 *  via the bridge binding on every `requestDevice` call, so a `set` call
 *  takes effect on the very next page-side request without a navigation. */
export class DeviceEmulationState {
  /** Per-API catalog. Empty list (or absent entry) → wrapper falls into
   *  the user-dismissed-picker shape for that API. */
  private catalogs: Record<DeviceApi, DeviceCatalog> = {
    bluetooth: { devices: [] },
    usb: { devices: [] },
    hid: { devices: [] },
  };
  /** Captured `requestDevice` calls. Capped — chatty pages can't grow this
   *  without bound; `device_requests` slices on `since`. */
  private buffer: DeviceRequestRecord[] = [];
  private readonly cap: number;
  /** Contexts we've already installed the init-script + binding on.
   *  Idempotent install guard — BYOB reconnect / context rebuild MUST not
   *  double-wire. */
  private wired = new WeakSet<BrowserContext>();
  /** True iff `device-emulation` capability was on at the time of attach.
   *  The page-side wrapper installs regardless (so a runtime capability
   *  toggle that adds the cap takes effect — though the canonical
   *  resolve-once-at-boot model means it doesn't), but the check binding
   *  short-circuits to `refused` when off. */
  private enabledByCapability: boolean;

  constructor(enabledByCapability: boolean, cap = 200) {
    this.enabledByCapability = enabledByCapability;
    this.cap = cap;
  }

  /** Snapshot of one API's catalog. */
  catalog(api: DeviceApi): DeviceCatalog {
    return { devices: [...this.catalogs[api].devices] };
  }

  /** Replace one API's catalog. `devices` may be empty (clears the catalog —
   *  next requestDevice rejects/empty). Returns the resolved catalog
   *  (echoed back so the tool's response shows what the wrapper will
   *  serve). */
  set(api: DeviceApi, devices: SyntheticDevice[]): DeviceCatalog {
    if (!Array.isArray(devices)) {
      throw new Error(
        `emulate_${api}: \`devices\` must be an array (pass [] to clear the catalog)`,
      );
    }
    // Normalise each entry: every field is optional on the agent side, but
    // the page-side script needs deterministic defaults to compose a
    // synthetic device object the page won't trip on.
    this.catalogs[api] = {
      devices: devices.map((d, i) => normaliseDevice(api, d, i)),
    };
    return this.catalog(api);
  }

  /** Append a request record. Caps the buffer at `cap`. */
  record(rec: DeviceRequestRecord): void {
    this.buffer.push(rec);
    if (this.buffer.length > this.cap) this.buffer.shift();
  }

  /** Slice records with `ts >= since`. Default since=0 returns all. */
  since(since: number = 0): DeviceRequestRecord[] {
    return this.buffer.filter((r) => r.ts >= since);
  }

  /** Capability gate snapshot. The check binding consults this on every
   *  page-side request. */
  capabilityEnabled(): boolean {
    return this.enabledByCapability;
  }

  /** Has this context already been wired? Idempotent install guard. */
  hasContext(c: BrowserContext): boolean {
    return this.wired.has(c);
  }
  /** Mark a context as wired. */
  markContext(c: BrowserContext): void {
    this.wired.add(c);
  }
}

/** Default field values per API. Each tool call defaults missing fields so
 *  the page sees a complete synthetic device shape regardless of how
 *  sparsely the agent populated it. */
function normaliseDevice(api: DeviceApi, d: SyntheticDevice, index: number): SyntheticDevice {
  const out: SyntheticDevice = {
    name: d.name ?? "browxai-virtual",
    id: d.id ?? `browxai-${api}-${index}`,
    vendorId: d.vendorId ?? 0x0000,
    productId: d.productId ?? 0x0000,
    manufacturerName: d.manufacturerName ?? "browxai virtual",
    serialNumber: d.serialNumber ?? "BROWX-VIRTUAL",
    deviceClass: d.deviceClass ?? 0xff,
    deviceSubclass: d.deviceSubclass ?? 0x00,
    deviceProtocol: d.deviceProtocol ?? 0x00,
    services: d.services ?? [],
    collections: d.collections ?? [],
  };
  return out;
}

/** Capture-safe stringify with a 4KB ceiling. Filters from a Web Bluetooth
 *  `requestDevice` call are typically a few hundred bytes (filter array
 *  with a couple of service UUIDs); we truncate aggressively only to defend
 *  the buffer from a chatty page composing absurd filters. */
function safeFilters(raw: unknown): unknown {
  try {
    const s = JSON.stringify(raw);
    if (s.length <= 4096) return raw;
    return JSON.parse(s.slice(0, 4096) + '"…"}'); // best-effort
  } catch {
    return undefined;
  }
}

/** BYOB warning — the init-script wrappers patch every new document in the
 *  attached Chrome's session-isolated context; the patches do NOT escape
 *  the context, but the per-deployment posture (the operator's main Chrome
 *  running with `--remote-debugging-port`) magnifies the consequences of a
 *  page that the agent told "you have a hardware device". Surfaced when
 *  `open_session({mode:"attached"})` engages with `device-emulation` on. */
export const BYOB_DEVICE_EMU_WARNING =
  "BYOB caveat: device-emulation wrappers patch `navigator.bluetooth` / `navigator.usb` / `navigator.hid` " +
  "on an attached (not-owned) Chrome session. The wrappers are scoped to the context browxai opened, " +
  "but the operator's main Chrome shares the same browser binary; treat any page reached during the " +
  "session as having believed the synthetic catalog while it was set. Clearing the catalog (`emulate_*({devices:[]})`) " +
  "restores the user-dismissed-picker shape on the next requestDevice; the wrapper itself stays installed " +
  "for the life of the context.";

/** Init script that wraps the three Web platform device-picker APIs. Each
 *  wrapper consults `window.__browx_device_check({api, filters?})` (the
 *  exposeBinding from the server side) on every page-side `requestDevice`
 *  call — the binding returns a `{decision, devices?}` envelope the wrapper
 *  unpacks into the API-specific shape the spec expects. Keep browser-only
 *  JS (no TS-only syntax). Re-injected on `framenavigated` (idempotent:
 *  guards on `window.__browx_device_emu_installed`). */
export const DEVICE_EMU_PAGE_SCRIPT = `(() => {
  if (window.__browx_device_emu_installed) return;
  window.__browx_device_emu_installed = true;

  function check(api, filters) {
    try {
      if (typeof window.__browx_device_check === "function") {
        return Promise.resolve(window.__browx_device_check(JSON.stringify({
          api: api,
          filters: filters == null ? null : safeFilters(filters),
        })));
      }
    } catch (_) {}
    // Binding missing — safe-by-default empty catalog so the page sees the
    // user-dismissed shape rather than a hung promise.
    return Promise.resolve(JSON.stringify({ decision: "refused", devices: [] }));
  }

  function safeFilters(f) {
    // Defensive shallow clone — page may pass non-serialisable garbage
    // (BigInt, function, circular). Best-effort.
    try { return JSON.parse(JSON.stringify(f)); } catch (_) { return null; }
  }

  function notFound(msg) {
    var e = new Error(msg || "User cancelled the requestDevice() chooser.");
    try { e.name = "NotFoundError"; } catch (_) {}
    return e;
  }

  function parseResponse(raw) {
    try {
      var r = typeof raw === "string" ? JSON.parse(raw) : (raw || {});
      var decision = r.decision;
      var devices = Array.isArray(r.devices) ? r.devices : [];
      return { decision: decision, devices: devices };
    } catch (_) {
      return { decision: "refused", devices: [] };
    }
  }

  // ---- Bluetooth -------------------------------------------------------
  // Synthesise the minimal BluetoothDevice + BluetoothRemoteGATTServer
  // surface modern BLE-onboarding flows touch: id / name / gatt.connect()
  // → stub server whose getPrimaryService() rejects (no GATT emulation in
  // v1). Pages that gate on "we found a device" pass; pages that go on to
  // exchange characteristic data do not.
  function syntheticBluetoothDevice(spec) {
    var name = spec.name || "browxai-virtual";
    var id = spec.id || "browxai-bt-0";
    var services = Array.isArray(spec.services) ? spec.services : [];
    var device;
    var gatt = {
      get connected() { return gatt.__connected; },
      __connected: false,
      device: null, // set after device is created (circular ref)
      connect: function () {
        gatt.__connected = true;
        return Promise.resolve(gatt);
      },
      disconnect: function () { gatt.__connected = false; },
      getPrimaryService: function () {
        return Promise.reject(notFound("GATT service emulation not supported in browxai v1"));
      },
      getPrimaryServices: function () {
        return Promise.reject(notFound("GATT service emulation not supported in browxai v1"));
      },
    };
    device = {
      id: id,
      name: name,
      uuids: services,
      gatt: gatt,
      // EventTarget stubs — pages sometimes attach gattserverdisconnected;
      // we accept and ignore.
      addEventListener: function () {},
      removeEventListener: function () {},
      dispatchEvent: function () { return true; },
      watchAdvertisements: function () { return Promise.resolve(undefined); },
      unwatchAdvertisements: function () {},
      get watchingAdvertisements() { return false; },
      // forget() — modern API for revoking the permission; resolves no-op.
      forget: function () { return Promise.resolve(undefined); },
    };
    gatt.device = device;
    return device;
  }
  try {
    var bt = navigator.bluetooth;
    if (bt && typeof bt.requestDevice === "function") {
      // Replace the entire requestDevice; we intentionally do NOT call
      // through to the native API even when the agent didn't stage a
      // catalog — calling through on a headless Chromium often hangs the
      // promise indefinitely (no picker UI to dismiss).
      Object.defineProperty(bt, "requestDevice", {
        configurable: true,
        writable: true,
        value: function (options) {
          var filters = options || null;
          return check("bluetooth", filters).then(function (raw) {
            var r = parseResponse(raw);
            if (!r.devices.length) {
              throw notFound();
            }
            return syntheticBluetoothDevice(r.devices[0]);
          });
        },
      });
      // getDevices — read-side: pre-paired devices. v1 returns the live
      // catalog so a page polling for an already-paired device sees one.
      if (typeof bt.getDevices === "function") {
        Object.defineProperty(bt, "getDevices", {
          configurable: true,
          writable: true,
          value: function () {
            return check("bluetooth", null).then(function (raw) {
              var r = parseResponse(raw);
              return r.devices.map(syntheticBluetoothDevice);
            });
          },
        });
      }
    }
  } catch (_) {}

  // ---- WebUSB ----------------------------------------------------------
  // USBDevice synthesises the picker-resolve surface + stub
  // open/close/selectConfiguration; transferIn/transferOut resolve with
  // zero-byte responses so a page sequence doesn't reject mid-flight, but
  // there's no actual data flow.
  function syntheticUSBDevice(spec) {
    var name = spec.name || "browxai-virtual";
    return {
      vendorId: spec.vendorId || 0,
      productId: spec.productId || 0,
      productName: name,
      manufacturerName: spec.manufacturerName || "browxai virtual",
      serialNumber: spec.serialNumber || "BROWX-VIRTUAL",
      deviceClass: spec.deviceClass != null ? spec.deviceClass : 0xFF,
      deviceSubclass: spec.deviceSubclass || 0,
      deviceProtocol: spec.deviceProtocol || 0,
      usbVersionMajor: 2,
      usbVersionMinor: 0,
      usbVersionSubminor: 0,
      deviceVersionMajor: 1,
      deviceVersionMinor: 0,
      deviceVersionSubminor: 0,
      configuration: null,
      configurations: [],
      opened: false,
      open: function () { this.opened = true; return Promise.resolve(undefined); },
      close: function () { this.opened = false; return Promise.resolve(undefined); },
      selectConfiguration: function () { return Promise.resolve(undefined); },
      claimInterface: function () { return Promise.resolve(undefined); },
      releaseInterface: function () { return Promise.resolve(undefined); },
      selectAlternateInterface: function () { return Promise.resolve(undefined); },
      controlTransferIn: function () { return Promise.resolve({ data: new DataView(new ArrayBuffer(0)), status: "ok" }); },
      controlTransferOut: function () { return Promise.resolve({ bytesWritten: 0, status: "ok" }); },
      clearHalt: function () { return Promise.resolve(undefined); },
      transferIn: function () { return Promise.resolve({ data: new DataView(new ArrayBuffer(0)), status: "ok" }); },
      transferOut: function () { return Promise.resolve({ bytesWritten: 0, status: "ok" }); },
      isochronousTransferIn: function () { return Promise.resolve({ data: new DataView(new ArrayBuffer(0)), packets: [] }); },
      isochronousTransferOut: function () { return Promise.resolve({ packets: [] }); },
      reset: function () { return Promise.resolve(undefined); },
      forget: function () { return Promise.resolve(undefined); },
    };
  }
  try {
    var usb = navigator.usb;
    if (usb && typeof usb.requestDevice === "function") {
      Object.defineProperty(usb, "requestDevice", {
        configurable: true,
        writable: true,
        value: function (options) {
          var filters = options || null;
          return check("usb", filters).then(function (raw) {
            var r = parseResponse(raw);
            if (!r.devices.length) {
              throw notFound();
            }
            return syntheticUSBDevice(r.devices[0]);
          });
        },
      });
      if (typeof usb.getDevices === "function") {
        Object.defineProperty(usb, "getDevices", {
          configurable: true,
          writable: true,
          value: function () {
            return check("usb", null).then(function (raw) {
              var r = parseResponse(raw);
              return r.devices.map(syntheticUSBDevice);
            });
          },
        });
      }
    }
  } catch (_) {}

  // ---- WebHID ----------------------------------------------------------
  // HIDDevice differs from USB in two ways the wrapper preserves:
  //   - requestDevice resolves to an Array<HIDDevice>, NOT a single
  //     device (even when only one match — see W3C spec).
  //   - Empty result is the user-dismissed shape, NOT a rejection.
  function syntheticHIDDevice(spec) {
    var name = spec.name || "browxai-virtual";
    return {
      opened: false,
      vendorId: spec.vendorId || 0,
      productId: spec.productId || 0,
      productName: name,
      collections: Array.isArray(spec.collections) ? spec.collections : [],
      open: function () { this.opened = true; return Promise.resolve(undefined); },
      close: function () { this.opened = false; return Promise.resolve(undefined); },
      forget: function () { return Promise.resolve(undefined); },
      sendReport: function () { return Promise.resolve(undefined); },
      sendFeatureReport: function () { return Promise.resolve(undefined); },
      receiveFeatureReport: function () { return Promise.resolve(new DataView(new ArrayBuffer(0))); },
      addEventListener: function () {},
      removeEventListener: function () {},
      dispatchEvent: function () { return true; },
      oninputreport: null,
    };
  }
  try {
    var hid = navigator.hid;
    if (hid && typeof hid.requestDevice === "function") {
      Object.defineProperty(hid, "requestDevice", {
        configurable: true,
        writable: true,
        value: function (options) {
          var filters = options || null;
          return check("hid", filters).then(function (raw) {
            var r = parseResponse(raw);
            return r.devices.map(syntheticHIDDevice);
          });
        },
      });
      if (typeof hid.getDevices === "function") {
        Object.defineProperty(hid, "getDevices", {
          configurable: true,
          writable: true,
          value: function () {
            return check("hid", null).then(function (raw) {
              var r = parseResponse(raw);
              return r.devices.map(syntheticHIDDevice);
            });
          },
        });
      }
    }
  } catch (_) {}
})();`;

/** Server-side wire-up. Installs:
 *   - `__browx_device_check` exposeBinding: page-side `requestDevice` calls
 *     route here; we read the catalog for the requested API, record the
 *     call, and return `{decision, devices}`. `decision` is informational
 *     (the page-side wrapper consults `devices.length` to pick the
 *     spec-correct empty-result shape per API).
 *   - The page-side init script (re-injected by Playwright on every new
 *     document).
 *
 *  Idempotent on the same context. Errors during install are logged and
 *  swallowed — the page-side wrapper falls back to "decision: refused,
 *  devices: []" when the binding is missing, so a page calling
 *  requestDevice never deadlocks.
 */
export async function attachDeviceEmulation(
  context: BrowserContext,
  state: DeviceEmulationState,
): Promise<void> {
  if (state.hasContext(context)) return;
  state.markContext(context);

  try {
    await context.exposeBinding("__browx_device_check", (_source, payload: string) => {
      try {
        const o = JSON.parse(payload) as { api?: string; filters?: unknown };
        const api = o.api as DeviceApi;
        if (!SUPPORTED_DEVICE_APIS.includes(api)) {
          return JSON.stringify({ decision: "refused", devices: [] });
        }
        const ts = Date.now();
        const filters = safeFilters(o.filters ?? null);
        // Capability is off → refuse: page-side wrapper still resolves
        // to the user-dismissed shape (Bluetooth/USB reject; HID returns
        // []), but we record the call so `device_requests` shows "the
        // page asked for hardware and you didn't have the capability on".
        if (!state.capabilityEnabled()) {
          state.record({
            api,
            handledAs: "refused",
            returned: 0,
            ts,
            ...(filters !== undefined && filters !== null ? { filters } : {}),
          });
          return JSON.stringify({ decision: "refused", devices: [] });
        }
        const cat = state.catalog(api);
        const devices = cat.devices;
        const handledAs: DeviceRequestRecord["handledAs"] =
          devices.length > 0 ? "resolved" : api === "hid" ? "empty" : "rejected";
        const returned = api === "hid" ? devices.length : devices.length > 0 ? 1 : 0;
        state.record({
          api,
          handledAs,
          returned,
          ts,
          ...(filters !== undefined && filters !== null ? { filters } : {}),
        });
        // Bluetooth/USB are single-result picker APIs: the page-side
        // wrapper expects to find devices[0] in the response and rejects
        // when the list is empty. HID is multi-result: empty resolves
        // with []. We pass the catalog verbatim; the wrapper knows the
        // shape.
        const responseDevices = api === "hid" ? devices : devices.slice(0, 1);
        return JSON.stringify({ decision: handledAs, devices: responseDevices });
      } catch (err) {
        log.warn("session.device-emu: check handler error", {
          error: err instanceof Error ? err.message : String(err),
        });
        return JSON.stringify({ decision: "refused", devices: [] });
      }
    });
  } catch (err) {
    log.warn(
      "session.device-emu: exposeBinding install failed; page-side wrapper falls back to refused",
      {
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  try {
    await context.addInitScript({ content: DEVICE_EMU_PAGE_SCRIPT });
    for (const page of context.pages()) {
      await page.evaluate(DEVICE_EMU_PAGE_SCRIPT).catch(() => undefined);
    }
  } catch (err) {
    log.warn("session.device-emu: addInitScript failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Re-apply the init script to an existing page (no-op when the page-side
 *  guard is already set). Used by callers that opened pages BEFORE the
 *  attach engaged (rare). Public for tests; production callers go through
 *  `attachDeviceEmulation` which handles existing pages too. */
export async function reinjectDeviceEmuOnPage(page: Page): Promise<void> {
  await page.evaluate(DEVICE_EMU_PAGE_SCRIPT).catch(() => undefined);
}
