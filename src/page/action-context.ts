// `ActionContext` — the per-action Playwright execution context the action
// primitives run against. The engine handle (`page`), the optional raw CDP
// escape hatch, the substrates, the ref registry, the console ring and the four
// policy states, in one bag.
//
// Split out of `actionresult-types.ts` because that module declares
// `ActionResult` + `ActionWindowOptions`, which the ActionSubstrate port names
// in every method signature, while THIS type names `Page` and `CDPSession`. A
// port module that reaches playwright-core — even transitively, even type-only
// — is not a port (the `ports-name-no-vendor-type` rule). The result vocabulary
// is engine-blind and stays above the seam; the execution context is Playwright
// adapter shape and stays below it, with `action-substrate-playwright.ts`. Both
// are re-exported through `./actionresult.js` so existing importers are
// unchanged. (RFC 0009 P1.)

import type { CDPSession, Page } from "playwright-core";
import type { SnapshotSubstrate } from "./snapshot-substrate.js";
import type { NetworkSubstrate } from "./network-substrate.js";
import type { RefRegistry } from "./refs.js";
import type { ConsoleBuffer } from "./console.js";
import type { DialogPolicyState } from "../session/dialog-policy.js";
import type { PermissionPolicyState } from "../session/permission-policy.js";
import type { NotificationPolicyState } from "../session/notification-policy.js";
import type { FsPickerPolicyState } from "../session/fs-picker-policy.js";

export interface ActionContext {
  page: Page;
  /** Raw CDP handle, present iff the session's engine declares the `deep`
   *  escape hatch. Supplied as a capability, never keyed on an engine name;
   *  absent means the CDP-only action paths (`click({dispatch:"direct"})`)
   *  refuse rather than degrade. */
  cdp?: () => CDPSession;
  /** Engine-agnostic network substrate. The action window mints
   *  its per-action tap from here (`openActionTap()`): chromium → the verbatim
   *  CDP NetworkTap; firefox/webkit → the Playwright context-event tap. The
   *  network slice of the envelope is built off whichever the engine supplied —
   *  so navigate/click/fill carry a real network slice on every engine, not just
   *  chromium. Optional so a context with no substrate (defensive — never the
   *  live path) still builds the rest of the envelope. */
  network?: NetworkSubstrate;
  /** Engine-agnostic snapshot/a11y substrate. The pre/post
   *  `snapshotDelta` trees come from here, so the action window builds its
   *  structure diff on chromium (CDP a11y) and firefox (the page-side walker)
   *  alike. */
  snapshot: SnapshotSubstrate;
  refs: RefRegistry;
  console: ConsoleBuffer;
  pages: () => Page[]; // for newTabs detection (Playwright BrowserContext.pages())
  /** Configured test-attribute list (sourced from BROWX_TEST_ATTRIBUTES). Threaded
   *  through so pre/post a11y trees pick up the same testIds the canonical surface uses. */
  testAttributes: string[];
  /** origin allowlist used to populate `ActionResult.network.egressOffAllowlist`.
   *  Empty allow-set means "no allowlist" → egress count is always 0. */
  originPolicy?: import("../policy/origin.js").OriginPolicy;
  /** if a recording is active, the recorder is wired in here so
   *  successful actions append to the recording. Best-effort: errors during
   *  recording never affect the action's outcome. */
  recorder?: import("./recording.js").Recorder;
  /** session WS/SSE frame ring (the engine's `networkSubstrate.ws`). When
   *  present, frames that arrived during the action window are sliced into
   *  `ActionResult.network.wsFrames` via `since()`. Engine-agnostic
   *  (`SessionWsRing`): the CDP `WsBuffer` and the Playwright `PlaywrightWsBuffer`
   *  both satisfy it. */
  ws?: import("./network.js").SessionWsRing;
  /** per-session dialog policy state. When present, dialogs that fired
   *  during the action window are sliced into `ActionResult.dialogs[]`; if
   *  any fired under `raise` mode the action is marked failed with the
   *  documented hint. */
  dialog?: DialogPolicyState;
  /** per-session permission policy state. When present, permission requests
   *  that fired during the action window are sliced into
   *  `ActionResult.permissionRequests[]`; if any fired under `raise` mode the
   *  action is marked failed with the documented hint. */
  permission?: PermissionPolicyState;
  /** per-session notification policy state. When present, `new
   *  Notification(...)` constructor calls that fired during the action
   *  window are sliced into `ActionResult.notifications[]`; if any fired
   *  under `raise` mode the action is marked failed with
   *  `UNHANDLED_NOTIFICATION_HINT`. */
  notification?: NotificationPolicyState;
  /** per-session File System Access picker policy state. When present,
   *  picker calls (`showOpenFilePicker` / `showSaveFilePicker` /
   *  `showDirectoryPicker`) that fired during the action window are
   *  sliced into `ActionResult.fsPickerRequests[]`; if any fired under
   *  `raise` mode the action is marked failed with the documented hint. */
  fsPicker?: FsPickerPolicyState;
  /** per-session secrets registry (capability `secrets`). When non-null,
   *  the action-window NetworkTap masks egressing URLs / mutation
   *  responseShape keys against any registered real-values. The action's
   *  own dispatched-action descriptor is masked by the action handler
   *  (so a `fill({value:"<PASSWORD>"})` records `value:"<PASSWORD>"`, not
   *  the materialised real password). */
  secrets?: import("../util/secrets.js").SecretRegistry;
  /** per-session downloads registry. When present, any download fired during
   *  the action window AND captured (registry was toggled on) is sliced into
   *  `ActionResult.downloads[]`. Always-present-but-off-by-default at the
   *  registry level; the action-window only emits entries that actually
   *  fired during this window, so a session with capture off contributes
   *  nothing to the result. */
  downloads?: import("./downloads.js").DownloadsRegistry;
}
