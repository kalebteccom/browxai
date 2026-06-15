// ActionResult post-state block builders — the pure shaping helpers that
// `runInActionWindow` (actionresult.ts) composes after the action window closes.
// Each function maps one captured slice into its public result block; pulling
// them out keeps the orchestrator under the size/complexity budget without
// changing any output shape (the blocks are byte-identical to the inline
// versions). No page contact — every input is already-captured data.

import type { DispatchedAction } from "./actionresult.js";
import type { NetworkEntry, NetworkSummary, MutationEntry, WsFrame } from "./network.js";
import type { DialogRecord } from "../session/dialog.js";
import type { PermissionRecord } from "../session/permission.js";
import type { NotificationRecord } from "../session/notification.js";
import type { FsPickerRecord } from "../session/fs-picker.js";
import type { CapturedDownload } from "./downloads.js";

/** The mutable action outcome a `raise`-policy slice can flip. */
export interface ActionOutcome {
  ok: boolean;
  error: string | undefined;
  failure: import("../util/failure.js").FailureClass | undefined;
}

/** If a policy fired in `raise` mode during the window and the action otherwise
 *  succeeded, flip it to a clean ok:false with the policy's stable hint. The
 *  page was handled server-side (not deadlocked), but the app saw the
 *  cancel/deny branch and the caller almost certainly didn't want that.
 *  Returns the (possibly) updated outcome; first raise wins (mirrors the prior
 *  inline order: dialog → permission → notification → fs-picker). */
export function applyPolicyRaise(
  outcome: ActionOutcome,
  raised: boolean,
  hint: string,
): ActionOutcome {
  if (!raised || !outcome.ok) return outcome;
  return { ok: false, error: outcome.error ?? hint, failure: { source: "app", hint } };
}

export function buildDialogsBlock(slice: DialogRecord[]): Omit<DialogRecord, "ts">[] | undefined {
  if (slice.length === 0) return undefined;
  return slice.map((d) => {
    const { ts: _ts, ...pub } = d;
    return pub;
  });
}

export interface PermissionRequestBlock {
  permission: PermissionRecord["permission"];
  origin?: string;
  handledAs: PermissionRecord["handledAs"];
}

export function buildPermissionRequestsBlock(
  slice: PermissionRecord[],
): PermissionRequestBlock[] | undefined {
  if (slice.length === 0) return undefined;
  return slice.map((r) => {
    const out: PermissionRequestBlock = { permission: r.permission, handledAs: r.handledAs };
    if (r.origin !== undefined) out.origin = r.origin;
    return out;
  });
}

export interface NotificationBlock {
  title: string;
  body?: string;
  icon?: string;
  tag?: string;
  timestamp: number;
  origin?: string;
  handledAs: NotificationRecord["handledAs"];
}

export function buildNotificationsBlock(
  slice: NotificationRecord[],
): NotificationBlock[] | undefined {
  if (slice.length === 0) return undefined;
  return slice.map((n) => {
    const out: NotificationBlock = {
      title: n.title,
      timestamp: n.timestamp,
      handledAs: n.handledAs,
    };
    if (n.body !== undefined) out.body = n.body;
    if (n.icon !== undefined) out.icon = n.icon;
    if (n.tag !== undefined) out.tag = n.tag;
    if (n.origin !== undefined) out.origin = n.origin;
    return out;
  });
}

export interface FsPickerRequestBlock {
  api: FsPickerRecord["api"];
  suggestedName?: string;
  handledAs: FsPickerRecord["handledAs"];
}

export function buildFsPickerRequestsBlock(
  slice: FsPickerRecord[],
): FsPickerRequestBlock[] | undefined {
  if (slice.length === 0) return undefined;
  return slice.map((r) => {
    const out: FsPickerRequestBlock = { api: r.api, handledAs: r.handledAs };
    if (r.suggestedName !== undefined) out.suggestedName = r.suggestedName;
    return out;
  });
}

export interface DownloadBlock {
  id: string;
  suggestedFilename: string;
  rawSuggestedFilename?: string;
  mimeType?: string;
  sizeBytes: number;
  path: string;
}

export function buildDownloadsBlock(slice: CapturedDownload[]): DownloadBlock[] | undefined {
  if (slice.length === 0) return undefined;
  return slice.map((d) => {
    const out: DownloadBlock = {
      id: d.id,
      suggestedFilename: d.suggestedFilename,
      sizeBytes: d.sizeBytes,
      path: d.path,
    };
    if (d.rawSuggestedFilename !== undefined) out.rawSuggestedFilename = d.rawSuggestedFilename;
    if (d.mimeType !== undefined) out.mimeType = d.mimeType;
    return out;
  });
}

export interface NetworkCloseResult {
  summary: NetworkSummary;
  requests: NetworkEntry[];
  mutations: MutationEntry[];
}

export interface NetworkBlock {
  summary: NetworkSummary;
  requests?: NetworkEntry[];
  egressOffAllowlist?: number;
  mutations?: MutationEntry[];
  wsFrames?: WsFrame[];
}

/** Build the `network` result block. Within the per-request cap the full
 *  request rows ride along; over the cap they're omitted with a warning
 *  pointing at `network_read`. Mutations + WS frames attach when present. */
export function buildNetworkBlock(
  network: NetworkCloseResult,
  wsSlice: WsFrame[],
  egressOffAllowlist: number,
  requestCap: number,
  warnings: string[],
): NetworkBlock {
  const mutationsBlock = network.mutations.length > 0 ? { mutations: network.mutations } : {};
  const wsBlock = wsSlice.length > 0 ? { wsFrames: wsSlice } : {};
  if (network.summary.total === 0) {
    return { summary: network.summary, ...mutationsBlock, ...wsBlock };
  }
  if (network.requests.length <= requestCap) {
    return {
      summary: network.summary,
      requests: network.requests,
      ...(egressOffAllowlist > 0 ? { egressOffAllowlist } : {}),
      ...mutationsBlock,
      ...wsBlock,
    };
  }
  warnings.push(
    `network.requests omitted (count ${network.requests.length} > cap ${requestCap}); call network_read for details`,
  );
  return {
    summary: network.summary,
    ...(egressOffAllowlist > 0 ? { egressOffAllowlist } : {}),
    ...mutationsBlock,
    ...wsBlock,
  };
}

/** The five optional capture blocks, each present only when its slice was
 *  non-empty. Collected once so the orchestrator spreads a single object into
 *  both the token estimate and the final result (the prior code repeated ten
 *  `...(x ? {key:x} : {})` ternaries). */
export interface OptionalBlocks {
  dialogs?: Omit<DialogRecord, "ts">[];
  permissionRequests?: PermissionRequestBlock[];
  notifications?: NotificationBlock[];
  fsPickerRequests?: FsPickerRequestBlock[];
  downloads?: DownloadBlock[];
}

export function assembleOptionalBlocks(parts: {
  dialogs: Omit<DialogRecord, "ts">[] | undefined;
  permissionRequests: PermissionRequestBlock[] | undefined;
  notifications: NotificationBlock[] | undefined;
  fsPickerRequests: FsPickerRequestBlock[] | undefined;
  downloads: DownloadBlock[] | undefined;
}): OptionalBlocks {
  const out: OptionalBlocks = {};
  if (parts.dialogs) out.dialogs = parts.dialogs;
  if (parts.permissionRequests) out.permissionRequests = parts.permissionRequests;
  if (parts.notifications) out.notifications = parts.notifications;
  if (parts.fsPickerRequests) out.fsPickerRequests = parts.fsPickerRequests;
  if (parts.downloads) out.downloads = parts.downloads;
  return out;
}

const NON_TARGETED_ACTIONS = new Set(["navigate", "goBack", "goForward"]);

export interface RecordableStep {
  descriptor: DispatchedAction;
  urlAfter: string;
  recordingHint: { selectorHint: string; stability?: "high" | "medium" | "low" } | undefined;
}

/** Append the action to an active recording when it is replayable as a
 *  flow-file step. Coord-mode click/hover (no ref/selector/hint) are an escape
 *  hatch flow files can't mechanically replay, so they're skipped with a
 *  warning. Navigation/history actions need no target and are always recorded. */
export function maybeRecord(
  recorder: import("./recording.js").Recorder | undefined,
  ok: boolean,
  step: RecordableStep,
  warnings: string[],
): void {
  if (!ok || !recorder?.active()) return;
  const { descriptor, urlAfter, recordingHint } = step;
  const isElementAction = !NON_TARGETED_ACTIONS.has(descriptor.type);
  const hasReplayableTarget = !!(descriptor.ref || descriptor.selector || recordingHint);
  if (!isElementAction || hasReplayableTarget) {
    try {
      recorder.record(descriptor, urlAfter, recordingHint);
    } catch {
      /* swallow */
    }
    return;
  }
  warnings.push(
    "recorder: skipped untargeted action (coords-mode click/hover) — flow files replay deterministically by ref/selector; record the equivalent ref-based action if you want this step in the draft",
  );
}
