import { estimateTokens } from "../util/tokens.js";
import {
  readPermissionStates,
  SUPPORTED_PERMISSIONS,
  type SupportedPermission,
} from "../session/permission.js";
import {
  propagateSyncDecision as propagateNotificationSyncDecision,
  type NotificationPolicy,
} from "../session/notification.js";
import { SUPPORTED_DEVICE_APIS } from "../session/device-emu.js";
import { SESSION_ARG } from "./schemas.js";
import { askHumanPolicyGate } from "./ask-human-gate.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ServerServicesHost,
  TargetHost,
} from "./host.js";
import { requirePage } from "../engine/index.js";

/**
 * Permission-state read + notification policy + device-request read tools:
 * permission_state / set_notification_policy / device_requests. Split out of
 * `session-policy-tools` by cohesive family (RFC 0004 P3 / D3 SRP); registered
 * through the shared `ToolHost` seam in the same source order. The host owns the
 * closures (register / gate / entry).
 */
export function registerSessionNotificationDeviceTools(
  host: RegisterHost & GateHost & SessionHost & ServerServicesHost & TargetHost,
): void {
  const { z, register, gateCheck, entryFor, targetFor } = host;

  register(
    "permission_state",
    {
      capability: "read",
      description:
        'Read the permission state for an origin through the Permissions API (`navigator.permissions.query`, which reflects the CDP baseline). Returns `{ [permission]: "granted"|"denied"|"prompt"|"unknown" }`. `origin` defaults to the current page\'s origin. Does not change state; use `set_permission_policy` or `grant_permissions` for that. Names: camera, microphone, geolocation, notifications, clipboard-read, clipboard-write, midi, midi-sysex, payment-handler, background-sync, accelerometer, gyroscope, magnetometer.',
      inputSchema: {
        permissions: z
          .array(z.string())
          .min(1)
          .describe(
            'Permission names to query (camera, microphone, geolocation, notifications, clipboard-read, clipboard-write, midi, midi-sysex, payment-handler, background-sync, accelerometer, gyroscope, magnetometer). Unknown names return `"unknown"`.',
          ),
        origin: z
          .string()
          .optional()
          .describe(
            'Origin to query (e.g. "https://example.com"). Omit to use the current page\'s origin.',
          ),
        ...SESSION_ARG,
      },
    },
    async ({ permissions, origin, session }) => {
      const g = gateCheck("permission_state");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const supported = permissions.filter((p): p is SupportedPermission =>
          (SUPPORTED_PERMISSIONS as readonly string[]).includes(p),
        );
        const states = await readPermissionStates(
          requirePage(e.session).context(),
          requirePage(e.session),
          supported,
          origin,
        );
        const out: Record<string, string> = { ...states };
        for (const p of permissions) {
          if (!(p in out)) out[p] = "unknown";
        }
        // The current target's origin, read through the target port so the
        // fallback works on any engine. A target with no parseable URL (or none
        // at all) reports null, as it did before the port existed.
        const targetOrigin =
          origin ??
          (await targetFor(e)
            .url()
            .then((u) => new URL(u).origin)
            .catch(() => null));
        const body = {
          ok: true,
          session: e.id,
          origin: targetOrigin,
          states: out,
          tokensEstimate: estimateTokens(JSON.stringify(out)),
        };
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

  register(
    "set_notification_policy",
    {
      capability: "action",
      description:
        'Change at runtime how the session handles `new Notification(title, opts)` constructor calls, meaning the page actually showing a notification. Use `set_permission_policy` for `Notification.requestPermission` and the permission state; the two compose. Persists across navigation and returns the resolved policy. Modes:\n  - "allow" (default): the constructor proceeds and the OS shows it. Every call is still recorded on `ActionResult.notifications[]`.\n  - "deny": the constructor throws `NotAllowedError`, to suppress OS notifications while still seeing what the page tried to show.\n  - "raise": throw and record; the next ActionResult is `ok:false` with `failure:{source:"app"}` and a hint to set notificationPolicy.\n  - "ask-human": the server waits for a human allow or deny from the DevTools `browxai-…` console context (see `await_human`; page scripts cannot answer). The constructor returns a stub at once and the real notification fires after the answer.\nLeaving `ask-human` is refused with `requiredCapability:"human-gate-override"` unless the operator enabled that capability (off by default); changes that keep it are accepted. Recorded calls look like `{title, body?, icon?, tag?, timestamp, origin?, handledAs}`.',
      inputSchema: {
        mode: z
          .enum(["allow", "deny", "raise", "ask-human"])
          .describe('Policy mode: "allow" (default), "deny", "raise" or "ask-human".'),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("set_notification_policy");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const next: NotificationPolicy = { mode: args.mode };
        const refused = askHumanPolicyGate(
          gateCheck,
          "set_notification_policy",
          { mode: e.notification.current().mode },
          { mode: next.mode },
          ["notifications"],
        );
        if (refused) return refused;
        const resolved = e.notification.set(next);
        // Push the new sync-decision hint to every live page so the
        // constructor's throw timing tracks the policy without a reload.
        await propagateNotificationSyncDecision(
          requirePage(e.session).context(),
          e.notification,
        ).catch(() => undefined);
        const tokensEstimate = estimateTokens(JSON.stringify(resolved));
        const body = { ok: true, session: e.id, policy: resolved, tokensEstimate };
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

  register(
    "device_requests",
    {
      capability: "device-emulation",
      description:
        'Read what the page asked for: the buffer of `requestDevice()` calls it made on this session (Bluetooth, USB, HID), each `{api, handledAs, returned, filters?, ts}`. Use it to check whether the page asked at all when a hardware-gated flow looks stuck. Requires the `device-emulation` capability (off by default); without it you cannot read whether the page asked. `handledAs`:\n  - `"resolved"`: catalog non-empty; the picker resolved with the synthetic device (Bluetooth, USB) or device list (HID).\n  - `"rejected"`: catalog empty for Bluetooth or USB; rejected with `NotFoundError`.\n  - `"empty"`: catalog empty for HID; resolved with `[]`.\n  - `"refused"`: `device-emulation` was off at the time of the call, so the wrapper stepped aside; recorded so you can see the page asked for hardware.\nUse `emulate_bluetooth`, `emulate_usb` or `emulate_hid` to stage devices.',
      inputSchema: {
        since: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Epoch ms: return only records with `ts >= since`. Default 0 (everything in the buffer).",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ since, session }) => {
      const g = gateCheck("device_requests");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const records = e.webDeviceEmulation.since(typeof since === "number" ? since : 0);
        const body: Record<string, unknown> = {
          ok: true,
          session: e.id,
          supportedApis: [...SUPPORTED_DEVICE_APIS],
          requests: records,
        };
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
}
