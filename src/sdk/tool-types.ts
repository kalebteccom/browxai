// Per-tool typed argument and result-data shapes for the SDK surface.
//
// Stage A shipped every BrowxaiClient method as
// `(args: BrowxaiArgs) => Promise<BrowxaiResult>` — opaque, generic. Stage A.5
// specialises each method against the curated SDK surface from
// `registry.ts` so the emitted `.d.ts` is the canonical reference for
// LLM-authoring consumers (wrightxai Phase 1.6).
//
// **Pure type-layer addition.** The runtime path
// (`buildClient`/`callTool`/transports/capability gates) is unchanged. The
// argument shapes mirror the zod `inputSchema` of each registered MCP tool in
// `src/server.ts`; the result-data shapes mirror the documented per-tool
// payload in `docs/tool-reference.md`. The server's zod schemas remain the
// source of input-shape truth — if a doc and a zod schema disagree, the zod
// schema wins.
//
// Optional fields use `?:` so call sites with the minimal required surface
// compile cleanly. Per-tool unions are expressed as TS unions (the "exactly
// one of ref|selector|named|coords" target shape) so the type layer can
// reject obvious missing-target mistakes (e.g. `verify_text({text:"…"})`).

import type { BrowxaiResult } from "./types.js";

// =============================================================================
// Cross-tool shapes
// =============================================================================

/** Session id binding for any browser-touching tool — omitting it resolves
 *  to the lazy "default" session, byte-identical to the MCP path. */
export interface SessionArg {
  session?: string;
}

/** Anti-wedge deadline override for a single call. */
export interface TimeoutArg {
  timeoutMs?: number;
}

/** Snapshot-delta shape for action-tool results. */
export type SnapshotMode = "scoped_snapshot" | "tree_diff" | "full" | "none";

/** Common per-call inputs for action tools (ACTION_OPTS in src/server.ts). */
export interface ActionOpts extends SessionArg, TimeoutArg {
  mode?: SnapshotMode;
  maxResultTokens?: number;
}

/** Viewport coordinate (CSS px, viewport-relative). */
export interface Coords {
  x: number;
  y: number;
}

/** Target shape for tools that accept all four target kinds (click/hover). */
export type Target =
  | { ref: string; selector?: never; named?: never; coords?: never; contextRef?: string }
  | { selector: string; ref?: never; named?: never; coords?: never; contextRef?: string }
  | { named: string; ref?: never; selector?: never; coords?: never; contextRef?: string }
  | { coords: Coords; ref?: never; selector?: never; named?: never; contextRef?: never };

/** Target shape for tools that reject `coords` (fill / select / press / verify family / inspect / ...). */
export type RefTarget =
  | { ref: string; selector?: never; named?: never; contextRef?: string }
  | { selector: string; ref?: never; named?: never; contextRef?: string }
  | { named: string; ref?: never; selector?: never; contextRef?: string };

// =============================================================================
// Read-only tools
// =============================================================================

export interface SnapshotArgs extends SessionArg {
  scope?: string;
  maxNodes?: number;
  omit?: ReadonlyArray<string>;
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
}
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

// =============================================================================
// Action / navigation tools
// =============================================================================

/** Shared per-action result envelope (the JSON body of `ActionResult`).
 *  Kept structural so each action tool can refine where useful without
 *  forcing every consumer to re-import a wide tree of interfaces. */
export interface ActionResultData {
  ok: boolean;
  action?: Record<string, unknown>;
  navigation?: Record<string, unknown>;
  structure?: Record<string, unknown>;
  console?: Record<string, unknown>;
  pageErrors?: ReadonlyArray<string>;
  element?: Record<string, unknown>;
  snapshotDelta?: Record<string, unknown>;
  network?: Record<string, unknown>;
  dialogs?: ReadonlyArray<Record<string, unknown>>;
  downloads?: ReadonlyArray<Record<string, unknown>>;
  failure?: { source: string; hint?: string };
  warnings?: ReadonlyArray<string>;
  error?: string | null;
  tokensEstimate?: number;
}
export type ActionResult = BrowxaiResult<ActionResultData>;

// --- navigation -----------------------------------------------------------

export interface NavigateArgs extends ActionOpts {
  url: string;
}
export type NavigateResult = ActionResult;

export type GoBackArgs = ActionOpts;
export type GoForwardArgs = ActionOpts;
export type GoBackResult = ActionResult;
export type GoForwardResult = ActionResult;

export interface ScrollArgs extends ActionOpts {
  ref?: string;
  selector?: string;
  named?: string;
  coords?: Coords;
  contextRef?: string;
  to?: "top" | "bottom" | "left" | "right";
  by?: { x?: number; y?: number };
  intoView?: boolean;
}
export type ScrollResult = ActionResult;

export interface SetViewportArgs extends SessionArg, TimeoutArg {
  width: number;
  height: number;
}
export type SetViewportResult = ActionResult;

// --- click / hover / fill / press / select / shortcut --------------------

export type ClickArgs = Target & ActionOpts & { button?: "left" | "right" | "middle" };
export type ClickResult = ActionResult;

export type HoverArgs = Target & ActionOpts;
export type HoverResult = ActionResult;

export type FillArgs = RefTarget & ActionOpts & { value: string };
export type FillResult = ActionResult;

export type PressArgs = (RefTarget | (SessionArg & { ref?: undefined; selector?: undefined; named?: undefined })) &
  ActionOpts & { key: string };
export type PressResult = ActionResult;

export type SelectArgs = RefTarget & ActionOpts & { values: ReadonlyArray<string> };
export type SelectResult = ActionResult;

export type ChooseOptionArgs = RefTarget & ActionOpts & { option: string; exact?: boolean };
export type ChooseOptionResult = ActionResult;

// --- fill_form ------------------------------------------------------------

export interface FillFormFieldArg {
  ref?: string;
  selector?: string;
  named?: string;
  contextRef?: string;
  value: string;
}
export interface FillFormSubmitArg {
  ref?: string;
  selector?: string;
  named?: string;
  contextRef?: string;
}
export interface FillFormArgs extends ActionOpts {
  fields: ReadonlyArray<FillFormFieldArg>;
  submit?: FillFormSubmitArg;
}
export type FillFormResult = ActionResult;

// --- wait_for / execute ---------------------------------------------------

export interface WaitForArgs extends ActionOpts {
  ref?: string;
  selector?: string;
  named?: string;
  coords?: Coords;
  contextRef?: string;
  text?: string;
}
export type WaitForResult = ActionResult;

export interface ExecuteArgs extends ActionOpts {
  descriptor: ActionDescriptor;
}
export type ExecuteResult = ActionResult;

// =============================================================================
// Coordination / session lifecycle
// =============================================================================

export interface AwaitHumanArgs extends SessionArg {
  kind?: "acknowledge" | "confirm" | "choose" | "input";
  prompt: string;
  choices?: ReadonlyArray<string>;
  timeoutMs?: number;
}
export interface AwaitHumanResultData {
  kind: string;
  value: unknown;
  timedOut: boolean;
  error?: string;
}
export type AwaitHumanResult = BrowxaiResult<AwaitHumanResultData>;

export interface NameRefArgs extends SessionArg {
  name: string;
  ref: string;
}
export interface NameRefResultData {
  ok: boolean;
  name: string;
  ref: string;
}
export type NameRefResult = BrowxaiResult<NameRefResultData>;

export type SessionMode = "persistent" | "incognito" | "attached";
export interface OpenSessionArgs {
  session: string;
  mode?: SessionMode;
  profile?: string;
  device?: string;
  viewport?: { width: number; height: number };
  dialogPolicy?: string;
  storageState?: string | Record<string, unknown>;
  authState?: string;
  har?: {
    path?: string;
    mode?: "full" | "minimal";
    content?: "embed" | "attach" | "omit";
    urlFilter?: string;
  };
  hars?: ReadonlyArray<string>;
}
export interface OpenSessionResultData {
  ok: boolean;
  session?: string;
  mode?: SessionMode;
  url?: string;
  openedAt?: string;
  error?: string;
}
export type OpenSessionResult = BrowxaiResult<OpenSessionResultData>;

export interface CloseSessionArgs {
  session: string;
}
export interface CloseSessionResultData {
  ok: boolean;
  session: string;
  wasOpen: boolean;
}
export type CloseSessionResult = BrowxaiResult<CloseSessionResultData>;

export interface CloseSessionsArgs {
  prefix?: string;
  all?: boolean;
  idleMs?: number;
}
export interface CloseSessionsResultData {
  ok: boolean;
  closed?: ReadonlyArray<string>;
  count?: number;
  error?: string;
}
export type CloseSessionsResult = BrowxaiResult<CloseSessionsResultData>;

export type ListSessionsArgs = Record<string, never>;
export interface ListSessionsRow {
  id: string;
  mode: SessionMode;
  url: string | null;
  pages: number | null;
  openedAt: string;
}
export interface ListSessionsResultData {
  sessions: ListSessionsRow[];
}
export type ListSessionsResult = BrowxaiResult<ListSessionsResultData>;

// =============================================================================
// Capability-gated tools — typed for `callTool` callers; not exposed as
// per-tool methods on `BrowxaiClient`.
// =============================================================================

export interface EvalJsArgs extends SessionArg, TimeoutArg {
  expr: string;
  returnType?: "json" | "void";
}
export interface EvalJsOk {
  ok: true;
  value?: unknown;
  returnType?: "void";
  warning?: string;
}
export interface EvalJsFail {
  ok: false;
  error: string;
  warning?: string;
}
export type EvalJsResultData = EvalJsOk | EvalJsFail;
export type EvalJsResult = BrowxaiResult<EvalJsResultData>;

export interface NetworkBodyArgs extends SessionArg {
  requestId: string;
}
export interface NetworkBodyResultData {
  ok: boolean;
  body?: string;
  base64Encoded?: boolean;
  truncated?: boolean;
  error?: string;
}
export type NetworkBodyResult = BrowxaiResult<NetworkBodyResultData>;

export interface UploadFileArgs extends SessionArg {
  ref?: string;
  selector?: string;
  named?: string;
  contextRef?: string;
  name?: string;
  mimeType?: string;
  content?: string;
  path?: string;
}
export interface UploadFileResultData {
  ok: boolean;
  mode?: "content" | "path";
  name?: string;
  bytes?: number;
  mimeType?: string;
  target?: string;
  fileCount?: number;
  error?: string;
}
export type UploadFileResult = BrowxaiResult<UploadFileResultData>;

export interface RegisterSecretArgs extends SessionArg {
  name: string;
  value: string;
  scope?: string;
}
export interface RegisterSecretResultData {
  ok: boolean;
  registered?: string;
  scope?: string | null;
  names?: ReadonlyArray<string>;
  error?: string;
  tokensEstimate?: number;
}
export type RegisterSecretResult = BrowxaiResult<RegisterSecretResultData>;
