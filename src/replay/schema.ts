// The replay event log contract (RFC 0007). Every capture source writes into
// this one shape, on one clock, and every player panel is a derived view over
// it. Nothing is summarised into panel shape at capture time: that is the step
// that cannot be undone when a new panel is written later.

/** Bump only for a breaking envelope change. New event types do NOT bump it —
 *  see the forward-compatibility rule on `ReplayEvent.type`. */
export const REPLAY_SCHEMA_VERSION = 1;

export const REPLAY_ARTIFACT_EXT = ".browx";

/**
 * One line of `events.jsonl`.
 *
 * FORWARD COMPATIBILITY, the rule the whole format rests on: a reader MUST
 * ignore event types and payload fields it does not recognise, and MUST NOT
 * fail to open a log because of them. That is what lets a 2027 player open a
 * 2026 log, and a 2026 player open a 2027 log with reduced fidelity. A breaking
 * change to an existing event's payload is expressed as a NEW `type`, never as
 * a changed shape under the old one.
 */
export interface ReplayEvent<P = unknown> {
  /** Milliseconds since `manifest.clockOrigin`. Monotonic across every source:
   *  this is what lets the player put a CDP network event, a DOM mutation and
   *  an agent action on the same timeline. */
  t: number;
  type: ReplayEventType | (string & {});
  /** Per-event-type payload version, independent of the envelope version. */
  v: number;
  payload: P;
  /** Present only when the session has more than one target (RFC 0005 pool).
   *  Absent on single-tab sessions so the common path stays small. */
  targetId?: string;
}

/** Types browxai writes today. The union is open by construction (see the
 *  `(string & {})` arm above) because a plugin may write its own. */
export type ReplayEventType =
  // The DOM stream. Payload is an rrweb event, carried verbatim so the
  // recorder stays swappable without changing this format.
  | "dom/rrweb"
  // The agent's own timeline: one per browxai tool call.
  | "action/call"
  | "action/result"
  // Assertions, split out from action/result so the player can mark them on
  // the timeline without knowing every verify_* tool name.
  | "assert/result"
  // Raw protocol, close to the wire.
  | "net/request"
  | "net/response"
  | "net/failed"
  | "ws/open"
  | "ws/frame"
  | "ws/close"
  | "console/message"
  | "page/error"
  | "page/lifecycle"
  // Spans the agent tags, e.g. an acceptance-criterion id.
  | "annotate/span"
  // Opt-in framework hooks. No panel ships for these in v1; they are recorded
  // so a panel written later has data to render.
  | "framework/react-commit"
  | "framework/redux-action"
  | "framework/vue-event";

export interface ActionCallPayload {
  tool: string;
  args: unknown;
  target?: { ref?: string; selector?: string; bbox?: [number, number, number, number] };
}

export interface ActionResultPayload {
  tool: string;
  ok: boolean;
  error?: string;
  /** Index of the screenshot frame captured for this action, if any. */
  screenshot?: number;
}

export interface AssertResultPayload {
  tool: string;
  ok: boolean;
  expected?: unknown;
  actual?: unknown;
}

export interface AnnotateSpanPayload {
  /** Free-form label, e.g. an acceptance-criterion id. The coverage view groups
   *  by this. */
  label: string;
  phase: "start" | "end";
  note?: string;
}

/** What a redaction removed. The artifact records THAT something was removed,
 *  never the value, so a reviewer can tell "nothing was there" from "something
 *  was taken out". */
export interface Redacted {
  redacted: true;
  reason: "secret" | "password-field" | "masked-selector" | "header" | "body-rule";
}

export type MaybeRedacted<T> = T | Redacted;

export function isRedacted(v: unknown): v is Redacted {
  return typeof v === "object" && v !== null && (v as Redacted).redacted === true;
}

/** Capture depth. Each tier is a superset of the one above it, so a player can
 *  tell from the manifest which panels will have data. */
export type CaptureTier =
  /** Actions, assertions, console, page errors, annotations. No DOM stream. */
  | "actions"
  /** Adds the DOM stream and network/WS metadata. The default. */
  | "replay"
  /** Adds bodies and content-addressed assets: everything a re-execution needs
   *  (RFC 0007 tier b). Largest by far. */
  | "reexecutable";

export interface ReplayManifest {
  schemaVersion: number;
  sessionId: string;
  /** Unix ms. Every event `t` is relative to this. */
  clockOrigin: number;
  tier: CaptureTier;
  browxaiVersion: string;
  engine: string;
  viewport?: { width: number; height: number };
  userAgent?: string;
  /** Present when the cap truncated capture. A silently short replay is worse
   *  than a refused one, so this is load-bearing and the player surfaces it. */
  truncated?: { at: number; reason: "size-cap" | "event-cap"; droppedEvents: number };
  counts: Record<string, number>;
  /** sha256 of events.jsonl before compression. */
  eventsDigest: string;
}
