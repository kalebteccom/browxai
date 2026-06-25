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
//
// ---------------------------------------------------------------------------
// This module fuses three realms / reasons-to-change, split into sibling
// files; this file is the BARREL that re-exports the public surface so every
// importer (and the colocated test) keeps importing from `./device-emu.js`:
//   - `device-emu-state.ts`        — Node-side policy state: the
//                                    `DeviceEmulationState` class + catalog /
//                                    record / capability types + the BYOB
//                                    warning constant.
//   - `device-emu-page-script.ts`  — the browser-realm `DEVICE_EMU_PAGE_SCRIPT`
//                                    constant (browser-only JS; exact text is
//                                    the serialization contract).
//   - `device-emu-attach.ts`       — the server-side Playwright/CDP attach
//                                    adapter (`__browx_device_check` binding +
//                                    init-script injection).
// ---------------------------------------------------------------------------

export {
  SUPPORTED_DEVICE_APIS,
  DeviceEmulationState,
  BYOB_DEVICE_EMU_WARNING,
} from "./device-emu-state.js";
export type {
  DeviceApi,
  SyntheticDevice,
  DeviceCatalog,
  DeviceRequestRecord,
} from "./device-emu-state.js";

export { DEVICE_EMU_PAGE_SCRIPT } from "./device-emu-page-script.js";

export { attachDeviceEmulation, reinjectDeviceEmuOnPage } from "./device-emu-attach.js";
