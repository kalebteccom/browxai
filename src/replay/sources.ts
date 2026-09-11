// Capture sources for the replay log (RFC 0007) — the adapters that route
// browxai's existing capture onto one clock and one envelope. Nothing here
// summarises: each adapter carries its source's own shape through, applies
// redaction, and stamps the envelope.
//
// The source shapes below are structural supersets of what the capture modules
// emit (`src/page/network-cdp.ts`, `network-ws.ts`, `console.ts`,
// `actionresult-types.ts`) — index signatures, so a field browxai gains later
// rides through instead of being dropped. That is the reader-side
// forward-compatibility rule applied at the writer.

import type {
  ActionCallPayload,
  ActionResultPayload,
  AnnotateSpanPayload,
  AssertResultPayload,
  MaybeRedacted,
  ReplayEvent,
  ReplayEventType,
} from "./schema.js";
import { redactEvent, type Redactor } from "./redact.js";

/** Per-event-type payload version. Every type starts at 1; a type bumps its own
 *  when its payload shape changes, independent of the envelope version. */
export const PAYLOAD_VERSION = 1;

export interface EventClock {
  /** Wall-clock ms the session started at. Every `t` is relative to it. */
  readonly origin: number;
  at(wallMs?: number): number;
}

export function createClock(origin: number = Date.now()): EventClock {
  return { origin, at: (wallMs = Date.now()) => Math.max(0, Math.round(wallMs - origin)) };
}

export interface SourceContext {
  clock: EventClock;
  redact: Redactor;
  /** Set only on multi-target sessions, per the envelope contract. */
  targetId?: string;
}

type Extras = Record<string, unknown>;

function event<P>(
  ctx: SourceContext,
  type: ReplayEventType,
  payload: P,
  wallMs?: number,
): ReplayEvent<P> {
  const ev: ReplayEvent<P> = { t: ctx.clock.at(wallMs), type, v: PAYLOAD_VERSION, payload };
  if (ctx.targetId !== undefined) ev.targetId = ctx.targetId;
  return redactEvent(ev, ctx.redact);
}

// ---------- network: the action-window CDP tap (src/page/network-cdp.ts) ----------

export interface CdpRequest extends Extras {
  url: string;
  method: string;
  headers?: Record<string, string>;
  postData?: string;
}

export interface CdpRequestWillBeSent extends Extras {
  requestId: string;
  request: CdpRequest;
  type?: string;
  wallTime?: number;
}

export type NetRequestPayload = Omit<CdpRequestWillBeSent, "request"> & {
  request: Omit<CdpRequest, "headers" | "postData"> & {
    headers?: Record<string, MaybeRedacted<string>>;
    postData?: MaybeRedacted<string>;
  };
};

export function netRequestEvent(
  ctx: SourceContext,
  raw: CdpRequestWillBeSent,
  wallMs?: number,
): ReplayEvent<NetRequestPayload> {
  const { request, ...rest } = raw;
  const { headers, postData, ...req } = request;
  return event(
    ctx,
    "net/request",
    {
      ...rest,
      request: {
        ...req,
        ...(headers ? { headers: ctx.redact.headers(headers) } : {}),
        ...(postData !== undefined ? { postData: ctx.redact.payload(postData) } : {}),
      },
    },
    wallMs,
  );
}

export interface CdpResponse extends Extras {
  url: string;
  status: number;
  headers?: Record<string, string>;
  mimeType?: string;
}

export interface CdpResponseReceived extends Extras {
  requestId: string;
  response: CdpResponse;
  type?: string;
}

export type NetResponsePayload = Omit<CdpResponseReceived, "response"> & {
  response: Omit<CdpResponse, "headers"> & { headers?: Record<string, MaybeRedacted<string>> };
  /** Present only at the re-executable tier, where bodies are captured. */
  body?: MaybeRedacted<string>;
};

export function netResponseEvent(
  ctx: SourceContext,
  raw: CdpResponseReceived,
  opts: { body?: string; wallMs?: number } = {},
): ReplayEvent<NetResponsePayload> {
  const { response, ...rest } = raw;
  const { headers, ...res } = response;
  return event(
    ctx,
    "net/response",
    {
      ...rest,
      response: { ...res, ...(headers ? { headers: ctx.redact.headers(headers) } : {}) },
      ...(opts.body !== undefined ? { body: ctx.redact.payload(opts.body) } : {}),
    },
    opts.wallMs,
  );
}

export interface CdpLoadingFailed extends Extras {
  requestId: string;
  errorText?: string;
  type?: string;
  canceled?: boolean;
}

export function netFailedEvent(
  ctx: SourceContext,
  raw: CdpLoadingFailed,
  wallMs?: number,
): ReplayEvent<CdpLoadingFailed> {
  return event(ctx, "net/failed", { ...raw }, wallMs);
}

// ---------- websockets: the session WS/SSE ring (src/page/network-ws.ts) ----------

export interface WsOpenSource extends Extras {
  requestId: string;
  url: string;
  request?: { headers?: Record<string, string> } & Extras;
}

export type WsOpenPayload = Omit<WsOpenSource, "request"> & {
  request?: Extras & { headers?: Record<string, MaybeRedacted<string>> };
};

export function wsOpenEvent(
  ctx: SourceContext,
  raw: WsOpenSource,
  wallMs?: number,
): ReplayEvent<WsOpenPayload> {
  const { request, ...rest } = raw;
  if (!request) return event(ctx, "ws/open", { ...rest }, wallMs);
  const { headers, ...req } = request;
  return event(
    ctx,
    "ws/open",
    { ...rest, request: { ...req, ...(headers ? { headers: ctx.redact.headers(headers) } : {}) } },
    wallMs,
  );
}

/** Structural superset of `WsFrame`. */
export interface WsFrameSource extends Extras {
  url: string;
  dir: "sent" | "recv";
  kind: "ws" | "sse";
  payload: string;
  opcode?: number;
  event?: string;
  truncated?: boolean;
  ts?: number;
}

export type WsFramePayload = Omit<WsFrameSource, "payload"> & { payload: MaybeRedacted<string> };

export function wsFrameEvent(
  ctx: SourceContext,
  frame: WsFrameSource,
  wallMs?: number,
): ReplayEvent<WsFramePayload> {
  return event(
    ctx,
    "ws/frame",
    { ...frame, payload: ctx.redact.payload(frame.payload) },
    wallMs ?? frame.ts,
  );
}

export interface WsCloseSource extends Extras {
  requestId: string;
}

export function wsCloseEvent(
  ctx: SourceContext,
  raw: WsCloseSource,
  wallMs?: number,
): ReplayEvent<WsCloseSource> {
  return event(ctx, "ws/close", { ...raw }, wallMs);
}

// ---------- console + page errors (src/page/console.ts) ----------

export interface ConsoleSource extends Extras {
  type: string;
  text: string;
  ts?: number;
}

export function consoleMessageEvent(
  ctx: SourceContext,
  msg: ConsoleSource,
  wallMs?: number,
): ReplayEvent<ConsoleSource> {
  return event(ctx, "console/message", { ...msg }, wallMs ?? msg.ts);
}

export interface PageErrorSource extends Extras {
  text: string;
  stack?: string;
  ts?: number;
}

export function pageErrorEvent(
  ctx: SourceContext,
  err: PageErrorSource,
  wallMs?: number,
): ReplayEvent<PageErrorSource> {
  return event(ctx, "page/error", { ...err }, wallMs ?? err.ts);
}

// ---------- the agent's own timeline (src/page/actionresult-types.ts) ----------

export interface ActionCallSource extends Extras {
  tool: string;
  args?: unknown;
  target?: ActionCallPayload["target"];
}

export function actionCallEvent(
  ctx: SourceContext,
  call: ActionCallSource,
  wallMs?: number,
): ReplayEvent<ActionCallPayload & Extras> {
  return event(ctx, "action/call", { ...call, tool: call.tool, args: call.args }, wallMs);
}

/** What a tool handed back: an `ActionResult`, a `VerifyResult`, or a plugin
 *  tool's own envelope. Loose on purpose — the whole outcome rides through. */
export interface ToolOutcome extends Extras {
  ok?: boolean;
  error?: string;
  failure?: Extras & { kind?: unknown; expected?: unknown; actual?: unknown };
}

const ASSERTION_TOOL = /(?:^|\.)(?:verify|assert)_/;

/**
 * What the player marks on the timeline as an assertion. Two arms, because
 * neither alone holds: the name arm covers the registered `verify_*` family
 * (`verify_visible` / `text` / `value` / `count` / `attribute` / `predicate`),
 * including a plugin's `<namespace>.verify_*`, and it is the only thing that
 * identifies a PASSING assertion, which carries no distinguishing payload. The
 * shape arm covers a tool named something else that still returned the
 * fail-emitting `VerifyFailure` contract (`{kind, expected, actual}`), so a new
 * assertive tool lands on the timeline without this file being edited.
 *
 * `wait_for` stays out on both arms by design: it is permissive, and its
 * `ok:false` carries the `{source, hint}` failure class, not `expected`.
 */
export function isAssertion(tool: string, outcome?: ToolOutcome): boolean {
  if (ASSERTION_TOOL.test(tool)) return true;
  const f = outcome?.failure;
  return !!f && f.kind !== undefined && f.expected !== undefined;
}

export type ResultPayload = (ActionResultPayload | AssertResultPayload) & Extras;

/** One entry point for both halves of a tool's timeline entry: assertions are
 *  split onto `assert/result` here, so the player never has to know the tool
 *  names. `expected` / `actual` are lifted out of the structured failure; the
 *  failure itself still rides through untouched. */
export function resultEvent(
  ctx: SourceContext,
  tool: string,
  outcome: ToolOutcome,
  opts: { screenshot?: number; wallMs?: number } = {},
): ReplayEvent<ResultPayload> {
  const ok = outcome.ok === true;
  const base = { ...outcome, tool, ok };
  if (isAssertion(tool, outcome)) {
    const f = outcome.failure;
    return event(
      ctx,
      "assert/result",
      {
        ...base,
        ...(f?.expected !== undefined ? { expected: f.expected } : {}),
        ...(f?.actual !== undefined ? { actual: f.actual } : {}),
      },
      opts.wallMs,
    );
  }
  return event(
    ctx,
    "action/result",
    { ...base, ...(opts.screenshot !== undefined ? { screenshot: opts.screenshot } : {}) },
    opts.wallMs,
  );
}

// ---------- annotations (record_annotate) ----------

export interface AnnotateSource extends Extras {
  /** The acceptance-criterion id the coverage view groups by. Falls back to
   *  the annotation copy when the caller only passed prose. */
  label?: string;
  copy?: string;
  phase?: AnnotateSpanPayload["phase"];
  note?: string;
}

export function annotateSpanEvent(
  ctx: SourceContext,
  args: AnnotateSource,
  wallMs?: number,
): ReplayEvent<AnnotateSpanPayload & Extras> {
  const label = args.label ?? args.copy ?? "";
  return event(
    ctx,
    "annotate/span",
    {
      ...args,
      label,
      phase: args.phase ?? "start",
      ...((args.note ?? args.copy) ? { note: args.note ?? args.copy } : {}),
    },
    wallMs,
  );
}

// ---------- page lifecycle ----------

export interface LifecycleSource extends Extras {
  /** `framenavigated`, `load`, `domcontentloaded`, `close`, a CDP
   *  `Page.lifecycleEvent` name — carried as the page reported it. */
  name: string;
  url?: string;
  frameId?: string;
  isMainFrame?: boolean;
}

export function pageLifecycleEvent(
  ctx: SourceContext,
  ev: LifecycleSource,
  wallMs?: number,
): ReplayEvent<LifecycleSource> {
  return event(ctx, "page/lifecycle", { ...ev }, wallMs);
}
