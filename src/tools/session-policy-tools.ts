import type { ToolHost } from "./host.js";
import { registerSessionLifecycleTools } from "./session-lifecycle-tools.js";
import { registerSessionDialogPermissionTools } from "./session-dialog-permission-tools.js";
import { registerSessionNotificationDeviceTools } from "./session-notification-device-tools.js";

/**
 * Session lifecycle + per-session policy tools — open / close / list sessions and
 * the runtime policy mutators a session is driven with: dialog, permission,
 * file-system-picker, and notification policies, plus the permission-state read
 * and the device-request read companion.
 *
 * RFC 0004 P3 / D3 (SRP): the registrations were split by cohesive family into
 * three sibling modules (lifecycle / dialog-permission-fs-picker /
 * notification-device). This module stays the single entry point `server.ts` +
 * `tool-metadata.ts` call, and invokes each family in the EXACT prior source order
 * so the registered-name set + the derived maps stay byte-identical. The host owns
 * the closures (register / gate / entry / registry / workspace); the family
 * modules own the registrations.
 */
export function registerSessionPolicyTools(host: ToolHost): void {
  registerSessionLifecycleTools(host);
  registerSessionDialogPermissionTools(host);
  registerSessionNotificationDeviceTools(host);
}
