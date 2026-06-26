// Browser-realm page script for Web Bluetooth / WebUSB / WebHID device
// emulation (realm 2 of 3 — see `device-emu.ts` for the module overview).
// This is the *_PAGE_SCRIPT constant: browser-only JS injected into every
// document by the attach adapter (`device-emu-attach.ts`). It runs in the
// page, not in Node — the serialization contract depends on its exact text,
// so it stays a single named exported constant and is never inlined or
// transformed. The Node-side policy state lives in `device-emu-state.ts`.
// This file is a leaf (no sibling imports) so the barrel re-exports it
// without a cycle.

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
