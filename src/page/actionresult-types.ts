// ActionResult type surface — the public types the action window produces and
// consumes. Split out of actionresult.ts to keep that file under the size
// budget; re-exported from `./actionresult.js` so callers import unchanged.

import type { Page } from "playwright-core";
import type { SnapshotSubstrate } from "./snapshot-substrate.js";
import type { NetworkSubstrate } from "./network-substrate.js";
import type { RefRegistry } from "./refs.js";
import type { NetworkEntry, NetworkSummary, MutationEntry, WsFrame } from "./network.js";
import type { ConsoleBuffer } from "./console.js";
import type { SnapshotMode } from "./actionresult-shape.js";
import type { DialogPolicyState, DialogRecord } from "../session/dialog.js";
import type { PermissionPolicyState, PermissionRecord } from "../session/permission.js";
import type { NotificationPolicyState, NotificationRecord } from "../session/notification.js";
import type { FsPickerPolicyState, FsPickerRecord } from "../session/fs-picker.js";

export interface DispatchedAction {
  type: string;
  ref?: string;
  selector?: string;
  value?: string;
  url?: string;
}

export interface ElementProbe {
  ref?: string;
  stillAttached: boolean;
  focused?: boolean;
  checked?: boolean | "mixed";
  /** Mid-action warnings the body wants surfaced on the ActionResult
   *  (e.g. click auto-recovery via `force:true`). Merged into the result's
   *  `warnings[]` by `runInActionWindow`. */
  warnings?: string[];
  /** Post-action DOM value of the element (input.value / textarea.value /
   *  contenteditable text). Null for elements that don't carry a value.
   *  Compare against `valueRequested` to confirm a fill landed without an
   *  extra screenshot/snapshot round-trip. */
  value?: string | null;
  /** For `fill`, the string the caller asked us to type. `value ===
   *  valueRequested` means the write succeeded as-asked; a mismatch means
   *  the field rejected or transformed it (masked input, length cap,
   *  controlled-component handler, etc.). */
  valueRequested?: string;
  /** Visible text of the closest labelled wrapper (role attr or
   *  `data-testid|test|cy|qa`) up to 4 ancestors above the targeted element,
   *  trimmed and capped at 200 chars. Surfaces the *displayed* state for
   *  controls that render the result outside `input.value` — chip-style
   *  selects, combobox displays, badge pickers, custom dropdowns where the
   *  underlying input is cleared on commit. Use when `value` is "" / null
   *  but the caller needs to confirm the visible state landed. Null when
   *  no labelled ancestor was found. Convenience alias for
   *  `ownerControl?.displayTextAfter` when an owner was detected. */
  displayText?: string | null;
  /** state of the logical *owning control* (combobox / listbox /
   *  radiogroup / labelled field wrapper) the action targeted. The caller
   *  often acts on an inner element (an option, a hidden input), but what
   *  *changed* is the owner's displayed state. `displayTextBefore` /
   *  `displayTextAfter` are the wrapper's `innerText` captured pre- and
   *  post-action; `changed: true` when they differ. Absent when no
   *  recognised owning control was found above the target. */
  ownerControl?: {
    label?: string;
    displayTextBefore?: string;
    displayTextAfter?: string;
    changed: boolean;
  };
  /** state of the repeated *container* (row / listitem / article /
   *  `<tr>` / `<li>`) the target lives inside. `rowText` is the container's
   *  visible text post-action; `changed: true` when it differed pre-vs-post.
   *  Lets the caller confirm a row-level save changed the row without
   *  re-snapshotting the whole table. Absent when the target isn't in a
   *  recognised repeated structure. */
  container?: {
    kind: string;
    rowKey?: string;
    rowText?: string;
    changed?: boolean;
  };
  /** coordinate-action evidence. Only populated for `coords` targets.
   *  `before` is `document.elementFromPoint(x, y)` immediately before the
   *  action; `after` is the same point after settling (the page may have
   *  re-rendered or scrolled). `focusChanged` flags whether the active
   *  element shifted. The coord-action analogue of `value`/`displayText`. */
  hit?: {
    before?: HitPoint | null;
    after?: HitPoint | null;
    focusChanged?: boolean;
  };
  /** post-scroll geometry of the relevant scroller (the scrolled
   *  container for `scroll` container-mode, else the window/document). Lets a
   *  caller assert "the older page prepended" (`scrollHeight` grew),
   *  "pinned to bottom" (`atBottom`), etc. without `eval_js`. Only populated
   *  by the `scroll` / `set_viewport` actions. */
  scroll?: {
    x: number;
    y: number;
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
    atTop: boolean;
    atBottom: boolean;
  };
}

export interface HitPoint {
  tag: string;
  role?: string;
  text?: string;
  ancestorText?: string;
}

export interface ActionResult {
  ok: boolean;
  action: DispatchedAction;
  navigation: {
    changed: boolean;
    from: string;
    to: string;
    kind: "full_load" | "spa" | "hash" | null;
  };
  structure: {
    appeared: Array<{ role: string; name?: string; ref: string }>;
    removed: Array<{ role: string; name?: string; ref: string }>;
    newTabs: Array<{ url: string; title: string }>;
  };
  console: {
    errors: string[];
    warnings: number;
    /** number of chars trimmed from the summarised view of `errors`
     *  (long React stack-traces etc). The full message is retained via `console_read`. */
    truncated_chars?: number;
  };
  pageErrors: string[];
  element?: ElementProbe;
  /** Multi-element variant of `element`. Populated by composed primitives
   *  that act on more than one target inside a single action window (e.g.
   *  multi-field fill). Each entry is the per-target probe in the order the
   *  primitive dispatched. `element` (singular) when present alongside refers
   *  to the *final* / submit target — kept so single-target consumers don't
   *  need to feature-detect. Absent for single-target actions. */
  elements?: ElementProbe[];
  snapshotDelta?: {
    mode: SnapshotMode;
    scope: string;
    tree?: string;
    truncated: boolean;
  };
  network: {
    summary: NetworkSummary;
    requests?: NetworkEntry[];
    /** count of requests in this action window that left
     *  `BROWX_ALLOWED_ORIGINS` (0 when no allowlist is set). */
    egressOffAllowlist?: number;
    /** bounded summary of write-shaped requests (POST/PUT/PATCH/DELETE,
     *  2xx) whose response body parsed as JSON. `responseShape` carries the
     *  *top-level keys only* — no values, no nested keys. Use to confirm a
     *  mutation succeeded and what shape it wrote back, without exposing the
     *  full response body. Absent when no mutations landed in the window. */
    mutations?: MutationEntry[];
    /** WebSocket/SSE frames that arrived during this action window
     *  (payloads truncated). Absent when none. Use to verify realtime
     *  correctness — e.g. that a click produced the expected broadcast. */
    wsFrames?: WsFrame[];
  };
  /** `alert` / `confirm` / `prompt` / `beforeunload` dialogs that fired
   *  during this action window. Empty/absent when none. Each carries the
   *  dialog kind, the page-supplied message + default value, and what the
   *  server's per-session `dialogPolicy` did with it (`accepted`, `dismissed`,
   *  or `raised` — see `set_dialog_policy`). Independent of `ok`: a policy
   *  of `accept`/`dismiss`/`accept-prompt-with:<text>` handles the dialog
   *  and the action proceeds; `raise` mode dismisses server-side AND flips
   *  `ok` to false with `failure.source:"app"`. */
  dialogs?: Array<{
    kind: DialogRecord["kind"];
    message: string;
    defaultValue?: string;
    handledAs: DialogRecord["handledAs"];
  }>;
  /** Permission requests that the page made during this action window —
   *  `getUserMedia`, `getCurrentPosition`/`watchPosition`, `Notification.
   *  requestPermission`, `clipboard.read`/`write`, and the long-tail sensor
   *  permissions. Each carries the canonical permission name, the page origin
   *  at request time, and what the server's per-session `permissionPolicy`
   *  did with it (`allowed`, `denied`, `raised`, or `asked-human` — see
   *  `set_permission_policy`). Independent of `ok`: a policy of `allow`/
   *  `deny`/`ask-human` resolves the request and the action proceeds;
   *  `raise` mode rejects page-side AND flips `ok` to false with
   *  `failure.source:"app"`. Empty/absent when no requests fired. */
  permissionRequests?: Array<{
    permission: PermissionRecord["permission"];
    origin?: string;
    handledAs: PermissionRecord["handledAs"];
  }>;
  /** `new Notification(title, opts)` constructor calls the page made during
   *  this action window. Each entry carries the constructor arguments
   *  (title + the documented subset of `NotificationOptions`: body, icon,
   *  tag), the page origin at construction time, and what the server's
   *  per-session `notificationPolicy` did with it (`allowed`, `denied`,
   *  `raised`, or `asked-human` — see `set_notification_policy`).
   *  Independent of `ok`: `allow`/`deny`/`ask-human` resolve the call and
   *  the action proceeds; `raise` mode rejects page-side AND flips `ok` to
   *  false with `failure.source:"app"`. Empty/absent when none.
   *
   *  Coordination with `permissionRequests[]`: the two surfaces are
   *  disjoint. `permissionRequests[].permission === "notifications"` is the
   *  page asking *whether it MAY notify* (`Notification.requestPermission`);
   *  `notifications[]` is the page actually *constructing* a notification
   *  (`new Notification(...)`). Both can fire in one action — typical apps
   *  call requestPermission once at startup, then construct freely. */
  notifications?: Array<{
    title: string;
    body?: string;
    icon?: string;
    tag?: string;
    timestamp: number;
    origin?: string;
    handledAs: NotificationRecord["handledAs"];
  }>;
  /** File System Access picker calls (`showOpenFilePicker` /
   *  `showSaveFilePicker` / `showDirectoryPicker`) the page made during
   *  this action window. Each carries the API name, the page-supplied
   *  `suggestedName` (save-picker only), and what the server's per-session
   *  `fsPickerPolicy` did with it (`allowed`, `denied`, `raised`, or
   *  `asked-human` — see `set_fs_picker_policy`). Independent of `ok`: a
   *  policy of `allow`/`deny`/`ask-human` resolves the picker and the
   *  action proceeds; `raise` mode rejects page-side AND flips `ok` to
   *  false with `failure.source:"app"`. Empty/absent when no pickers
   *  fired. */
  fsPickerRequests?: Array<{
    api: FsPickerRecord["api"];
    suggestedName?: string;
    handledAs: FsPickerRecord["handledAs"];
  }>;
  /** Files the page initiated as downloads during this action window —
   *  populated only when per-session capture has been turned on via
   *  `downloads_capture({on:true})` (capability `file-io`); absent otherwise.
   *  Each entry persists at a workspace-rooted path under
   *  `$BROWX_WORKSPACE/.downloads/<sessionId>/` and can be read back as
   *  bytes via `download_get({id})`. Multiple captures share the action
   *  window — bulk-downloading agents see one entry per file. */
  downloads?: Array<{
    id: string;
    suggestedFilename: string;
    rawSuggestedFilename?: string;
    mimeType?: string;
    sizeBytes: number;
    path: string;
  }>;
  tokensEstimate: number;
  warnings: string[];
  error?: string;
  /** present only when `ok` is false: did the failure originate in the app
   *  (navigation/renderer crash — a real defect signal) or in browxai
   *  (context torn down / detached / anti-wedge — NOT an app crash)? Stops
   *  agents filing false "page crashed" defects for tool teardown. */
  failure?: import("../util/failure.js").FailureClass;
  /** Set by the server when this session has hit the anti-wedge
   *  deadline on several consecutive calls — the session is wedged and
   *  retrying it (or raising `timeoutMs`) will not recover it. When present,
   *  discard the session (`close_session`) and `open_session` a fresh one.
   *  Injected onto the result by the server, not produced by the action
   *  body; `sessionWedgedHint` carries the agent-facing recovery text. */
  sessionWedged?: boolean;
  sessionWedgedHint?: string;
}

export interface ActionContext {
  page: Page;
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

export interface ActionWindowOptions {
  mode?: SnapshotMode;
  /** Approx output budget for the elastic part of the result (snapshotDelta.tree). */
  maxResultTokens?: number;
  /** Cap on per-request rows in `network.requests`; default 10. */
  networkRequestCap?: number;
  /** Post-dispatch settle delay in ms — let CDP events / framework reconciliations drain. */
  settleMs?: number;
  /** hard anti-wedge deadline (ms) for the action body. Already clamped
   *  to [1, 3_600_000] by the caller. The body is raced against this; on
   *  expiry the action returns `ok:false` with the timeout error rather than
   *  stalling on a wedged page op. */
  deadlineMs?: number;
  /** if the caller requested an over-ceiling (insane) timeout, this
   *  carries the "clamped + that's almost always a mistake" warning so it
   *  surfaces in the ActionResult, not just server stderr. */
  deadlineWarning?: string;
  /** extra warnings computed before the action window opened (e.g. a ref
   *  re-resolution notice) — seeded into the result's `warnings`. */
  extraWarnings?: string[];
  /** caller-supplied selectorHint info for the recorder. Without
   *  this the recorded step has the action + url but no locator for the YAML
   *  scaffold; callers should populate it whenever they resolved a target. */
  recordingHint?: { selectorHint: string; stability?: "high" | "medium" | "low" };
}
