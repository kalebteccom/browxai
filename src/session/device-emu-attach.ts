// Server-side attach/binding adapter for Web Bluetooth / WebUSB / WebHID
// device emulation (realm 3 of 3 — see `device-emu.ts` for the module
// overview). This is the Playwright/CDP wiring half: it installs the
// `__browx_device_check` exposeBinding (page-side `requestDevice` calls route
// here, consult the catalog on `DeviceEmulationState`, get recorded, and
// return a `{decision, devices}` envelope) and injects the browser-realm page
// script (`device-emu-page-script.ts`) on every new document. The Node-side
// policy state lives in `device-emu-state.ts`. Both are leaf modules this
// file imports directly — never via the `device-emu.ts` barrel — so no cycle.

import type { BrowserContext, Page } from "playwright-core";
import { log } from "../util/logging.js";
import {
  SUPPORTED_DEVICE_APIS,
  type DeviceApi,
  type DeviceEmulationState,
  type DeviceRequestRecord,
} from "./device-emu-state.js";
import { DEVICE_EMU_PAGE_SCRIPT } from "./device-emu-page-script.js";

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
