// Per-session dialog policy — barrel. Sibling of `permission_policy` /
// `notification_policy` / `fs_picker_policy`, and split along the same two
// realms / reasons-to-change:
//   - `dialog-policy.ts` — Node-side decision state: the `DialogPolicyState`
//     class, the policy/record types, the parser and the stable agent-facing
//     hint. Names no vendor type, so `ActionResult.dialogs[]` — and the
//     ActionSubstrate port above it — can read `DialogRecord` without reaching
//     playwright-core.
//   - `dialog-attach.ts` — the server-side attach/binding adapter: the
//     `page.on('dialog')` install, the `context.on('page')` wiring, and the
//     dispatch that accepts or dismisses per policy.
// The original public surface is preserved here verbatim so importers and
// colocated tests keep importing from `./dialog.js`. (RFC 0009 P1.)

export {
  type DialogMode,
  type DialogPolicy,
  type DialogRecord,
  UNHANDLED_DIALOG_HINT,
  DialogPolicyState,
  parseDialogPolicyArg,
} from "./dialog-policy.js";

export { installDialogHandler, attachDialogPolicy } from "./dialog-attach.js";
