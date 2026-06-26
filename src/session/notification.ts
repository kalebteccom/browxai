// Per-session notification policy. Sibling of `permission_policy`. Plugs the
// `new Notification(title, opts)` blind spot.
//
// BARREL. This module is split along the three realms / reasons-to-change of a
// session policy:
//
//   - `./notification-policy.js`      — realm (1) Node-side decision state:
//       the `NotificationPolicyState` class, policy types/parsing, and the
//       sync-decision derivation (`syncDecisionFor`).
//   - `./notification-page-script.js` — realm (2) browser-realm constant:
//       `NOTIFICATION_PAGE_SCRIPT`, the init-script that wraps the page-side
//       `Notification` constructor. Browser-only JS; its exact text is the
//       serialization contract.
//   - `./notification-attach.js`      — realm (3) server-side attach/binding
//       adapter: `attachNotificationPolicy` (Playwright exposeBinding +
//       addInitScript wiring) and `propagateSyncDecision`.
//
// The original public surface is preserved here verbatim so importers and
// colocated tests keep importing from `./notification.js`. The two policies
// (this + `permission_policy`) compose; coordination is by-construction:
// `permission_policy` only touches `Notification.requestPermission`, this
// module only touches `new Notification(...)`. See the split files for the
// full WHY commentary.

export {
  type NotificationPolicyMode,
  type NotificationPolicy,
  type NotificationRecord,
  type NotificationAskHandler,
  UNHANDLED_NOTIFICATION_HINT,
  NotificationPolicyState,
  parseNotificationPolicyArg,
  syncDecisionFor,
  readNotifications,
} from "./notification-policy.js";

export { NOTIFICATION_PAGE_SCRIPT } from "./notification-page-script.js";

export { attachNotificationPolicy, propagateSyncDecision } from "./notification-attach.js";
