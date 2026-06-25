// Per-session permission policy — barrel. Sibling of `dialog_policy`. Plugs the
// runtime-permission blind spot: camera / microphone / geolocation / clipboard /
// notification (and the long tail of sensor permissions) requests fire from the
// page asynchronously; without a server-side interceptor the request either
// silently sits forever or — worse — pre-grants change app behavior silently.
//
// This module fuses three realms / reasons-to-change; each now lives in its own
// sibling file and is re-exported here so every original import path keeps
// working:
//   - `permission-policy.ts`      — Node-side policy state (the
//     `PermissionPolicyState` class, the policy/record types, the validators,
//     and the pure CDP-name mappings `cdpPermissionName` / `cdpSettingFor`).
//   - `permission-page-script.ts` — the browser-realm page-script constant
//     `PERMISSION_PAGE_SCRIPT` (browser-only JS run in the page; exact text is
//     the serialization contract).
//   - `permission-attach.ts`      — the server-side attach/binding adapter
//     (Playwright/CDP wiring: `attachPermissionPolicy`, `applyCdpBaseline`,
//     `readPermissionStates`).

export {
  type PolicyMode,
  SUPPORTED_PERMISSIONS,
  type SupportedPermission,
  type PermissionPolicy,
  type PermissionRecord,
  UNHANDLED_PERMISSION_HINT,
  BYOB_PERMISSION_WARNING,
  PermissionPolicyState,
  parsePermissionPolicyArg,
  cdpPermissionName,
  cdpSettingFor,
  type PermissionAskHandler,
} from "./permission-policy.js";

export { PERMISSION_PAGE_SCRIPT } from "./permission-page-script.js";

export {
  attachPermissionPolicy,
  applyCdpBaseline,
  readPermissionStates,
} from "./permission-attach.js";
