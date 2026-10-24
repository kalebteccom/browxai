import { BYOB_DEVICE_EMU_WARNING, type DeviceApi } from "../session/device-emu.js";
import { estimateTokens } from "../util/tokens.js";
import type { ToolHost } from "./host.js";
import { SESSION_ARG } from "./schemas.js";

/**
 * Synthetic device emulation — the off-by-default `device-emulation` surface.
 * Web Bluetooth / WebUSB / WebHID catalog staging (`emulate_bluetooth` /
 * `emulate_usb` / `emulate_hid`): the page-side wrapper around
 * `navigator.<api>.requestDevice()` resolves with agent-supplied devices.
 * Registered through the shared `ToolHost` seam.
 */
export function registerDeviceEmulationTools(host: ToolHost): void {
  const { z, register, gateCheck, entryFor } = host;

  // ---------- Web Bluetooth / WebUSB / WebHID device emulation
  // (capability `device-emulation`) ----------
  //
  // Three sibling mutators (`emulate_bluetooth` / `emulate_usb` / `emulate_hid`)
  // plus a read-side companion (`device_requests`). All four gate behind the
  // off-by-default `device-emulation` capability — same posture class as
  // `eval` / `network-body` / `secrets` / `extensions` / `stealth` / `captcha`.
  // The page-side init-script wrappers install eagerly at session creation
  // (so a page that calls `requestDevice()` on initial document parse never
  // hangs); the check binding short-circuits to `refused` when the capability
  // is off, so a server without `device-emulation` still surfaces "page
  // asked but capability was off" on `device_requests`.
  //
  // Shared input schema — the SyntheticDevice union (every field optional;
  // wrappers default missing fields to deterministic placeholders so the
  // page sees a complete shape). A single shape covers all three APIs;
  // each wrapper picks the fields its spec exposes.
  const SYNTHETIC_DEVICE_SCHEMA = z.object({
    name: z
      .string()
      .optional()
      .describe(
        'Display name. Bluetooth: `.name`; USB: `.productName`; HID: `.productName`. Default `"browxai-virtual"`.',
      ),
    id: z
      .string()
      .optional()
      .describe(
        'Bluetooth: stable device id (UUID-style string). Default `"browxai-<api>-<index>"`.',
      ),
    vendorId: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("USB / HID: 16-bit USB-IF vendor id. Default `0x0000`."),
    productId: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("USB / HID: 16-bit product id. Default `0x0000`."),
    manufacturerName: z
      .string()
      .optional()
      .describe('USB: human-readable manufacturer string. Default `"browxai virtual"`.'),
    serialNumber: z
      .string()
      .optional()
      .describe('USB: serial number string. Default `"BROWX-VIRTUAL"`.'),
    deviceClass: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("USB: 8-bit device class. Default `0xFF` (vendor-specific)."),
    deviceSubclass: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("USB: 8-bit device subclass. Default `0x00`."),
    deviceProtocol: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("USB: 8-bit device protocol. Default `0x00`."),
    services: z
      .array(z.string())
      .optional()
      .describe(
        "Bluetooth: GATT primary service UUIDs the device advertises. Surfaced on the synthetic device as `device.uuids`. v1 does NOT emulate GATT service exchange — `gatt.getPrimaryService()` rejects.",
      ),
    collections: z
      .array(z.unknown())
      .optional()
      .describe(
        "HID: report-descriptor collection topology exposed on `device.collections`. Pass-through — the page sees whatever shape you supplied.",
      ),
  });

  const registerEmulateApi = (toolName: string, api: DeviceApi, hint: string): void => {
    register(
      toolName,
      {
        // emulate_bluetooth / emulate_usb / emulate_hid — all device-emulation.
        capability: "device-emulation",
        description:
          `Stage a synthetic ${api === "bluetooth" ? "Web Bluetooth" : api === "usb" ? "WebUSB" : "WebHID"} device catalog for this session, so the page's \`navigator.${api}.requestDevice()\` resolves with the devices you supply. Requires the \`device-emulation\` capability (off by default): the page is told that physical devices exist that do not. ${hint} ` +
          `\`{devices: [...]}\` installs a catalog (the next requestDevice call ${api === "hid" ? "resolves with the matching device list" : "resolves with the first matching device"}); \`{devices: []}\` or omitting \`devices\` clears it (the next call ${api === "hid" ? "resolves with `[]`, the dismissed-picker shape for HID" : "rejects with `NotFoundError`, the dismissed-picker shape"}). Persists across navigation. Read what the page asked for with \`device_requests\`. Returns \`{ok, session, api, catalog:{devices:[…]}, warnings?, tokensEstimate}\`.`,
        inputSchema: {
          devices: z
            .array(SYNTHETIC_DEVICE_SCHEMA)
            .optional()
            .describe(
              `Synthetic devices to expose. Omit or pass \`[]\` to clear the catalog. ${api === "hid" ? "All entries are returned to the page on every requestDevice() call." : "Only the first entry is returned to the page on requestDevice() (Bluetooth/USB pickers are single-result)."}`,
            ),
          ...SESSION_ARG,
        },
      },
      async (args) => {
        const g = gateCheck(toolName);
        if (g) return g;
        const e = await entryFor(args.session);
        try {
          const devices = args.devices ?? [];
          const catalog = e.webDeviceEmulation.set(api, devices);
          const warnings: string[] = [];
          if (e.mode === "attached") warnings.push(BYOB_DEVICE_EMU_WARNING);
          const body: Record<string, unknown> = {
            ok: true,
            session: e.id,
            api,
            catalog,
          };
          if (warnings.length) body.warnings = warnings;
          body.tokensEstimate = estimateTokens(JSON.stringify(body));
          return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { ok: false, error: err instanceof Error ? err.message : String(err) },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      },
    );
  };

  registerEmulateApi(
    "emulate_bluetooth",
    "bluetooth",
    "The synthetic `BluetoothDevice` has `{id, name, uuids, gatt}`; `gatt.connect()` resolves with a stub server whose `getPrimaryService()` rejects, so pages that only need the picker to resolve work and pages that read characteristics do not.",
  );
  registerEmulateApi(
    "emulate_usb",
    "usb",
    "The synthetic `USBDevice` has vendor, product, class, manufacturer and serial fields; `open()`, `selectConfiguration()` and `claimInterface()` resolve; transfers (`transferIn`, `transferOut`, `controlTransferIn`, `controlTransferOut`) resolve with zero-byte payloads, so no data flows.",
  );
  registerEmulateApi(
    "emulate_hid",
    "hid",
    "The synthetic `HIDDevice` has vendor, product, productName and collections; `open()`, `sendReport()` and `sendFeatureReport()` resolve; `receiveFeatureReport()` resolves with an empty DataView; `oninputreport` never fires.",
  );
}
