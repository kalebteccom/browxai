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
  const {
    z,
    register,
    gateCheck,
    entryFor,
  } = host;

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
          `Stage a synthetic ${api === "bluetooth" ? "Web Bluetooth" : api === "usb" ? "WebUSB" : "WebHID"} device catalog for this session. The page-side wrapper around \`navigator.${api}.requestDevice()\` resolves with the agent-supplied device(s) the next time the page calls it. ${hint} ` +
          `Pass \`{devices: [...]}\` to install a non-empty catalog (the next requestDevice call ${api === "hid" ? "resolves with the matching device list" : "resolves with the first matching device"}); pass \`{devices: []}\` or omit \`devices\` to clear the catalog (the next call ${api === "hid" ? "resolves with `[]` — the user-dismissed shape for HID" : "rejects with `NotFoundError` — the user-dismissed shape for the picker"}). Persists across navigation: the init-script is re-injected on every new document within the session. Captured page-side calls surface on \`device_requests({session})\`. ` +
          `**Gated behind the off-by-default \`device-emulation\` capability** — the wrappers tell the page it found physical devices that don't exist, a posture-broadening change distinct from the surrounding policies. v1 covers the picker-clear path only — ${api === "bluetooth" ? "GATT service exchange (`getPrimaryService()`) rejects" : api === "usb" ? "transfer endpoints (`transferIn`/`transferOut`) resolve with zero-byte results" : "input/output reports (`oninputreport`, `sendReport()`) are stubs"}. Same posture class as \`eval\` / \`network-body\` / \`secrets\` / \`extensions\` / \`stealth\` / \`captcha\` — see docs/threat-model.md. Returns \`{ok, session, api, catalog:{devices:[…]}, warnings?, tokensEstimate}\`.`,
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
    "The synthetic `BluetoothDevice` carries `{id, name, uuids, gatt}`; `gatt.connect()` resolves with a stub server whose `getPrimaryService()` rejects (no GATT emulation in v1) — enough for pages that gate flow on the picker-clear, not enough for pages that go on to exchange characteristic data.",
  );
  registerEmulateApi(
    "emulate_usb",
    "usb",
    "The synthetic `USBDevice` carries vendor/product/class/manufacturer/serial fields; `open()` / `selectConfiguration()` / `claimInterface()` resolve; transfer endpoints (`transferIn` / `transferOut` / `controlTransferIn` / `controlTransferOut`) resolve with zero-byte payloads (no synthetic data flow).",
  );
  registerEmulateApi(
    "emulate_hid",
    "hid",
    "The synthetic `HIDDevice` carries vendor/product/productName/collections; `open()` / `sendReport()` / `sendFeatureReport()` resolve; `receiveFeatureReport()` resolves with an empty DataView; `oninputreport` is never fired (no synthetic device traffic).",
  );
}
