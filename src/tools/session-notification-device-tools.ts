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
import type { RegisterHost, GateHost, SessionHost, ServerServicesHost } from "./host.js";

/**
 * Permission-state read + notification policy + device-request read tools:
 * permission_state / set_notification_policy / device_requests. Split out of
 * `session-policy-tools` by cohesive family (RFC 0004 P3 / D3 SRP); registered
 * through the shared `ToolHost` seam in the same source order. The host owns the
 * closures (register / gate / entry).
 */
export function registerSessionNotificationDeviceTools(
  host: RegisterHost & GateHost & SessionHost & ServerServicesHost,
): void {
  const { z, register, gateCheck, entryFor } = host;

  register(
    "permission_state",
    {
      capability: "read",
      description:
        'Read the current permission state(s) for an origin via the W3C Permissions API (`navigator.permissions.query` — which reflects the CDP-applied baseline). Returns `{ [permission]: "granted" | "denied" | "prompt" | "unknown" }` per requested name. Defaults the `origin` to the current page\'s origin when omitted. Read-only — does not mutate state. Supported permission names (v1): ' +
        SUPPORTED_PERMISSIONS.join(", ") +
        ". Sibling of `set_permission_policy`.",
      inputSchema: {
        permissions: z
          .array(z.string())
          .min(1)
          .describe(
            'Canonical permission names to query — see tool description for the supported set. Unknown names map to `"unknown"` in the result.',
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
          e.session.page().context(),
          e.session.page(),
          supported,
          origin,
        );
        const out: Record<string, string> = { ...states };
        for (const p of permissions) {
          if (!(p in out)) out[p] = "unknown";
        }
        const body = {
          ok: true,
          session: e.id,
          origin:
            origin ??
            (() => {
              try {
                return new URL(e.session.page().url()).origin;
              } catch {
                return null;
              }
            })(),
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
        "Mutate the session's notification policy at runtime. Governs `new Notification(title, opts)` *constructor* calls — the page actually attempting to display a notification. Distinct from `set_permission_policy` (which gates `Notification.requestPermission` and the `Notification.permission` state); the two policies compose. Modes:\n" +
        '  - "allow"     — DEFAULT (browser default). Constructor proceeds; the OS displays per its own settings. Every call is still captured on `ActionResult.notifications[]` for observability.\n' +
        '  - "deny"      — Constructor throws `NotAllowedError` (the same exception the browser raises when permission is denied). Use to suppress OS notifications while still observing what the page would have shown.\n' +
        '  - "raise"     — Constructor throws AND RECORDS; the next ActionResult flips `ok:false` with `failure:{source:"app", hint:"unhandled notification — set notificationPolicy"}`. Useful when notifications should be a hard signal that the action triggered an unexpected user-facing event.\n' +
        '  - "ask-human" — server blocks on `__browx.confirm(true|false)` (the `await_human({kind:"confirm"})` mechanism), then resolves to allow/deny per the human\'s answer. The constructor returns a stub synchronously (the spec requires a sync return); the real OS notification fires once the human-decision resolves.\n' +
        "Persists across navigation: the init-script is re-injected on every new document within the session. Returns the resolved policy. Captured calls surface on `ActionResult.notifications[] = [{title, body?, icon?, tag?, timestamp, origin?, handledAs}]`.",
      inputSchema: {
        mode: z
          .enum(["allow", "deny", "raise", "ask-human"])
          .describe("Policy mode — see tool description."),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("set_notification_policy");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const next: NotificationPolicy = { mode: args.mode };
        const resolved = e.notification.set(next);
        // Push the new sync-decision hint to every live page so the
        // constructor's throw timing tracks the policy without a reload.
        await propagateNotificationSyncDecision(e.session.page().context(), e.notification).catch(
          () => undefined,
        );
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
        'Read-side companion to `emulate_bluetooth` / `emulate_usb` / `emulate_hid`. Returns the buffer of `requestDevice()` calls the page has made on this session — one entry per page-side call, each with `{api, handledAs, returned, filters?, ts}`. Useful for diagnosing "did the page even ask?" when a flow gated on hardware appears stuck. `handledAs`:\n' +
        '  - `"resolved"`  — catalog non-empty; picker resolved with the synthetic device (Bluetooth/USB) or device list (HID).\n' +
        '  - `"rejected"` — catalog empty for Bluetooth/USB; picker rejected with `NotFoundError` (user-dismissed shape).\n' +
        '  - `"empty"`    — catalog empty for HID; picker resolved with `[]` (HID\'s user-dismissed shape).\n' +
        '  - `"refused"`  — capability `device-emulation` was OFF at the time of the call; the wrapper short-circuited. Recorded so the read surfaces "the page asked for hardware and you didn\'t have the capability on".\n' +
        "**Gated behind the off-by-default `device-emulation` capability** — a server without the capability can't even read whether the page tried to ask (same posture class as `eval` / `network-body` / `secrets`). Read-only — does not mutate state.",
      inputSchema: {
        since: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "epoch ms — return only records with `ts >= since`. Default 0 (return everything in the buffer).",
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
