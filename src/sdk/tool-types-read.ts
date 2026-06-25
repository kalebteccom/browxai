// Read-only tool argument and result-data shapes for the SDK surface.
//
// One section of the `tool-types` split. Shared primitives come from
// `tool-types-shared.js` (the leaf), never from the `tool-types.js` barrel that
// re-exports this file — that back-import would be a cycle. See `tool-types.ts`
// for the authoritative header on why this surface exists.

import type { BrowxaiResult } from "./types.js";
import type { RefTarget, SessionArg } from "./tool-types-shared.js";

// =============================================================================
// Read-only tools
// =============================================================================

export interface SnapshotArgs extends SessionArg {
  scope?: string;
  maxNodes?: number;
  omit?: ReadonlyArray<string>;
  /** stable frame ID (from `frames_list`) to scope the snapshot to
   *  a child iframe. `f0` (or omitting this) targets the main frame. */
  frame?: string;
}
/** The text content of `snapshot()` isn't structured JSON — it's a serialised
 *  a11y tree. The envelope's `data` field is undefined; callers read
 *  `content[0].text` directly. */
export type SnapshotResult = BrowxaiResult;

export interface FindArgs extends SessionArg {
  query: string;
  maxCandidates?: number;
  confidenceFloor?: number;
  contextRef?: string;
  visibleOnly?: boolean;
  /** stable frame ID (from `frames_list`) to scope the find to a
   *  child iframe. `f0` (or omitting this) targets the main frame. Refs
   *  minted are bound to the frame so subsequent actions land inside it. */
  frame?: string;
}

/**
 * frame discovery.
 */
export type FramesListArgs = SessionArg;
export interface FrameInfo {
  frameId: string;
  parentFrameId?: string;
  url: string;
  name: string;
  isMainFrame: boolean;
  origin: string;
}
export interface FramesListData {
  ok: true;
  frames: FrameInfo[];
  tokensEstimate: number;
}
export type FramesListResult = BrowxaiResult<FramesListData>;
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface FindCandidateContext {
  collection?: string;
  rowKey?: string;
  column?: string;
  rowText?: string;
}
export type Actionable = true | "disabled" | "off-screen" | "covered";
export type Stability = "high" | "medium" | "low";
export interface FindCandidate {
  ref: string;
  role: string;
  name?: string;
  testId?: string;
  stability: Stability;
  selectorHint?: string;
  selectorTier?: number;
  bbox: BBox | null;
  clipped?: boolean;
  score?: number;
  actionable?: Actionable;
  context?: FindCandidateContext;
}
export interface FindResultData {
  query: string;
  candidates: FindCandidate[];
  warnings?: string[];
}
export type FindResult = BrowxaiResult<FindResultData>;

export interface ScreenshotArgs extends SessionArg {
  ref?: string;
  selector?: string;
  named?: string;
  contextRef?: string;
  describe?: boolean;
  format?: "png" | "jpeg";
  quality?: number;
  scale?: "css" | "device";
}
/** Screenshot returns an MCP `image` content item (and optionally a caption
 *  text part). No structured JSON `data`. */
export type ScreenshotResult = BrowxaiResult;

export interface ConsoleReadArgs extends SessionArg {
  limit?: number;
}
export interface ConsoleRow {
  ts: number;
  type: string;
  text: string;
}
export type ConsoleReadResultData = ConsoleRow[];
export type ConsoleReadResult = BrowxaiResult<ConsoleReadResultData>;

export interface NetworkReadArgs extends SessionArg {
  limit?: number;
}
export interface NetworkRequestRow {
  method: string;
  url: string;
  status?: number;
  type?: string;
  ms?: number;
  requestId?: string;
}
export interface NetworkReadResultData {
  summary: {
    total: number;
    byType: Record<string, number>;
    failed: number;
  };
  requests: NetworkRequestRow[];
}
export type NetworkReadResult = BrowxaiResult<NetworkReadResultData>;

export interface WsReadArgs extends SessionArg {
  limit?: number;
  urlPattern?: string;
}
export interface WsFrame {
  url: string;
  dir: "sent" | "recv";
  kind: "ws" | "sse";
  opcode?: number;
  event?: string;
  payload: string;
  truncated?: boolean;
  ts: number;
}
export interface WsReadResultData {
  total: number;
  frames: WsFrame[];
}
export type WsReadResult = BrowxaiResult<WsReadResultData>;

export interface InspectArgs extends SessionArg {
  ref?: string;
  selector?: string;
  named?: string;
  contextRef?: string;
  styles?: ReadonlyArray<string>;
}
export interface InspectResultData {
  found: boolean;
  box?: BBox;
  styles?: Record<string, string>;
  overflowing?: { x: boolean; y: boolean };
  visible?: boolean;
  childCount?: number;
}
export type InspectResult = BrowxaiResult<InspectResultData>;

export interface TextSearchArgs extends SessionArg {
  text: string;
  exact?: boolean;
  scope?: string;
  includeHidden?: boolean;
  maxMatches?: number;
}
export interface TextSearchMatch {
  ref: string;
  role: string;
  text: string;
  context?: FindCandidateContext;
  bbox: BBox | null;
  clipped?: boolean;
}
export interface TextSearchResultData {
  count: number;
  matches: TextSearchMatch[];
}
export type TextSearchResult = BrowxaiResult<TextSearchResultData>;

export interface ExtractArgs extends SessionArg {
  /** JSON-schema-flavoured shape. Kept as `Record<string, unknown>` — full
   *  JSON-Schema typing would be a much larger surface than the SDK needs. */
  schema: Record<string, unknown>;
  ref?: string;
  scope?: string;
  /** RETIRED in v0.3.2 — the `mode` arg is no longer part of the typed SDK
   *  surface. Deterministic is the only supported path. Setting
   *  `mode:"llm-assisted"` at runtime is tolerated for back-compat
   *  (graceful deprecation — emits a console.warn and proceeds as
   *  deterministic) but the type no longer exposes it, so new code
   *  shouldn't pass it. Drop the arg. */
}
export interface ExtractEvidence {
  refsUsed?: ReadonlyArray<string>;
  selectorsUsed?: ReadonlyArray<string>;
  partialMisses?: ReadonlyArray<unknown>;
}
export interface ExtractOk {
  ok: true;
  data: unknown;
  evidence: ExtractEvidence;
  tokensEstimate: number;
}
export interface ExtractFail {
  ok: false;
  failure: {
    source: "app" | "browxai";
    kind: string;
    expected?: string;
    actual?: string;
    partialMisses?: ReadonlyArray<unknown>;
  };
  tokensEstimate: number;
}
export type ExtractResultData = ExtractOk | ExtractFail;
export type ExtractResult = BrowxaiResult<ExtractResultData>;

// --- verify family --------------------------------------------------------

export interface VerifyFailure {
  source: "app" | "browxai";
  kind: string;
  expected: string;
  actual: string;
  evidence?: unknown;
}
export interface VerifyOk {
  ok: true;
}
export interface VerifyFail {
  ok: false;
  failure: VerifyFailure;
}
export type VerifyResultData = VerifyOk | VerifyFail;
export type VerifyResult = BrowxaiResult<VerifyResultData>;

export type VerifyVisibleArgs = RefTarget & SessionArg;
export type VerifyTextArgs = RefTarget & SessionArg & { text: string; exact?: boolean };
export type VerifyValueArgs = RefTarget & SessionArg & { value: string };
export interface VerifyCountArgs extends SessionArg {
  n: number;
  selector?: string;
  text?: string;
}
export type VerifyAttributeArgs = RefTarget & SessionArg & { attr: string; value?: string };
export interface VerifyPredicateArgs extends SessionArg {
  predicate: Record<string, unknown>;
  data: Record<string, unknown>;
}

// --- generate_locator -----------------------------------------------------

export interface GenerateLocatorArgs extends SessionArg {
  ref: string;
}
export interface LocatorComponent {
  kind: "testid" | "role" | "text" | "css";
  value: string;
  name?: string;
  attribute?: string;
}
export interface GenerateLocatorOk {
  ok: true;
  playwright: string;
  stability: Stability;
  components: LocatorComponent[];
  tokensEstimate: number;
}
export interface GenerateLocatorFail {
  ok: false;
  failure: {
    kind: "ref-not-found";
    ref: string;
    hint?: string;
  };
  tokensEstimate: number;
}
export type GenerateLocatorResultData = GenerateLocatorOk | GenerateLocatorFail;
export type GenerateLocatorResult = BrowxaiResult<GenerateLocatorResultData>;

// --- plan -----------------------------------------------------------------

export type PlanVerb = "click" | "fill" | "hover" | "press" | "select";
export interface PlanVerbArgs {
  value?: string;
  values?: ReadonlyArray<string>;
  key?: string;
  button?: "left" | "right" | "middle";
}
export interface PlanArgs extends SessionArg {
  query: string;
  verb: PlanVerb;
  verbArgs?: PlanVerbArgs;
  contextRef?: string;
  confidenceFloor?: number;
  ttlMs?: number;
}
export interface ActionDescriptor {
  id: string;
  ref: string;
  verb: PlanVerb;
  args?: PlanVerbArgs;
  evidence?: Record<string, unknown>;
  expiresAt: number;
}
export interface PlanOk {
  ok: true;
  descriptor: ActionDescriptor;
  tokensEstimate?: number;
}
export interface PlanFail {
  ok: false;
  error?: string;
  failure?: { source: "app" | "browxai"; kind: string; expected?: string; actual?: string };
}
export type PlanResultData = PlanOk | PlanFail;
export type PlanResult = BrowxaiResult<PlanResultData>;
