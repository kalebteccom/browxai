// Node-side policy state for Web Bluetooth / WebUSB / WebHID device emulation
// (realm 1 of 3 — see `device-emu.ts` for the module overview). Holds the
// per-session decision state: the per-API synthetic-device catalog the tools
// mutate, the bounded request-record ring `device_requests` reads, and the
// capability gate the check binding consults. The browser-realm page script
// lives in `device-emu-page-script.ts`; the Playwright/CDP attach adapter in
// `device-emu-attach.ts`. This file is a leaf — it imports neither sibling, so
// the barrel can re-export all three without a cycle.

import type { BrowserContext } from "playwright-core";
import { PolicyRecordBuffer } from "./policy-buffer.js";

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
  /** Captured `requestDevice` calls — a bounded record ring (shared
   *  `PolicyRecordBuffer`; chatty pages can't grow this without bound,
   *  `device_requests` slices on `since`). */
  private readonly records: PolicyRecordBuffer<DeviceRequestRecord>;
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
    this.records = new PolicyRecordBuffer<DeviceRequestRecord>(cap);
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
    this.records.record(rec);
  }

  /** Slice records with `ts >= since`. Default since=0 returns all. */
  since(since: number = 0): DeviceRequestRecord[] {
    return this.records.since(since);
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
