import type { z } from "zod";

import type { SessionEntry, SessionRegistry } from "../session/registry.js";
import type { DiagnosticsRecorder } from "../util/diagnostics.js";
import type { RefRegistry } from "../page/refs.js";
import type { ActionContext } from "../page/actionresult.js";
import type { Workspace } from "../util/workspace.js";
import type { CapabilityConfig } from "../util/capabilities.js";
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
 * The composition seam between `createServer` (the registry composition root)
 * and the per-family tool modules under `src/tools/`. `createServer` builds the
 * shared state and helper closures once, bundles them into a single `ToolHost`,
 * and hands that host to each `registerXxxTools(host)` module. The modules own
 * the `register()` blocks; the host owns the closures those blocks need.
 *
 * Members are exposed at the granularity handlers consume them — a handler asks
 * the host for exactly the closure it calls and nothing else.
 */
export interface ToolHost {
  /** Register one MCP tool: wires it into the server surface and the in-process
   *  handler side-table. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register: <H extends (...a: any[]) => Promise<ToolResponse>>(
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    def: { description: string; inputSchema?: any },
    handler: H,
  ) => void;

  /** Resolve a session entry by id (defaulting to the default session). */
  entryFor: (sessionId?: string) => Promise<SessionEntry>;

  /** Capability-dimension early return: disabled-tool refusal content, or null
   *  when the tool is enabled. */
  gateCheck: (toolName: string) => ToolResponse | null;

  /** Engine-dimension early return: unsupported-engine refusal content, or null
   *  when the engine supports the tool. */
  engineGate: (toolName: string, e: SessionEntry) => ToolResponse | null;

  /** Build the confirm-hook context for a session entry. */
  confirmCtxFor: (e: SessionEntry) => ConfirmContext;

  /** Build the action/observe context for a session entry (page + substrates +
   *  per-session buffers + policies), as the read/observe + compound tools need. */
  ctxFor: (e: SessionEntry) => ActionContext;

  /** Resolved workspace (root dir for file-io-bound captures and archives). */
  workspace: Workspace;

  /** Confirm-hook rejection content for a denied decision. */
  denyContent: (toolName: string, decision: { reason: string }) => ToolResponse;

  /** Wrap an ActionResult promise as the standard `{ content: [text] }` envelope. */
  asActionResultText: (p: Promise<unknown>) => Promise<ToolResponse>;

  /** JSON envelope builder for the non-action (JSON-returning) families: stringify
   *  the body with an appended `tokensEstimate`. Every such family — storage,
   *  cookies, auth, caches, … — returns through this so callers see one shape. */
  okText: (body: Record<string, unknown>) => ToolResponse;

  /** The `ok:false` rejection counterpart of `okText`, same envelope shape. */
  errText: (tool: string, err: unknown) => ToolResponse;

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

  /** The capture capability port for a session (engine-selected). */
  captureFor: (e: SessionEntry) => CaptureSubstrate;

  /** The storage capability port for a session (engine-selected). */
  storageFor: (e: SessionEntry) => StorageSubstrate;

  /** The script capability port for a session (engine-selected). */
  scriptFor: (e: SessionEntry) => ScriptSubstrate;

  /** The live-emulation capability port for a session (engine-selected). */
  emulationFor: (e: SessionEntry) => EmulationSubstrate;

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

  /** zod, so tool modules build their input schemas with the same instance the
   *  composition root uses. */
  z: typeof z;

  /** The in-process handler side-table — the compound tools (act_and_wait_for_network,
   *  …) dispatch an inner tool by name through this rather than re-implementing it. */
  toolHandlers: Record<string, (args: unknown) => Promise<ToolResponse>>;

  /** The batch whitelist — the set of tool names a compound/batch tool may dispatch
   *  to. Read lazily so the host can expose it before the set is populated. */
  readonly batchAllowedTools: ReadonlySet<string>;

  /** The session registry — the live source of truth for which sessions are open
   *  (the QA-evidence report bundles its `list()`). */
  registry: SessionRegistry;

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
}
