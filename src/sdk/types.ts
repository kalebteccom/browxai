// Public type surface for `@kalebteccom/browxai` SDK consumers. Argument /
// result shapes are deliberately structural (`Record<string, unknown>` /
// `BrowxaiResult`) so the SDK does not have to re-mirror every Zod schema
// the MCP server already owns — the source of truth for input shape is the
// `inputSchema` of each registered MCP tool, and the source of truth for
// output shape is the documented per-tool reference (see
// `docs/tool-reference.md`). The SDK's job is to (a) restrict the visible
// surface to stable + capability-permitted tools and (b) preserve the egress
// hygiene the MCP path enforces — NOT to re-author every per-tool schema.

import type { Capability } from "../util/capabilities.js";
import type {
  AwaitHumanArgs,
  AwaitHumanResult,
  ChooseOptionArgs,
  ChooseOptionResult,
  ClickArgs,
  ClickResult,
  CloseSessionArgs,
  CloseSessionResult,
  CloseSessionsArgs,
  CloseSessionsResult,
  ConsoleReadArgs,
  ConsoleReadResult,
  ExecuteArgs,
  ExecuteResult,
  ExtractArgs,
  ExtractResult,
  FillArgs,
  FillFormArgs,
  FillFormResult,
  FillResult,
  FindArgs,
  FindResult,
  FramesListArgs,
  FramesListResult,
  GenerateLocatorArgs,
  GenerateLocatorResult,
  GoBackArgs,
  GoBackResult,
  GoForwardArgs,
  GoForwardResult,
  HoverArgs,
  HoverResult,
  InspectArgs,
  InspectResult,
  ListSessionsArgs,
  ListSessionsResult,
  NameRefArgs,
  NameRefResult,
  NavigateArgs,
  NavigateResult,
  NetworkReadArgs,
  NetworkReadResult,
  OpenSessionArgs,
  OpenSessionResult,
  PlanArgs,
  PlanResult,
  PressArgs,
  PressResult,
  ScreenshotArgs,
  ScreenshotResult,
  ScrollArgs,
  ScrollResult,
  SelectArgs,
  SelectResult,
  SetViewportArgs,
  SetViewportResult,
  SnapshotArgs,
  SnapshotResult,
  TextSearchArgs,
  TextSearchResult,
  VerifyAttributeArgs,
  VerifyCountArgs,
  VerifyPredicateArgs,
  VerifyResult,
  VerifyTextArgs,
  VerifyValueArgs,
  VerifyVisibleArgs,
  WaitForArgs,
  WaitForResult,
  WsReadArgs,
  WsReadResult,
} from "./tool-types.js";

/** Discriminated content item the SDK forwards from MCP results. */
export type BrowxaiContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Standard SDK result envelope. Mirrors the MCP `{ content: [...] }` shape
 * 1:1 so adopters who already think in MCP terms keep their mental model.
 * `data` is a convenience: when the first text item is parseable JSON, it is
 * surfaced here so callers do not have to JSON.parse content[0].text by hand.
 */
export interface BrowxaiResult<T = Record<string, unknown>> {
  /** Raw MCP content items — preserves images, multi-item results, etc. */
  readonly content: ReadonlyArray<BrowxaiContentItem>;
  /** Parsed JSON object from the first text item, when applicable. */
  readonly data?: T;
}

/** Argument shape: an open record. Per-tool field names match the MCP `inputSchema`. */
export type BrowxaiArgs = Record<string, unknown>;

/**
 * Options for {@link createBrowxai}.
 */
export interface BrowxaiSdkOptions {
  /**
   * Endpoint of a running browxai server to attach to.
   *
   * - `unix:///path/to/sock` — Unix domain socket on macOS/Linux.
   * - `pipe://./pipe/name` — Windows named pipe.
   * - When omitted, the SDK runs the server in-process (single Node process,
   *   no subprocess, no socket) — appropriate for tests and single-script
   *   automation. To force a child-process posture, set `transport: "stdio-child"`.
   *
   * Other schemes are rejected at `createBrowxai()` time with a clear error.
   */
  readonly endpoint?: string;

  /**
   * Transport selector. Default behaviour:
   *   - if `endpoint` set         → "socket"
   *   - if `endpoint` unset       → "in-process"
   * Set `"stdio-child"` to spawn a `browxai` child process and speak MCP-over-
   * stdio to it; this is the right choice when the caller wants OS-level
   * process isolation but does not want to manage a long-lived server.
   */
  readonly transport?: "in-process" | "stdio-child" | "socket";

  /**
   * Path to the browxai CLI when using `stdio-child`. Defaults to the
   * `browxai` bin on `PATH`.
   */
  readonly command?: string;

  /** Extra args for the `stdio-child` command. */
  readonly args?: ReadonlyArray<string>;

  /** Environment overrides for the spawned child (stdio-child only). */
  readonly env?: Record<string, string>;

  /**
   * Default session id to bind action calls to. When unset, every call
   * resolves to the lazy "default" session — same posture as the MCP path's
   * omitted-`session` field.
   */
  readonly session?: string;

  /**
   * Capability set the SDK is allowed to expose. Defaults to the server's
   * default set (read + navigation + action + human). Posture-broadening
   * capabilities (`eval`, `network-body`, `secrets`, `file-io`,
   * `byob-attach`, `extensions`, `stealth`, `captcha`, `credentials`,
   * `clipboard`) remain off-by-default — name them here to opt in.
   *
   * Two enforcement layers consult this set:
   *   1. The registry walker filters which methods are visible on the client.
   *   2. {@link BrowxaiClient.callTool} refuses unknown / off-capability tools
   *      at runtime so a `(client as any).eval_js({...})` escape hatch still
   *      fails closed.
   */
  readonly capabilities?: ReadonlyArray<Capability>;

  /**
   * Config overrides applied to the in-process server. Same shape as the
   * MCP `ConfigStore` resolve patch — for the `stdio-child` and `socket`
   * transports the option is ignored (server-side config wins).
   */
  readonly config?: Record<string, unknown>;

  /**
   * Run the in-process server headless. Ignored for `stdio-child` and
   * `socket` transports (those rely on the server-side launch flags).
   */
  readonly headless?: boolean;

  /**
   * Attach-to-an-existing-Chrome endpoint, passed through to the in-process
   * server. Requires the `byob-attach` capability.
   */
  readonly attachCdp?: string;
}

/**
 * The driver returned by {@link createBrowxai}. Every method is a typed
 * 1:1 wrapper over the matching MCP tool — args are forwarded, results are
 * the SDK envelope (raw content + parsed-JSON convenience field).
 */
export interface BrowxaiClient {
  // --- read ---
  snapshot(args?: SnapshotArgs): Promise<SnapshotResult>;
  find(args: FindArgs): Promise<FindResult>;
  frames_list(args?: FramesListArgs): Promise<FramesListResult>;
  screenshot(args?: ScreenshotArgs): Promise<ScreenshotResult>;
  console_read(args?: ConsoleReadArgs): Promise<ConsoleReadResult>;
  network_read(args?: NetworkReadArgs): Promise<NetworkReadResult>;
  ws_read(args?: WsReadArgs): Promise<WsReadResult>;
  inspect(args: InspectArgs): Promise<InspectResult>;
  text_search(args: TextSearchArgs): Promise<TextSearchResult>;
  extract(args: ExtractArgs): Promise<ExtractResult>;
  verify_visible(args: VerifyVisibleArgs): Promise<VerifyResult>;
  verify_text(args: VerifyTextArgs): Promise<VerifyResult>;
  verify_value(args: VerifyValueArgs): Promise<VerifyResult>;
  verify_count(args: VerifyCountArgs): Promise<VerifyResult>;
  verify_attribute(args: VerifyAttributeArgs): Promise<VerifyResult>;
  verify_predicate(args: VerifyPredicateArgs): Promise<VerifyResult>;
  generate_locator(args: GenerateLocatorArgs): Promise<GenerateLocatorResult>;
  plan(args: PlanArgs): Promise<PlanResult>;
  // --- navigation ---
  navigate(args: NavigateArgs): Promise<NavigateResult>;
  go_back(args?: GoBackArgs): Promise<GoBackResult>;
  go_forward(args?: GoForwardArgs): Promise<GoForwardResult>;
  scroll(args: ScrollArgs): Promise<ScrollResult>;
  set_viewport(args: SetViewportArgs): Promise<SetViewportResult>;
  // --- action ---
  click(args: ClickArgs): Promise<ClickResult>;
  fill(args: FillArgs): Promise<FillResult>;
  press(args: PressArgs): Promise<PressResult>;
  shortcut(args: BrowxaiArgs): Promise<BrowxaiResult>;
  hover(args: HoverArgs): Promise<HoverResult>;
  select(args: SelectArgs): Promise<SelectResult>;
  choose_option(args: ChooseOptionArgs): Promise<ChooseOptionResult>;
  fill_form(args: FillFormArgs): Promise<FillFormResult>;
  wait_for(args: WaitForArgs): Promise<WaitForResult>;
  execute(args: ExecuteArgs): Promise<ExecuteResult>;
  // --- coordination ---
  await_human(args: AwaitHumanArgs): Promise<AwaitHumanResult>;
  name_ref(args: NameRefArgs): Promise<NameRefResult>;
  // --- session lifecycle ---
  open_session(args: OpenSessionArgs): Promise<OpenSessionResult>;
  close_session(args: CloseSessionArgs): Promise<CloseSessionResult>;
  close_sessions(args?: CloseSessionsArgs): Promise<CloseSessionsResult>;
  list_sessions(args?: ListSessionsArgs): Promise<ListSessionsResult>;

  /**
   * Typed escape hatch for adopters that want to call a tool by name (for
   * example, capability-gated tools opted in via `capabilities`). The
   * registry walker still applies — calling a tool whose capability is not
   * in `opts.capabilities` rejects with a clear `BROWXAI_SDK_NOT_EXPOSED`
   * error. This is the layer that closes the `(client as any).eval_js(...)`
   * escape hole: even unrestricted runtime indexing must round-trip through
   * `callTool`, where the gate fires.
   */
  callTool(name: string, args?: BrowxaiArgs): Promise<BrowxaiResult>;

  /**
   * namespaced caller for plugin-registered tools. Indexed
   * twice: `client.plugins.<namespace>.<tool>(args)`. The wrapper
   * round-trips through {@link BrowxaiClient.callTool}, so
   * capability gating + the call-graph enforcement applied at the
   * server still fire.
   *
   * The default type is intentionally permissive — plugin authors
   * ship typed `.d.ts` overlays so consumers get `client.plugins.figma.moveNode`
   * autocomplete. Cast through `BrowxaiClientWithPlugins<Schema>`
   * (see docs/plugin-authoring.md) to enable the typed path.
   */
  readonly plugins: Record<string, Record<string, (args?: BrowxaiArgs) => Promise<BrowxaiResult>>>;

  /** Names of every MCP tool currently exposed on this client. */
  readonly exposedTools: ReadonlyArray<string>;

  /** Capability set currently in effect on this client. */
  readonly capabilities: ReadonlySet<Capability>;

  /** Default session id every method binds to when `args.session` is omitted. */
  readonly session: string | undefined;

  /**
   * Close the session + (when applicable) terminate the spawned server.
   * Idempotent — a second call resolves to `undefined` immediately.
   */
  close(): Promise<void>;
}
