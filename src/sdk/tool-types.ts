// Per-tool typed argument and result-data shapes for the SDK surface.
//
// Stage A shipped every BrowxaiClient method as
// `(args: BrowxaiArgs) => Promise<BrowxaiResult>` — opaque, generic. Stage A.5
// specialises each method against the curated SDK surface from
// `registry.ts` so the emitted `.d.ts` is the canonical reference for
// LLM-authoring consumers (wrightxai ).
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
//
// AUTHORITATIVE (RFC 0004 P2 / D4): THIS curated file is the single source of
// truth for the public SDK types. There is intentionally NO committed generated
// companion — `scripts/gen-sdk-tool-types.ts` remains a dev-only inspection tool
// that prints the schema-derived input shapes to stdout, but its output is not
// git-tracked: it would contradict the deliberate input narrowing here (e.g.
// `SnapshotArgs` omits `includeShadow`) and was consumed by nothing.
//
// BARREL: the type surface is split by banner section into flat siblings.
// The shared cross-tool primitives live in the LEAF (`tool-types-shared.ts`);
// the section files import those from the leaf, never from this barrel, so the
// re-export below introduces no import cycle (dependency-cruiser `no-circular`).

export type {
  ActionOpts,
  Coords,
  RefTarget,
  SessionArg,
  SnapshotMode,
  Target,
  TimeoutArg,
} from "./tool-types-shared.js";

export type {
  Actionable,
  BBox,
  ConsoleReadArgs,
  ConsoleReadResult,
  ConsoleReadResultData,
  ConsoleRow,
  ExtractArgs,
  ExtractEvidence,
  ExtractFail,
  ExtractOk,
  ExtractResult,
  ExtractResultData,
  FindArgs,
  FindCandidate,
  FindCandidateContext,
  FindResult,
  FindResultData,
  FrameInfo,
  FramesListArgs,
  FramesListData,
  FramesListResult,
  GenerateLocatorArgs,
  GenerateLocatorFail,
  GenerateLocatorOk,
  GenerateLocatorResult,
  GenerateLocatorResultData,
  InspectArgs,
  InspectResult,
  InspectResultData,
  LocatorComponent,
  NetworkReadArgs,
  NetworkReadResult,
  NetworkReadResultData,
  NetworkRequestRow,
  // plan / execute (plan family lives in the read section)
  ActionDescriptor,
  PlanArgs,
  PlanFail,
  PlanOk,
  PlanResult,
  PlanResultData,
  PlanVerb,
  PlanVerbArgs,
  ScreenshotArgs,
  ScreenshotResult,
  SnapshotArgs,
  SnapshotResult,
  Stability,
  TextSearchArgs,
  TextSearchMatch,
  TextSearchResult,
  TextSearchResultData,
  VerifyAttributeArgs,
  VerifyCountArgs,
  VerifyFail,
  VerifyFailure,
  VerifyOk,
  VerifyPredicateArgs,
  VerifyResult,
  VerifyResultData,
  VerifyTextArgs,
  VerifyValueArgs,
  VerifyVisibleArgs,
  WsFrame,
  WsReadArgs,
  WsReadResult,
  WsReadResultData,
} from "./tool-types-read.js";

export type {
  ActionResult,
  ActionResultData,
  ChooseOptionArgs,
  ChooseOptionResult,
  ClickArgs,
  ClickResult,
  ExecuteArgs,
  ExecuteResult,
  FillArgs,
  FillFormArgs,
  FillFormFieldArg,
  FillFormResult,
  FillFormSubmitArg,
  FillResult,
  GoBackArgs,
  GoBackResult,
  GoForwardArgs,
  GoForwardResult,
  HoverArgs,
  HoverResult,
  NavigateArgs,
  NavigateResult,
  PressArgs,
  PressResult,
  ScrollArgs,
  ScrollResult,
  SelectArgs,
  SelectResult,
  SetViewportArgs,
  SetViewportResult,
  WaitForArgs,
  WaitForResult,
} from "./tool-types-action.js";

export type {
  AwaitHumanArgs,
  AwaitHumanResult,
  AwaitHumanResultData,
  CloseSessionArgs,
  CloseSessionResult,
  CloseSessionResultData,
  CloseSessionsArgs,
  CloseSessionsResult,
  CloseSessionsResultData,
  EngineKind,
  ListSessionsArgs,
  ListSessionsResult,
  ListSessionsResultData,
  ListSessionsRow,
  NameRefArgs,
  NameRefResult,
  NameRefResultData,
  OpenSessionArgs,
  OpenSessionResult,
  OpenSessionResultData,
  SessionMode,
} from "./tool-types-session.js";

export type {
  EvalJsArgs,
  EvalJsFail,
  EvalJsOk,
  EvalJsResult,
  EvalJsResultData,
  NetworkBodyArgs,
  NetworkBodyResult,
  NetworkBodyResultData,
  RegisterSecretArgs,
  RegisterSecretResult,
  RegisterSecretResultData,
  UploadFileArgs,
  UploadFileResult,
  UploadFileResultData,
} from "./tool-types-capability-gated.js";
