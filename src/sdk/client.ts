// BrowxaiClient implementation. The exposed-method walker, the capability
// gate filter at the SDK boundary, and the typed `callTool` escape hatch
// all live here.

import { DEFAULT_CAPABILITIES, type Capability } from "../util/capabilities.js";
import { ALWAYS_EXPOSED, SDK_TOOLS, capabilityFor } from "./registry.js";
import type { SdkTransport } from "./transport.js";
import type { BrowxaiArgs, BrowxaiClient, BrowxaiResult } from "./types.js";

/** Error message tag used by the SDK boundary's runtime gate. Tested by the
 *  capability-enforcement spec. Stable string — adopters can match on it. */
export const NOT_EXPOSED_ERROR = "BROWXAI_SDK_NOT_EXPOSED";

export interface BuildClientOptions {
  readonly transport: SdkTransport;
  readonly capabilities: ReadonlySet<Capability>;
  readonly session?: string;
}

/**
 * Build a BrowxaiClient over a ready transport. Method-name → MCP-tool-name
 * is 1:1 (the registry walker emits a wrapper per stable tool); a thin
 * `callTool(name, args)` escape hatch exists for typed-but-unwrapped tools
 * (notably the capability-gated ones).
 */
export function buildClient(opts: BuildClientOptions): BrowxaiClient {
  const { transport, capabilities, session } = opts;

  // The set of tool names this SDK instance will expose. The walker runs
  // ONCE at construction; runtime `callTool` re-checks against the same set
  // so even `(client as any).fooBar` indexing cannot bypass the gate.
  const exposed = new Set<string>();
  for (const name of SDK_TOOLS) {
    if (ALWAYS_EXPOSED.has(name)) {
      exposed.add(name);
      continue;
    }
    const cap = capabilityFor(name);
    // `human` capability is implicit — it's always on. Otherwise the cap
    // must be in the SDK's opted-in set for the tool to be exposed.
    if (cap === "human" || capabilities.has(cap as Capability)) {
      exposed.add(name);
    }
  }

  let closed = false;

  /** Apply the session default + dispatch. */
  const dispatch = async (toolName: string, args?: BrowxaiArgs): Promise<BrowxaiResult> => {
    if (closed) throw new Error(`browxai-sdk: ${toolName} called on a closed client`);
    const merged: Record<string, unknown> = { ...(args ?? {}) };
    if (session !== undefined && merged.session === undefined) {
      merged.session = session;
    }
    return transport.dispatch(toolName, merged);
  };

  /** Runtime gate — the immutable barrier for capability-gated tools. */
  const callTool = async (name: string, args?: BrowxaiArgs): Promise<BrowxaiResult> => {
    if (!exposed.has(name)) {
      const cap = capabilityFor(name);
      const error = new Error(
        `${NOT_EXPOSED_ERROR}: tool "${name}" is not exposed on this SDK client. ` +
          `Required capability: "${cap}". Active capabilities: [${[...capabilities].join(", ")}]. ` +
          `Pass it in \`createBrowxai({ capabilities: ["${cap}"] })\` to opt in. ` +
          `Posture-broadening capabilities (eval / network-body / secrets / file-io / extensions / stealth / captcha / credentials / clipboard / byob-attach) are OFF-by-default by design — same posture as the MCP server's capability gates.`,
      );
      throw error;
    }
    return dispatch(name, args);
  };

  // Per-tool wrappers — typed methods listed in BrowxaiClient. Each forwards
  // through `dispatch` for exposed tools, or refuses early via the same
  // walker check used by `callTool`. We emit ALL the typed methods (every
  // SDK_TOOLS name) regardless of exposure: when a capability is off, the
  // method exists at the type level but throws BROWXAI_SDK_NOT_EXPOSED at
  // call time. This makes `client.eval_js?.(...)` a tractable refactor when
  // the operator later opts the capability in.
  //
  // The runtime wrapper is intentionally `(args?: BrowxaiArgs) => …` — the
  // dispatch path is shape-agnostic. The per-tool TypeScript signatures
  // declared on `BrowxaiClient` specialise this at the type layer only; the
  // cast below assigns one generic factory output to each typed slot without
  // duplicating the wrapper N times.
  // The runtime fn signature is uniform; the per-method TS signatures on
  // `BrowxaiClient` narrow it. `<F>` lets each call site project the wrapper
  // into the exact typed slot without per-method duplication.
  const guarded = <F>(toolName: string): F =>
    (async (args?: BrowxaiArgs): Promise<BrowxaiResult> => callTool(toolName, args)) as unknown as F;

  /** Shorthand: pluck a typed-method slot off `BrowxaiClient` for `guarded<F>`'s
   *  type parameter. Keeps the assignment table below readable. */
  type M<K extends keyof BrowxaiClient> = BrowxaiClient[K];

  const client: BrowxaiClient = {
    // read
    snapshot: guarded<M<"snapshot">>("snapshot"),
    find: guarded<M<"find">>("find"),
    frames_list: guarded<M<"frames_list">>("frames_list"),
    screenshot: guarded<M<"screenshot">>("screenshot"),
    console_read: guarded<M<"console_read">>("console_read"),
    network_read: guarded<M<"network_read">>("network_read"),
    ws_read: guarded<M<"ws_read">>("ws_read"),
    inspect: guarded<M<"inspect">>("inspect"),
    text_search: guarded<M<"text_search">>("text_search"),
    extract: guarded<M<"extract">>("extract"),
    verify_visible: guarded<M<"verify_visible">>("verify_visible"),
    verify_text: guarded<M<"verify_text">>("verify_text"),
    verify_value: guarded<M<"verify_value">>("verify_value"),
    verify_count: guarded<M<"verify_count">>("verify_count"),
    verify_attribute: guarded<M<"verify_attribute">>("verify_attribute"),
    verify_predicate: guarded<M<"verify_predicate">>("verify_predicate"),
    generate_locator: guarded<M<"generate_locator">>("generate_locator"),
    plan: guarded<M<"plan">>("plan"),
    // navigation
    navigate: guarded<M<"navigate">>("navigate"),
    go_back: guarded<M<"go_back">>("go_back"),
    go_forward: guarded<M<"go_forward">>("go_forward"),
    scroll: guarded<M<"scroll">>("scroll"),
    set_viewport: guarded<M<"set_viewport">>("set_viewport"),
    // action
    click: guarded<M<"click">>("click"),
    fill: guarded<M<"fill">>("fill"),
    press: guarded<M<"press">>("press"),
    shortcut: guarded<M<"shortcut">>("shortcut"),
    hover: guarded<M<"hover">>("hover"),
    select: guarded<M<"select">>("select"),
    choose_option: guarded<M<"choose_option">>("choose_option"),
    fill_form: guarded<M<"fill_form">>("fill_form"),
    wait_for: guarded<M<"wait_for">>("wait_for"),
    execute: guarded<M<"execute">>("execute"),
    // coordination
    await_human: guarded<M<"await_human">>("await_human"),
    name_ref: guarded<M<"name_ref">>("name_ref"),
    // session lifecycle
    open_session: guarded<M<"open_session">>("open_session"),
    close_session: guarded<M<"close_session">>("close_session"),
    close_sessions: guarded<M<"close_sessions">>("close_sessions"),
    list_sessions: guarded<M<"list_sessions">>("list_sessions"),
    // escape hatch + introspection
    callTool,
    exposedTools: [...exposed].sort(),
    capabilities,
    session,
    close: async () => {
      if (closed) return;
      closed = true;
      await transport.close();
    },
  };

  return client;
}

/** Default capability set when the caller did not pass one. Mirrors the MCP
 *  server defaults (read + navigation + action + human). */
export function defaultSdkCapabilities(): ReadonlySet<Capability> {
  return new Set<Capability>([...DEFAULT_CAPABILITIES]);
}
