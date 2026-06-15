import type { z } from "zod";

import type { Capability, CapabilityConfig } from "../util/capabilities.js";
import type { SessionEntry, SessionRegistry } from "../session/registry.js";
import type { DiagnosticsRecorder } from "../util/diagnostics.js";
import type { RefRegistry } from "../page/refs.js";
import type { ActionContext } from "../page/actionresult.js";
import type { Workspace } from "../util/workspace.js";
import type { BrowxConfig } from "../util/config.js";
import type { ConfigStore, ResolvedConfig } from "../util/config-store.js";
import type { StartOptions } from "../server.js";
import type { ConfirmContext, ApprovalStore } from "../policy/confirm.js";
import type { CredentialProvider, CredentialsConfig } from "../util/credentials.js";
import type { PluginRecord } from "../plugin/types.js";
import type { ActionSubstrate } from "../page/action-substrate.js";
import type { CaptureSubstrate } from "../page/capture-substrate.js";
import type { StorageSubstrate } from "../page/storage-substrate.js";
import type { ScriptSubstrate } from "../page/script-substrate.js";
import type { EmulationSubstrate } from "../page/emulation-substrate.js";
import type { EgressSanitiser } from "../util/egress-sanitiser.js";

/** The MCP content shape every registered handler returns — the same `{ content }`
 *  envelope an over-the-wire MCP call produces. Shared with `createServer` so the
 *  composition root and the extracted tool modules speak one type. */
export type TextItem = { type: "text"; text: string };
export type ImageItem = { type: "image"; data: string; mimeType: string };
export type ToolResponse = { content: Array<TextItem | ImageItem> };

/** A target as the action tools accept it on the wire (ref / selector / named /
 *  coords), before `asTarget` narrows it to the substrate's `ActionTarget`. */
export interface RawTargetArgs {
  ref?: string;
  selector?: string;
  named?: string;
  contextRef?: string;
  coords?: { x: number; y: number };
}

/** The narrowed target `asTarget` produces. */
export type ResolvedTarget =
  | { ref: string }
  | { selector: string; contextRef?: string }
  | { coords: { x: number; y: number } };

/**
 * The gating metadata a tool declares inline at its `host.register` call
 * (RFC 0004 P2 / D2). Colocating these facts with the tool makes the three
 * central maps DERIVABLE rather than hand-maintained:
 *   - `capability` → the `TOOL_CAPABILITY` row (replaces `util/capabilities.ts`)
 *   - `batchable`  → membership in the batch allow-set (replaces the host-build `Set`)
 *   - `deep`       → membership in `DEEP_TOOLS` (replaces `engine/tool-gate.ts`)
 * The single source of truth becomes the registration call; the maps iterate the
 * registrations at startup. A tool that omits `capability` is treated as the
 * `human` coordination default (the control-plane primitives that legitimately
 * carry no browser capability — open_session, batch, get_config, …).
 */
export interface ToolMeta {
  /** The capability that gates this tool. Omit only for a control-plane
   *  coordination primitive that defaults to `human`. */
  capability?: Capability;
  /** May a compound/batch tool dispatch to this tool? Replaces batch-set membership. */
  batchable?: boolean;
  /** Needs the raw-CDP escape hatch — refused on engines that declare `deep:false`.
   *  Replaces `DEEP_TOOLS` membership. */
  deep?: boolean;
}

/** One tool's accumulated registration record — its `ToolMeta` plus the
 *  description and zod input schema the `register` call carried. The host stores
 *  these so the central maps and the SDK tool-types codegen (RFC 0004 D7) derive
 *  from one place. The schema is type-erased to `z.ZodRawShape` (the codegen reads
 *  it structurally; the per-handler generic relation is enforced at the call site). */
export interface ToolRegistration extends ToolMeta {
  description: string;
  inputSchema?: z.ZodRawShape;
}

/**
 * The composition seam between `createServer` (the registry composition root)
 * and the per-family tool modules under `src/tools/`. `createServer` builds the
 * shared state and helper closures once, bundles them into a single `ToolHost`,
 * and hands that host to each `registerXxxTools(host)` module. The modules own
 * the `register()` blocks; the host owns the closures those blocks need.
 *
 * Members are exposed at the granularity handlers consume them — a handler asks
 * the host for exactly the closure it calls and nothing else.
 */
/**
 * RFC 0004 P3 / D3 (ISP). `ToolHost` is segregated into composable sub-ports a
 * handler depends on à la carte. The 35 members already clustered by role in the
 * source — gating, session resolution, action dispatch, the five engine-selected
 * substrate ports, envelope builders, config, server services — so this is a
 * REGROUPING, not a redesign. `ToolHost` stays as their INTERSECTION (declared at
 * the bottom): the composition root keeps building one object that satisfies all
 * of them, and a handler's signature may narrow to its slice (e.g.
 * `registerActionTools(host: RegisterHost & GateHost & SessionHost & ActionHost)`)
 * so the function signature compiles a guarantee of what it touches. Per
 * 0004-03 §3.
 */

/** Tool registration + the derived registration surface. Every function that
 *  wires a tool depends on this role. */
export interface RegisterHost {
  /** Register one MCP tool: wires it into the server surface and the in-process
   *  handler side-table. The handler's `args` are typed from the tool's own zod
   *  `inputSchema` (the exact shape the MCP SDK parses and validates the wire
   *  payload into before dispatch), so a handler reads a precise object, never
   *  `any`. Tools with no `inputSchema` receive an empty object. */
  register: <S extends z.ZodRawShape = Record<string, never>>(
    name: string,
    def: {
      description: string;
      inputSchema?: S;
      /** The capability that gates this tool — derived into `TOOL_CAPABILITY`
       *  (RFC 0004 P2). Omit only for a `human` control-plane primitive. */
      capability?: Capability;
      /** Whether a compound/batch tool may dispatch to this tool — derived into
       *  the batch allow-set. */
      batchable?: boolean;
      /** Whether the tool needs the raw-CDP escape hatch — derived into
       *  `DEEP_TOOLS`, refused on engines that declare `deep:false`. */
      deep?: boolean;
    },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResponse>,
  ) => void;

  /** The batch whitelist — the set of tool names a compound/batch tool may dispatch
   *  to. Read lazily so the host can expose it before the set is populated. Derived
   *  (RFC 0004 P2) from each `register({ batchable: true })` call. */
  readonly batchAllowedTools: ReadonlySet<string>;

  /** The accumulated per-tool registration metadata (RFC 0004 P2 / D2 + D7): the
   *  `ToolMeta` each `register` call declared, plus the tool's zod `inputSchema`
   *  (the source the SDK tool-types codegen reads). Keyed by tool name, populated
   *  as each `registerXxxTools(host)` module runs. */
  readonly registrations: ReadonlyMap<string, ToolRegistration>;
}

/** Capability/engine gating + denial envelopes. */
export interface GateHost {
  /** Capability-dimension early return: disabled-tool refusal content, or null
   *  when the tool is enabled. */
  gateCheck: (toolName: string) => ToolResponse | null;

  /** Engine-dimension early return: unsupported-engine refusal content, or null
   *  when the engine supports the tool. */
  engineGate: (toolName: string, e: SessionEntry) => ToolResponse | null;

  /** Confirm-hook rejection content for a denied decision. */
  denyContent: (toolName: string, decision: { reason: string }) => ToolResponse;
}

/** Session resolution + the per-session contexts a handler builds. */
export interface SessionHost {
  /** Resolve a session entry by id (defaulting to the default session). */
  entryFor: (sessionId?: string) => Promise<SessionEntry>;

  /** Build the confirm-hook context for a session entry. */
  confirmCtxFor: (e: SessionEntry) => ConfirmContext;

  /** Build the action/observe context for a session entry (page + substrates +
   *  per-session buffers + policies), as the read/observe + compound tools need. */
  ctxFor: (e: SessionEntry) => ActionContext;

  /** The session registry — the live source of truth for which sessions are open
   *  (the QA-evidence report bundles its `list()`). */
  registry: SessionRegistry;
}

/** Action dispatch: targets, deadlines, the engine-selected action port, envelopes. */
export interface ActionHost {
  /** Narrow wire target args to a resolved `ActionTarget`; throws on ambiguity /
   *  unbound name / missing target. */
  asTarget: (args: RawTargetArgs, toolName: string, refs: RefRegistry) => ResolvedTarget;

  /** Reconstruct the recorder `selectorHint` for a resolved target. */
  hintFromTarget: (
    e: SessionEntry,
    target: RawTargetArgs,
  ) => { selectorHint: string; stability?: "high" | "medium" | "low" } | undefined;

  /** Resolve a call's effective anti-wedge deadline (per-call over config over default). */
  actionTimeout: (args: { timeoutMs?: number }) => { ms: number; warning?: string };

  /** The effective config action-timeout, for tools without a per-call override. */
  cfgActionTimeout: () => number;

  /** The action capability port for a session (engine-selected). */
  actionsFor: (e: SessionEntry) => ActionSubstrate;

  /** Wrap an ActionResult promise as the standard `{ content: [text] }` envelope. */
  asActionResultText: (p: Promise<unknown>) => Promise<ToolResponse>;
}

/** The capture capability port. */
export interface CaptureHost {
  /** The capture capability port for a session (engine-selected). */
  captureFor: (e: SessionEntry) => CaptureSubstrate;
}

/** The storage capability port. */
export interface StorageHost {
  /** The storage capability port for a session (engine-selected). */
  storageFor: (e: SessionEntry) => StorageSubstrate;
}

/** The script (page-eval) capability port. */
export interface ScriptHost {
  /** The script capability port for a session (engine-selected). */
  scriptFor: (e: SessionEntry) => ScriptSubstrate;
}

/** The live-emulation capability port. */
export interface EmulationHost {
  /** The live-emulation capability port for a session (engine-selected). */
  emulationFor: (e: SessionEntry) => EmulationSubstrate;
}

/** The egress-masking chokepoint (RFC 0004 P3 / D4). A family that returns
 *  page-derived text/JSON masks it through the injected `EgressSanitiser` instead
 *  of hand-calling `caps.enabled.has("secrets") ? e.secrets.applyMaskDeep(x) : x`.
 *  The capability decision is made ONCE here (the sanitiser holds a null registry
 *  when `secrets` is off), so a sink no longer inlines the gate. */
export interface EgressHost {
  /** The egress sanitiser for a session: `EgressSanitiser(e.secrets)` when the
   *  `secrets` capability is on, else `EgressSanitiser(null)`. `maskDeep` /
   *  `maskText` / `containsAnySecret` are byte-identical to the prior hand-calls. */
  egressFor: (e: SessionEntry) => EgressSanitiser;
}

/** JSON / ActionResult envelope builders shared by every JSON-returning family. */
export interface EnvelopeHost {
  /** JSON envelope builder for the non-action (JSON-returning) families: stringify
   *  the body with an appended `tokensEstimate`. Every such family — storage,
   *  cookies, auth, caches, … — returns through this so callers see one shape. */
  okText: (body: Record<string, unknown>) => ToolResponse;

  /** The `ok:false` rejection counterpart of `okText`, same envelope shape. */
  errText: (tool: string, err: unknown) => ToolResponse;
}

/** Resolved config, capabilities, and the workspace root the tools read. */
export interface ConfigHost {
  /** Resolved workspace (root dir for file-io-bound captures and archives). */
  workspace: Workspace;

  /** Resolved capability policy (active set + warnings). */
  caps: CapabilityConfig;

  /** Resolved server config (test attributes, timeouts, …). */
  config: BrowxConfig;

  /** Layered config store — the live source for re-resolvable settings. */
  configStore: ConfigStore;

  /** The once-resolved config snapshot taken at server start — the
   *  extension-rebuild path reads creation-time launch defaults (headless,
   *  device, viewport) from it. */
  resolvedConfig: ResolvedConfig;

  /** The server start options — the extension-rebuild path reads the
   *  operator's `headless` override from them. */
  startOptions: StartOptions;
}

/** Server-scoped services the tool families dispatch through: zod, the in-process
 *  handler table, the diagnostics/approvals/credentials stores, the loaded-plugin
 *  records, and the per-call metrics/diagnostics hooks. */
export interface ServerServicesHost {
  /** zod, so tool modules build their input schemas with the same instance the
   *  composition root uses. */
  z: typeof z;

  /** The in-process handler side-table — the compound tools (act_and_wait_for_network,
   *  …) dispatch an inner tool by name through this rather than re-implementing it. */
  toolHandlers: Record<string, (args: unknown) => Promise<ToolResponse>>;

  /** The diagnostics JSONL recorder — the note/search/report family reads and
   *  writes the agent-feedback store through it. */
  diagnostics: DiagnosticsRecorder;

  /** The session-independent pre-approval store — the approve_actions /
   *  list_approvals tools grant and list confirm-scope pre-approvals through it. */
  approvals: ApprovalStore;

  /** The credentials provider resolved once at server start — the get_totp /
   *  get_credential tools shell out through it (off-by-default `credentials`). */
  credentialsResolved: { provider: CredentialProvider; config: CredentialsConfig };

  /** The loaded-plugin records — get_config reports the live enabled-plugin set
   *  from them. A getter: the records are assigned after the host is built. */
  readonly pluginRecords: ReadonlyArray<PluginRecord>;

  /** Record one dispatch on the session's metrics counter — the plugin runtime
   *  reuses it so plugin-tool calls roll up into the same per-session metrics. */
  noteMetrics: (toolName: string, args: unknown, res: ToolResponse, startedAt: number) => void;

  /** Record one dispatched call into the diagnostics JSONL store — the plugin
   *  runtime reuses it so plugin-tool calls land in the same store. */
  noteDiagnostics: (toolName: string, args: unknown, res: ToolResponse, startedAt: number) => void;
}

/** The full host the composition root assembles — the INTERSECTION of every
 *  sub-port. `buildHost` returns one object that satisfies all of them; a handler
 *  may type its `host` parameter to the narrower slice it actually calls. */
export interface ToolHost
  extends RegisterHost,
    GateHost,
    SessionHost,
    ActionHost,
    CaptureHost,
    StorageHost,
    ScriptHost,
    EmulationHost,
    EgressHost,
    EnvelopeHost,
    ConfigHost,
    ServerServicesHost {}
