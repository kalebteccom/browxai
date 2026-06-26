// Per-session File System Access API policy — barrel. Sibling of
// `dialog_policy` / `permission_policy`. Plugs the FS-picker blind spot:
// modern web editors (VSCode for the web, Figma, anything calling
// `showOpenFilePicker` / `showSaveFilePicker` / `showDirectoryPicker`)
// deadlock under a headless session — the picker dialog blocks every
// subsequent browser event until the human clicks a real OS file chooser
// that doesn't exist in headless, and even on attached Chrome the human
// can't see the picker through the agent's session.
//
// This module fuses three realms / reasons-to-change, now split into three
// flat siblings and re-exported here so the public surface (and every
// importer + colocated test) is unchanged:
//   - `fs-picker-policy`      — Node-side policy state (`FsPickerPolicyState`,
//                               the policy/file/record types, the parse +
//                               workspace-path validators, the ask-human
//                               handler type).
//   - `fs-picker-page-script` — the browser-realm `FS_PICKER_PAGE_SCRIPT`
//                               init-script constant (browser-only JS;
//                               byte-identical serialization contract).
//   - `fs-picker-attach`      — the server-side attach/binding adapter
//                               (`attachFsPickerPolicy` + the Playwright
//                               exposeBinding / addInitScript wiring).

export type {
  FsPickerMode,
  FsPickerApi,
  FsPickerPolicy,
  FsPickerFile,
  FsPickerRecord,
  FsPickerAskHandler,
} from "./fs-picker-policy.js";
export {
  SUPPORTED_FS_PICKER_APIS,
  UNHANDLED_FS_PICKER_HINT,
  FsPickerPolicyState,
  parseFsPickerPolicyArg,
  resolveWorkspaceFsPath,
} from "./fs-picker-policy.js";

export { FS_PICKER_PAGE_SCRIPT } from "./fs-picker-page-script.js";

export { attachFsPickerPolicy } from "./fs-picker-attach.js";
