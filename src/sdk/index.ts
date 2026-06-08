// browxai SDK — typed programmatic surface over the same tool registry the
// MCP path exposes. See docs/sdk.md (or src/sdk/types.ts) for the public
// types, and `test/sdk/` for executable specs.
//
// Mental model: a `BrowxaiClient` is a thin, typed driver over ONE of three
// transports. Whichever transport the caller picks, every dispatch goes
// through the same server-side handler registry, so capability gates, the
// URL sanitiser, the `<SECRET_NAME>` substitution, and per-session isolation
// are enforced once at the server and trusted by the SDK.

import { buildClient, defaultSdkCapabilities, NOT_EXPOSED_ERROR } from "./client.js";
import type { Capability } from "../util/capabilities.js";
import { openInProcessTransport } from "./transport-in-process.js";
import { openSocketTransport } from "./transport-socket.js";
import { openStdioChildTransport } from "./transport-stdio-child.js";
import type { BrowxaiClient, BrowxaiSdkOptions } from "./types.js";

export type {
  BrowxaiArgs,
  BrowxaiClient,
  BrowxaiContentItem,
  BrowxaiResult,
  BrowxaiSdkOptions,
} from "./types.js";
export type {
  // Cross-tool shapes
  ActionOpts,
  ActionResult,
  ActionResultData,
  Coords,
  RefTarget,
  SessionArg,
  SnapshotMode,
  Stability,
  Target,
  TimeoutArg,
  // Read tools
  BBox,
  ChooseOptionArgs,
  ChooseOptionResult,
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
  ScreenshotArgs,
  ScreenshotResult,
  SnapshotArgs,
  SnapshotResult,
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
  // Plan / execute
  ActionDescriptor,
  ExecuteArgs,
  ExecuteResult,
  PlanArgs,
  PlanFail,
  PlanOk,
  PlanResult,
  PlanResultData,
  PlanVerb,
  PlanVerbArgs,
  // Navigation / action
  ClickArgs,
  ClickResult,
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
  // Coordination + session lifecycle
  AwaitHumanArgs,
  AwaitHumanResult,
  AwaitHumanResultData,
  CloseSessionArgs,
  CloseSessionResult,
  CloseSessionResultData,
  CloseSessionsArgs,
  CloseSessionsResult,
  CloseSessionsResultData,
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
  // Capability-gated (callTool consumers)
  Actionable,
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
} from "./tool-types.js";
export { NOT_EXPOSED_ERROR } from "./client.js";
export { resolveEndpointPath } from "./transport-socket.js";

/**
 * Create a typed `BrowxaiClient`. The transport is chosen by these rules:
 *
 *   1. `opts.transport === "socket"` OR `opts.endpoint` set → socket-attach
 *      to a running browxai server. Endpoint scheme MUST be `unix://` or
 *      `pipe://`; other schemes are rejected. SDK does NOT own the server
 *      lifecycle on this path.
 *
 *   2. `opts.transport === "stdio-child"` → spawn `browxai` (or the command
 *      given via `opts.command`) as a child process and speak MCP-over-stdio.
 *      SDK owns the child lifecycle; `close()` ends it.
 *
 *   3. Otherwise → run the server in-process. SDK owns the lifecycle;
 *      `close()` calls `server.shutdown()`.
 *
 * In every mode the capability set passed in `opts.capabilities` is
 * authoritative for which methods are exposed AND callable on the returned
 * client (see `buildClient`). Posture-broadening capabilities (`eval`,
 * `network-body`, `secrets`, `file-io`, `extensions`, `stealth`, `captcha`,
 * `credentials`, `clipboard`, `byob-attach`) remain off-by-default.
 */
export async function createBrowxai(opts: BrowxaiSdkOptions = {}): Promise<BrowxaiClient> {
  const capabilities: ReadonlySet<Capability> =
    opts.capabilities && opts.capabilities.length
      ? new Set<Capability>([...opts.capabilities])
      : defaultSdkCapabilities();

  const mode = opts.transport ?? (opts.endpoint ? "socket" : "in-process");

  let transport;
  switch (mode) {
    case "in-process":
      transport = await openInProcessTransport({
        attachCdp: opts.attachCdp,
        headless: opts.headless,
      });
      break;
    case "stdio-child":
      transport = await openStdioChildTransport({
        command: opts.command,
        args: opts.args,
        env: opts.env,
      });
      break;
    case "socket":
      if (!opts.endpoint) {
        throw new Error(
          `browxai-sdk: transport "socket" requires an \`endpoint\`. ` +
            `Set { endpoint: "unix:///path/to/sock" } (or pipe://./pipe/<name> on Windows).`,
        );
      }
      transport = await openSocketTransport({ endpoint: opts.endpoint });
      break;
    default:
      throw new Error(`browxai-sdk: unknown transport "${String(mode)}"`);
  }

  return buildClient({ transport, capabilities, session: opts.session });
}
