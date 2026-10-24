// Unit tests for the Web Bluetooth / WebUSB / WebHID device-emulation
// module. Covers:
//   - DeviceEmulationState bookkeeping (catalogs, defaults)
//   - normaliseDevice defaults (the page sees a complete shape even from
//     sparsely-populated agent input)
//   - attachDeviceEmulation idempotence + binding semantics (the binding
//     records the call, respects the capability gate, and returns the
//     correct decision shape per API)

import { describe, it, expect, vi } from "vitest";
import {
  DeviceEmulationState,
  attachDeviceEmulation,
  reinjectDeviceEmuOnPage,
} from "./device-emu.js";
import type { BrowserContext, Page } from "playwright-core";

// ---- fakes ----------------------------------------------------------------

function fakePage(): Page {
  return {
    url: () => "https://example.com/x",
    evaluate: vi.fn(async () => undefined),
  } as unknown as Page;
}

function fakeContext(
  opts: {
    bindings?: Map<string, (source: unknown, payload: string) => unknown>;
    initScripts?: string[];
    pages?: Page[];
  } = {},
): BrowserContext {
  const bindings = opts.bindings ?? new Map();
  const initScripts = opts.initScripts ?? [];
  const pages = opts.pages ?? [fakePage()];
  return {
    exposeBinding: async (name: string, fn: (source: unknown, payload: string) => unknown) => {
      bindings.set(name, fn);
    },
    addInitScript: async (script: { content: string }) => {
      initScripts.push(script.content);
    },
    pages: () => pages,
  } as unknown as BrowserContext;
}

// ---- DeviceEmulationState basics -----------------------------------------

describe("DeviceEmulationState", () => {
  it("set() replaces the catalog for the requested API only", () => {
    const s = new DeviceEmulationState(true);
    s.set("bluetooth", [{ name: "heart-rate" }]);
    expect(s.catalog("bluetooth").devices).toHaveLength(1);
    expect(s.catalog("usb").devices).toEqual([]);
    expect(s.catalog("hid").devices).toEqual([]);
  });

  it("set() defaults missing fields so the page sees a complete shape", () => {
    const s = new DeviceEmulationState(true);
    const cat = s.set("usb", [{}]);
    const d = cat.devices[0]!;
    // All W3C-shape fields present with safe defaults.
    expect(d.name).toBe("browxai-virtual");
    expect(d.id).toBe("browxai-usb-0");
    expect(d.vendorId).toBe(0x0000);
    expect(d.productId).toBe(0x0000);
    expect(d.manufacturerName).toBe("browxai virtual");
    expect(d.serialNumber).toBe("BROWX-VIRTUAL");
    expect(d.deviceClass).toBe(0xff);
    expect(d.services).toEqual([]);
    expect(d.collections).toEqual([]);
  });

  it("set() rejects non-array devices", () => {
    const s = new DeviceEmulationState(true);

    expect(() => s.set("bluetooth", "not-an-array" as any)).toThrow(/must be an array/);
  });
});

// ---- attachDeviceEmulation -----------------------------------------------

describe("attachDeviceEmulation", () => {
  it("is idempotent — second attach on the same context is a no-op", async () => {
    const s = new DeviceEmulationState(true);
    const bindings = new Map<string, (source: unknown, payload: string) => unknown>();
    const initScripts: string[] = [];
    const c = fakeContext({ bindings, initScripts });
    await attachDeviceEmulation(c, s);
    await attachDeviceEmulation(c, s);
    // Second attach short-circuits via the WeakSet — only one binding +
    // one init script registered.
    expect(initScripts).toHaveLength(1);
  });

  it("binding records the call + returns `resolved` shape when catalog non-empty (bluetooth)", async () => {
    const s = new DeviceEmulationState(true);
    const bindings = new Map<string, (source: unknown, payload: string) => unknown>();
    const c = fakeContext({ bindings });
    s.set("bluetooth", [{ name: "x" }]);
    await attachDeviceEmulation(c, s);
    const handler = bindings.get("__browx_device_check")!;
    const raw = await handler(
      null,
      JSON.stringify({ api: "bluetooth", filters: { acceptAllDevices: true } }),
    );
    const r = JSON.parse(raw as string) as { decision: string; devices: Array<{ name: string }> };
    expect(r.decision).toBe("resolved");
    expect(r.devices).toHaveLength(1);
    expect(r.devices[0]!.name).toBe("x");
    const records = s.since(0);
    expect(records).toHaveLength(1);
    expect(records[0]!.handledAs).toBe("resolved");
    expect(records[0]!.returned).toBe(1);
    expect(records[0]!.filters).toEqual({ acceptAllDevices: true });
  });

  it("binding returns `rejected` shape when catalog empty + API is bluetooth/usb", async () => {
    const s = new DeviceEmulationState(true);
    const bindings = new Map<string, (source: unknown, payload: string) => unknown>();
    const c = fakeContext({ bindings });
    await attachDeviceEmulation(c, s);
    const handler = bindings.get("__browx_device_check")!;
    for (const api of ["bluetooth", "usb"] as const) {
      const raw = await handler(null, JSON.stringify({ api, filters: null }));
      const r = JSON.parse(raw as string) as { decision: string; devices: unknown[] };
      expect(r.decision).toBe("rejected");
      expect(r.devices).toEqual([]);
    }
    const records = s.since(0);
    expect(records.map((r) => r.handledAs)).toEqual(["rejected", "rejected"]);
  });

  it("binding returns `empty` shape when catalog empty + API is hid", async () => {
    const s = new DeviceEmulationState(true);
    const bindings = new Map<string, (source: unknown, payload: string) => unknown>();
    const c = fakeContext({ bindings });
    await attachDeviceEmulation(c, s);
    const handler = bindings.get("__browx_device_check")!;
    const raw = await handler(null, JSON.stringify({ api: "hid", filters: null }));
    const r = JSON.parse(raw as string) as { decision: string; devices: unknown[] };
    expect(r.decision).toBe("empty");
    expect(r.devices).toEqual([]);
    expect(s.since(0)[0]!.handledAs).toBe("empty");
  });

  it("binding short-circuits to `refused` when capability is off", async () => {
    const s = new DeviceEmulationState(false);
    s.set("bluetooth", [{ name: "x" }]); // even staged devices don't leak
    const bindings = new Map<string, (source: unknown, payload: string) => unknown>();
    const c = fakeContext({ bindings });
    await attachDeviceEmulation(c, s);
    const handler = bindings.get("__browx_device_check")!;
    const raw = await handler(null, JSON.stringify({ api: "bluetooth", filters: null }));
    const r = JSON.parse(raw as string) as { decision: string; devices: unknown[] };
    expect(r.decision).toBe("refused");
    expect(r.devices).toEqual([]);
    // The call IS still recorded — the read-side surfaces "page asked but
    // capability was off".
    const records = s.since(0);
    expect(records).toHaveLength(1);
    expect(records[0]!.handledAs).toBe("refused");
    expect(records[0]!.returned).toBe(0);
  });

  it("binding returns `refused` for unknown api names", async () => {
    const s = new DeviceEmulationState(true);
    const bindings = new Map<string, (source: unknown, payload: string) => unknown>();
    const c = fakeContext({ bindings });
    await attachDeviceEmulation(c, s);
    const handler = bindings.get("__browx_device_check")!;
    const raw = await handler(null, JSON.stringify({ api: "midi", filters: null }));
    const r = JSON.parse(raw as string) as { decision: string };
    expect(r.decision).toBe("refused");
    // Unknown APIs aren't recorded — the buffer is for *governed* APIs only.
    expect(s.since(0)).toHaveLength(0);
  });

  it("binding swallows handler errors + returns the refused shape", async () => {
    const s = new DeviceEmulationState(true);
    const bindings = new Map<string, (source: unknown, payload: string) => unknown>();
    const c = fakeContext({ bindings });
    await attachDeviceEmulation(c, s);
    const handler = bindings.get("__browx_device_check")!;
    const raw = await handler(null, "not-json");
    const r = JSON.parse(raw as string) as { decision: string; devices: unknown[] };
    expect(r.decision).toBe("refused");
    expect(r.devices).toEqual([]);
  });

  it("hid returns the entire catalog (multi-device); bluetooth/usb only the first", async () => {
    const s = new DeviceEmulationState(true);
    const bindings = new Map<string, (source: unknown, payload: string) => unknown>();
    const c = fakeContext({ bindings });
    s.set("hid", [{ name: "one" }, { name: "two" }, { name: "three" }]);
    s.set("usb", [{ name: "one" }, { name: "two" }]);
    await attachDeviceEmulation(c, s);
    const handler = bindings.get("__browx_device_check")!;
    const hidRaw = await handler(null, JSON.stringify({ api: "hid", filters: null }));
    const hid = JSON.parse(hidRaw as string) as { devices: unknown[] };
    expect(hid.devices).toHaveLength(3);
    const usbRaw = await handler(null, JSON.stringify({ api: "usb", filters: null }));
    const usb = JSON.parse(usbRaw as string) as { devices: unknown[] };
    expect(usb.devices).toHaveLength(1);
  });

  it("reinjectDeviceEmuOnPage calls page.evaluate", async () => {
    const page = fakePage();
    await reinjectDeviceEmuOnPage(page);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });
});
