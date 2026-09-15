// BrowxaiClient implementation. The capability gate at the SDK boundary, the
// typed method wrappers, and the `callTool` caller all live here.

import { DEFAULT_CAPABILITIES, type Capability } from "../util/capabilities.js";
import { capabilityFor, isRegisteredTool, registeredTools } from "./registry.js";
import type { SdkTransport } from "./transport.js";
import type { BrowxaiArgs, BrowxaiClient, BrowxaiResult } from "./types.js";

/** Error message tag: the tool exists, its capability is not active on this
 *  client. Tested by the capability-enforcement spec. Stable string — adopters
 *  can match on it. */
export const NOT_EXPOSED_ERROR = "BROWXAI_SDK_NOT_EXPOSED";

/** Error message tag: the name is not a tool any browxai build registers. Its
 *  own tag because the remedy differs — naming a capability cannot fix a typo,
 *  and one shared branch used to advise exactly that. Stable string. */
export const UNKNOWN_TOOL_ERROR = "BROWXAI_SDK_UNKNOWN_TOOL";

/** Plugin tools are `<namespace>.<tool>` and register in the SERVER's process,
 *  which for the socket / stdio-child transports is NOT this one — so this
 *  process cannot answer whether one exists. No core tool name contains a dot,
 *  so a dotted name can never reach a core tool. */
const isPluginToolName = (name: string): boolean => name.includes(".");

function notExposedMessage(
  name: string,
  cap: Capability | "human",
  capabilities: ReadonlySet<Capability>,
): string {
  return (
    `${NOT_EXPOSED_ERROR}: tool "${name}" requires the "${cap}" capability, which is not ` +
    `active on this SDK client. Active capabilities: [${[...capabilities].join(", ")}]. ` +
    `Pass it in \`createBrowxai({ capabilities: ["${cap}"] })\` to opt in — and enable it on ` +
    `the server too (BROWX_CAPABILITIES), which gates the same tool independently. ` +
    `Posture-broadening capabilities (eval / network-body / secrets / file-io / canvas / ` +
    `extensions / stealth / captcha / credentials / clipboard / device-emulation / ` +
    `diagnostics / byob-attach / replay) are OFF-by-default by design — same posture as the ` +
    `MCP server's capability gates.`
  );
}

function unknownToolMessage(name: string): string {
  return (
    `${UNKNOWN_TOOL_ERROR}: "${name}" is not a tool this browxai build registers, so no ` +
    `capability can make it callable — check the spelling against docs/tool-reference.md. ` +
    `Nothing was dispatched.`
  );
}

export interface BuildClientOptions {
  readonly transport: SdkTransport;
  readonly capabilities: ReadonlySet<Capability>;
  readonly session?: string;
}

/**
 * Build a BrowxaiClient over a ready transport. Method-name → MCP-tool-name is
 * 1:1 for the curated typed surface (`SDK_TOOLS`); `callTool(name, args)`
 * reaches EVERY registered tool whose capability is active, so the SDK's reach
 * equals the MCP server's with identical gating on both paths.
 */
export function buildClient(opts: BuildClientOptions): BrowxaiClient {
  const { transport, capabilities, session } = opts;

  // THE GATE. A tool is callable when its capability is active; `human` is
  // implicit (always on), matching the server. Curation of the typed surface
  // plays no part — `SDK_TOOLS` decides what gets a signature, never what can
  // be called.
  const admits = (name: string): boolean => {
    const cap = capabilityFor(name);
    return cap === "human" || capabilities.has(cap);
  };

  // Snapshot of the callable surface, for `exposedTools` introspection only.
  // The gate itself re-runs per call inside `callTool` — it never reads this.
  const exposed = registeredTools().filter(admits).sort();

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

  /** Runtime gate — the immutable barrier for capability-gated tools. Every
   *  typed method routes through here, so no path reaches `dispatch` without
   *  it: `(client as any).fooBar` indexing cannot bypass the gate. An unknown
   *  name is refused on its own branch BEFORE any capability is resolved, so a
   *  typo can never land on the permissive `human` default. */
  const callTool = async (name: string, args?: BrowxaiArgs): Promise<BrowxaiResult> => {
    if (!isRegisteredTool(name)) {
      if (!isPluginToolName(name)) throw new Error(unknownToolMessage(name));
      // A plugin tool this process cannot see. Defer: the server's own gate
      // answers on dispatch, and refuses an unknown name there.
      return dispatch(name, args);
    }
    if (!admits(name)) throw new Error(notExposedMessage(name, capabilityFor(name), capabilities));
    return dispatch(name, args);
  };

  // Per-tool wrappers — the typed methods declared on BrowxaiClient, one per
  // `SDK_TOOLS` entry. Each forwards through `callTool`, so it is gated exactly
  // like a by-name call. We emit ALL of them regardless of the capability set:
  // when a capability is off, the method exists at the type level but throws
  // BROWXAI_SDK_NOT_EXPOSED at call time.
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
    (async (args?: BrowxaiArgs): Promise<BrowxaiResult> =>
      callTool(toolName, args)) as unknown as F;

  /** Shorthand: pluck a typed-method slot off `BrowxaiClient` for `guarded<F>`'s
   *  type parameter. Keeps the assignment table below readable. */
  type M<K extends keyof BrowxaiClient> = BrowxaiClient[K];

  // namespaced caller for plugin tools. Every tool the
  // server exposes whose name contains a `.` is a plugin tool; the
  // client surfaces it lazily under `client.plugins[namespace][tool]`
  // so an adopter can write `client.plugins.figma.moveNode({...})`
  // without manually round-tripping through `callTool`.
  //
  // The plugin tools an SDK client sees are sourced from the
  // transport's introspection: at construction time the SDK doesn't
  // know which plugin tools the server has registered (the in-process
  // transport COULD inspect the handler map, but for parity with
  // socket/stdio-child we defer to a lazy first-access pattern —
  // every namespaced access just dispatches via `callTool`, which
  // round-trips to the server and surfaces a clear error if the tool
  // doesn't exist).
  const plugins: Record<
    string,
    Record<string, (args?: BrowxaiArgs) => Promise<BrowxaiResult>>
  > = new Proxy(
    {},
    {
      get(_target, namespace: string) {
        if (typeof namespace !== "string") return undefined;
        return new Proxy(
          {},
          {
            get(_t2, toolName: string) {
              if (typeof toolName !== "string") return undefined;
              return (args?: BrowxaiArgs): Promise<BrowxaiResult> =>
                // Mirror tool naming: `namespace.tool`. Convert camelCase
                // tool name back to snake_case? No — the SDK uses the
                // tool name as-is. Plugin authors declare e.g.
                // `figma.move_node` AND `figma.moveNode`'s caller hits
                // `figma.moveNode` — so the JS-style access maps 1:1 to
                // whatever the plugin registered. Plugin authors who
                // want snake_case at the wire and camelCase at the JS
                // level can ship a `.d.ts` wrapper (documented).
                callTool(`${namespace}.${toolName}`, args);
            },
          },
        );
      },
    },
  );

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
    exposedTools: exposed,
    capabilities,
    session,
    // namespaced plugin caller (proxy-based; see comment above).
    plugins,
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
