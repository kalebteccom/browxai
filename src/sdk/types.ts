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
  snapshot(args?: BrowxaiArgs): Promise<BrowxaiResult>;
  find(args: BrowxaiArgs): Promise<BrowxaiResult>;
  screenshot(args?: BrowxaiArgs): Promise<BrowxaiResult>;
  console_read(args?: BrowxaiArgs): Promise<BrowxaiResult>;
  network_read(args?: BrowxaiArgs): Promise<BrowxaiResult>;
  ws_read(args?: BrowxaiArgs): Promise<BrowxaiResult>;
  inspect(args: BrowxaiArgs): Promise<BrowxaiResult>;
  text_search(args: BrowxaiArgs): Promise<BrowxaiResult>;
  extract(args: BrowxaiArgs): Promise<BrowxaiResult>;
  verify_visible(args: BrowxaiArgs): Promise<BrowxaiResult>;
  verify_text(args: BrowxaiArgs): Promise<BrowxaiResult>;
  verify_value(args: BrowxaiArgs): Promise<BrowxaiResult>;
  verify_count(args: BrowxaiArgs): Promise<BrowxaiResult>;
  verify_attribute(args: BrowxaiArgs): Promise<BrowxaiResult>;
  verify_predicate(args: BrowxaiArgs): Promise<BrowxaiResult>;
  generate_locator(args: BrowxaiArgs): Promise<BrowxaiResult>;
  plan(args: BrowxaiArgs): Promise<BrowxaiResult>;
  // --- navigation ---
  navigate(args: BrowxaiArgs): Promise<BrowxaiResult>;
  go_back(args?: BrowxaiArgs): Promise<BrowxaiResult>;
  go_forward(args?: BrowxaiArgs): Promise<BrowxaiResult>;
  scroll(args: BrowxaiArgs): Promise<BrowxaiResult>;
  set_viewport(args: BrowxaiArgs): Promise<BrowxaiResult>;
  // --- action ---
  click(args: BrowxaiArgs): Promise<BrowxaiResult>;
  fill(args: BrowxaiArgs): Promise<BrowxaiResult>;
  press(args: BrowxaiArgs): Promise<BrowxaiResult>;
  shortcut(args: BrowxaiArgs): Promise<BrowxaiResult>;
  hover(args: BrowxaiArgs): Promise<BrowxaiResult>;
  select(args: BrowxaiArgs): Promise<BrowxaiResult>;
  choose_option(args: BrowxaiArgs): Promise<BrowxaiResult>;
  fill_form(args: BrowxaiArgs): Promise<BrowxaiResult>;
  wait_for(args: BrowxaiArgs): Promise<BrowxaiResult>;
  execute(args: BrowxaiArgs): Promise<BrowxaiResult>;
  // --- coordination ---
  await_human(args: BrowxaiArgs): Promise<BrowxaiResult>;
  name_ref(args: BrowxaiArgs): Promise<BrowxaiResult>;
  // --- session lifecycle ---
  open_session(args: BrowxaiArgs): Promise<BrowxaiResult>;
  close_session(args: BrowxaiArgs): Promise<BrowxaiResult>;
  close_sessions(args?: BrowxaiArgs): Promise<BrowxaiResult>;
  list_sessions(args?: BrowxaiArgs): Promise<BrowxaiResult>;

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
