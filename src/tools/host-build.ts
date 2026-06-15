import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertEngineSupports } from "../engine/index.js";
import {
  DEFAULT_SESSION_ID,
  type SessionEntry,
  type SessionRegistry,
} from "../session/registry.js";
import { type DispatchOutcome } from "../session/metrics.js";
import type { RefRegistry } from "../page/refs.js";
import { clampTimeout, withDeadline, DEFAULT_ACTION_TIMEOUT_MS } from "../util/deadline.js";
import { estimateTokens } from "../util/tokens.js";
import type { Workspace } from "../util/workspace.js";
import {
  buildEvalJsCapture,
  redactArgs,
  type DiagnosticsRecorder,
  type DiagnosticsRecord,
} from "../util/diagnostics.js";
import type { ConfigStore, ResolvedConfig } from "../util/config-store.js";
import { type ActionSubstrate } from "../page/action-substrate.js";
import { type CaptureSubstrate } from "../page/capture-substrate.js";
import { type StorageSubstrate } from "../page/storage-substrate.js";
import { type ScriptSubstrate } from "../page/script-substrate.js";
import { type EmulationSubstrate } from "../page/emulation-substrate.js";
import { engineEntry, type SubstrateBundle, type SubstrateDeps } from "../engine/registry.js";
import { EgressSanitiser } from "../util/egress-sanitiser.js";
import { screenshotSave } from "../page/screenshot-save.js";
import type { ActionContext } from "../page/actionresult.js";
import {
  isToolEnabled,
  declareToolCapability,
  toolCapabilityMap,
  type Capability,
  type CapabilityConfig,
  type ConfirmHook,
} from "../util/capabilities.js";
import { declareDeepTool } from "../engine/tool-gate.js";
import type { BrowxConfig } from "../util/config.js";
import type { PluginRecord } from "../plugin/types.js";
import type { OriginPolicy } from "../policy/origin.js";
import type { ApprovalStore } from "../policy/confirm.js";
import type { CredentialProvider, CredentialsConfig } from "../util/credentials.js";
import type { StartOptions } from "../server.js";
import type { ToolHost, ToolRegistration, ToolResponse } from "./host.js";

/** The createServer locals the host's closures close over. Each field is the
 *  exact local `createServer` built before the host literal; the closures move
 *  into `buildHost` verbatim and reach these through `deps`. */
export interface HostDeps {
  /** The raw MCP server — `register` wires each tool onto its surface. */
  server: McpServer;
  /** The in-process handler side-table `register` populates and `batch` dispatches. */
  toolHandlers: Record<string, (args: unknown) => Promise<ToolResponse>>;
  /** The per-session registry — entry lookup + peek for wedge/metrics/diagnostics. */
  registry: SessionRegistry;
  /** Resolved server config (test attributes, timeouts, …). */
  config: BrowxConfig;
  /** Layered config store — the live source for re-resolvable settings. */
  configStore: ConfigStore;
  /** The once-resolved config snapshot taken at server start. */
  resolvedConfig: ResolvedConfig;
  /** Resolved capability policy (active set + warnings). */
  caps: CapabilityConfig;
  /** Confirm-required hooks (origin/byob confirm gating). */
  confirmHooks: ReadonlySet<ConfirmHook>;
  /** Origin allow/blocklist policy. */
  originPolicy: OriginPolicy;
  /** Session-independent pre-approval store. */
  approvals: ApprovalStore;
  /** Whether this server attached to an existing browser (BYOB). */
  isByob: boolean;
  /** Resolved workspace (root dir for file-io-bound captures and archives). */
  workspace: Workspace;
  /** The diagnostics JSONL recorder. */
  diagnostics: DiagnosticsRecorder;
  /** The credentials provider resolved once at server start. */
  credentialsResolved: { provider: CredentialProvider; config: CredentialsConfig };
  /** Live loaded-plugin records — assigned after the host is built; read lazily. */
  pluginRecords: () => ReadonlyArray<PluginRecord>;
  /** The server start options. */
  startOptions: StartOptions;
  /** Structured one-liner alongside an element screenshot. */
  describeTarget: (
    loc: import("playwright-core").Locator,
    refs: RefRegistry,
    target: { ref: string } | { selector: string } | { coords: { x: number; y: number } },
  ) => Promise<string>;
  /** Narrow wire target args to a resolved `ActionTarget`. */
  asTarget: ToolHost["asTarget"];
}

/**
 * The composition heart: assemble the shared helper closures + the `ToolHost`
 * literal `createServer` hands to each `registerXxxTools(host)` module. Every
 * closure body is byte-identical to the inline `createServer` version; the
 * createServer locals they close over arrive through `deps`, and the
 * intra-block references between closures (register → noteWedgeOutcome, the
 * `*For` ports → ctxFor, …) stay as-is because they all move together.
 */
export function buildHost(deps: HostDeps): ToolHost {
  const {
    server,
    toolHandlers,
    registry,
    config,
    configStore,
    resolvedConfig,
    caps,
    confirmHooks,
    originPolicy,
    approvals,
    isByob,
    workspace,
    diagnostics,
    credentialsResolved,
    pluginRecords,
    startOptions,
    describeTarget,
    asTarget,
  } = deps;

  const entryFor = (sessionId?: string): Promise<SessionEntry> =>
    registry.get(sessionId ?? DEFAULT_SESSION_ID);

  const confirmCtxFor = (e: SessionEntry) => ({
    hooks: confirmHooks,
    policy: originPolicy,
    bridge: e.bridge,
    isByob,
    approvals,
  });

  /** Disabled-tool early-return shape. Used at the top of each handler:
   *    const g = gateCheck("foo"); if (g) return g;
   *  Returns null when the tool is enabled (handler proceeds). */
  const gateCheck = (toolName: string) => {
    if (isToolEnabled(toolName, caps)) return null;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              ok: false,
              error: `tool "${toolName}" is disabled — its capability is not in the server's ACTIVE set`,
              requiredCapability: toolCapabilityMap().get(toolName) ?? null,
              activeCapabilities: [...caps.enabled],
              hint: "This tool's capability (`requiredCapability` above) is not in the server's active set. Fix: add it to `BROWX_CAPABILITIES` (or the `capabilities` config), then RESTART the browxai server — capabilities are resolved ONCE at server start, so `set_config` alone won't enable it. Two gotchas if it still doesn't take after a restart: (1) a persisted `set_config({capabilities})` layer REPLACES the BROWX_CAPABILITIES env value entirely (arrays don't merge), so a patch that omits this capability silently overrides the env var — include every capability you want, not just this one; (2) `get_config({scope:\"resolved\"}).capabilities` is the *live enforced* set (what this gate checks). See docs/threat-model.md.",
            },
            null,
            2,
          ),
        },
      ],
    };
  };

  /** Engine-dimension early-return shape — the headline of the multi-engine
   *  work. Composes with `gateCheck` (capability dimension): after the tool's
   *  capability is confirmed active and the session is resolved, this refuses a
   *  CDP-deep tool (audit class B + the live-CDP class-C tools) on an engine
   *  that declares no `deep` escape hatch (firefox), with a structured hint —
   *  the same refusal-with-hint pattern `pdf_save`-on-BYOB uses. Returns null
   *  when the engine supports the tool (the fast path on chromium and for every
   *  cross-browser tool).
   *
   *    const eg = engineGate("perf_start", e); if (eg) return eg;
   */
  const engineGate = (toolName: string, e: SessionEntry) => {
    const refusal = assertEngineSupports(toolName, e.session.engine);
    if (!refusal) return null;
    const body = {
      ok: false,
      error: refusal.error,
      engine: e.session.engine,
      hint: refusal.hint,
    };
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
            null,
            2,
          ),
        },
      ],
    };
  };

  /** Confirm-hook early-return helper. Returns the rejection content if denied, else null. */
  const denyContent = (toolName: string, decision: { reason: string }) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ok: false,
            action: { type: toolName },
            error: `policy: ${decision.reason}`,
            hint: "This is NOT a human-approval wall and NOT a selector failure. As an MCP client, call `approve_actions({ scopes:[…], ttlSeconds })` once at session start to enable action tools for the session (e.g. scopes:[\"byob_action\"]). Alternatives: remove the entry from BROWX_CONFIRM_REQUIRED, or a human responds `true` to the page-side confirm. Don't mark the feature unverified — it's gated, not broken.",
          },
          null,
          2,
        ),
      },
    ],
  });

  /** Reconstruct a `selectorHint` string the recorder can write into a flow file
   *  YAML. Mirrors `buildSelectorHint` for `ref`/`named`; passes through `selector`. */
  const hintFromTarget = (
    e: SessionEntry,
    target: { ref?: string; selector?: string; named?: string; coords?: { x: number; y: number } },
  ): { selectorHint: string; stability?: "high" | "medium" | "low" } | undefined => {
    // Coords targets don't correspond to a stable locator the recorder can replay —
    // skip the hint and let the recording layer omit the step's target metadata.
    if (target.coords) return undefined;
    if (target.selector) return { selectorHint: target.selector };
    let ref = target.ref;
    if (target.named) ref = e.refs.refByNameLookup(target.named);
    if (!ref) return undefined;
    const inputs = e.refs.locatorOf(ref);
    if (!inputs) return undefined;
    if (inputs.testId) {
      const attr = inputs.testIdAttr ?? "data-testid";
      return { selectorHint: `[${attr}="${inputs.testId}"]`, stability: "high" };
    }
    if (inputs.name)
      return { selectorHint: `role=${inputs.role}[name="${inputs.name}"]`, stability: "medium" };
    return { selectorHint: `role=${inputs.role}`, stability: "low" };
  };

  const ctxFor = (e: SessionEntry): ActionContext => ({
    page: e.session.page(),
    // The action window mints its per-action network tap from this substrate
    // by engine capability: chromium → the CDP NetworkTap; firefox/webkit → the
    // Playwright context-event tap. So the envelope's network slice is real on
    // every engine, not just chromium.
    network: e.networkSubstrate,
    snapshot: e.snapshotSubstrate,
    refs: e.refs,
    console: e.console,
    pages: () => e.session.page().context().pages(),
    testAttributes: config.testAttributes,
    originPolicy,
    recorder: e.recorder,
    ws: e.ws,
    dialog: e.dialog,
    permission: e.permission,
    notification: e.notification,
    fsPicker: e.fsPicker,
    // pass the secrets registry only when the capability is on; the
    // registry exists per-session regardless (kept on SessionEntry so
    // setters wired at creation can reference it), but the action layer
    // only consults it when the capability gate is open.
    ...(caps.enabled.has("secrets") ? { secrets: e.secrets } : {}),
    // pass the downloads registry only when `file-io` is on. The registry
    // exists per-session regardless (off-by-default state on SessionEntry),
    // but the action-window only consults it when the capability gate is
    // open so a server without `file-io` can never surface a downloads
    // block.
    ...(caps.enabled.has("file-io") ? { downloads: e.downloads } : {}),
  });

  // The five capability ports (actions / capture / storage / script / emulation)
  // are now folded into the engine's `SubstrateBundle` (RFC 0004 D1): the
  // Safari-vs-Playwright choice each selector used to make inline is the engine's
  // own concern, declared once in its `makeSubstrates(deps)`. The Playwright bundle
  // needs the host config the old `actionsFor`/`captureFor` closures closed over
  // (`ctxFor` for the ActionContext; `describeTarget` + the screenshot `save` sink
  // for capture). These deps close over THIS server's boundary — `ctxFor` carries
  // the server's originPolicy / config.testAttributes / caps gating, `save` writes
  // under the server's `workspace.root` — so the composition root threads its OWN
  // per-server set at the `makeSubstrates(deps)` call site (a closure-owned local,
  // NEVER a module-global, so a second `createServer()` in the same process can
  // never overwrite this server's substrate deps). The five host ports then resolve
  // through the bundle keyed on `e.session.engine`, byte-identical to the pre-fold
  // closures.
  const serverSubstrateDeps: SubstrateDeps = {
    ctxFor,
    describeTarget,
    save: (buf, args) => screenshotSave(buf, workspace.root, args),
  };
  const substratesFor = (e: SessionEntry): SubstrateBundle =>
    engineEntry(e.session.engine).makeSubstrates(serverSubstrateDeps);
  const actionsFor = (e: SessionEntry): ActionSubstrate => substratesFor(e).actions(e);
  const captureFor = (e: SessionEntry): CaptureSubstrate => substratesFor(e).capture(e);
  const storageFor = (e: SessionEntry): StorageSubstrate => substratesFor(e).storage(e);
  const scriptFor = (e: SessionEntry): ScriptSubstrate => substratesFor(e).script(e);
  const emulationFor = (e: SessionEntry): EmulationSubstrate => substratesFor(e).emulation(e);

  // The egress-masking chokepoint (RFC 0004 P3 / D4). The `secrets`-capability
  // decision is made ONCE here: a `secrets`-off server hands every sink a
  // sanitiser holding a null registry (URL-sanitisation still applies; deep/text
  // secrets-masking is a no-op) — byte-identical to the prior per-sink
  // `caps.enabled.has("secrets") ? e.secrets.applyMaskDeep(x) : x` hand-call.
  const egressFor = (e: SessionEntry): EgressSanitiser =>
    new EgressSanitiser(caps.enabled.has("secrets") ? e.secrets : null);

  // resolve the effective anti-wedge deadline for a call —
  // per-call `timeoutMs` over config `actionTimeoutMs` over the 5000 default,
  // clamped to [1, 3_600_000]. `warning` is non-empty when the caller asked
  // for an over-ceiling (insane) value.
  const cfgActionTimeout = (): number => {
    const v = configStore.resolve().actionTimeoutMs;
    return typeof v === "number" && v > 0 ? v : DEFAULT_ACTION_TIMEOUT_MS;
  };
  const actionTimeout = (args: { timeoutMs?: number }): { ms: number; warning?: string } =>
    clampTimeout(args.timeoutMs, cfgActionTimeout());

  // Wedge tracking. Only tools that actually exercise the page can
  // wedge a session; session-management / config / coordination tools are
  // excluded so their (always fast) results don't reset the streak.
  const WEDGE_TRACKED_CAPABILITIES = new Set<string>([
    "read",
    "navigation",
    "action",
    "eval",
    "network-body",
    "file-io",
  ]);
  /** First text item of a result, parsed as a JSON object — or null when the
   *  result has no leading JSON object (a plain-text snapshot, an image). */
  const firstJsonResult = (
    res: ToolResponse,
  ): { obj: Record<string, unknown>; idx: number } | null => {
    for (let i = 0; i < res.content.length; i++) {
      const item = res.content[i];
      if (item && item.type === "text") {
        try {
          const parsed: unknown = JSON.parse(item.text);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return { obj: parsed as Record<string, unknown>, idx: i };
          }
        } catch {
          /* not JSON — a plain-text result, e.g. a snapshot tree */
        }
        return null;
      }
    }
    return null;
  };
  /** Update the session's wedge counter from a tool result and, once the
   *  session is wedged, splice `sessionWedged` + a recovery hint onto it.
   *  An anti-wedge timeout increments the streak; any responsive result
   *  (success, or a fast non-timeout error) clears it.
   *
   *  Before stamping `sessionWedged: true`, the threshold-trip path probes
   *  the page with a 1s `evaluate(() => 1)` — if the page answers, the
   *  session is alive (the timeouts were action-shaped, not page-shaped:
   *  perpetually-busy SPAs hold WS keepalives / rAF loops that prevent
   *  Playwright actionability from settling, but the page itself responds
   *  fine to evaluate). A successful probe clears the streak instead of
   *  falsely tipping the caller into a session-discard. */
  const noteWedgeOutcome = async (args: unknown, res: ToolResponse): Promise<ToolResponse> => {
    const sessionId = (args as { session?: string } | undefined)?.session ?? DEFAULT_SESSION_ID;
    const entry = registry.peek(sessionId);
    if (!entry) return res;
    const parsed = firstJsonResult(res);
    const timedOut =
      !!parsed &&
      parsed.obj.ok === false &&
      typeof parsed.obj.error === "string" &&
      /anti-wedge timeout/i.test(parsed.obj.error);
    if (!timedOut || !parsed) {
      entry.wedge.recordResponsive();
      return res;
    }
    entry.wedge.recordTimeout();
    if (!entry.wedge.wedged()) return res;
    // Threshold tripped — confirm before stamping. Cheap liveness probe:
    // if the page answers evaluate() within 1s, the session is alive and
    // the timeouts were action-shaped (e.g. busy SPA blocks click
    // actionability). Clear the streak rather than falsely wedge the
    // caller. If the probe fails or times out, the session genuinely is
    // wedged — stamp the response as before.
    let aliveByProbe = false;
    try {
      const page = entry.session.page();
      await withDeadline(
        page.evaluate(() => 1),
        1_000,
        "wedge_probe",
      );
      aliveByProbe = true;
    } catch {
      aliveByProbe = false;
    }
    if (aliveByProbe) {
      entry.wedge.recordResponsive();
      return res;
    }
    const obj = { ...parsed.obj, sessionWedged: true, sessionWedgedHint: entry.wedge.hint() };
    return {
      content: res.content.map((item, i) =>
        i === parsed.idx ? { type: "text" as const, text: JSON.stringify(obj, null, 2) } : item,
      ),
    };
  };

  // Classify a dispatched tool result for the per-session metrics
  // counter. We piggyback on `firstJsonResult` (already defined above) so we
  // don't pay a second parse. A capability-denied result is the JSON shape the
  // `gateCheck` helper emits (carries `requiredCapability`); any other
  // `ok:false` result is an error; everything else is `ok`. The
  // `tokensEstimate` field is read straight off the envelope when present —
  // most tools surface it via the standard helper, but image-only / non-JSON
  // results legitimately don't and that's fine (treated as 0).
  const classifyOutcome = (
    res: ToolResponse,
  ): { outcome: DispatchOutcome; tokensEstimate?: number } => {
    const parsed = firstJsonResult(res);
    if (!parsed) return { outcome: "ok" };
    const obj = parsed.obj;
    const tokens = typeof obj.tokensEstimate === "number" ? obj.tokensEstimate : undefined;
    if (obj.ok === false) {
      // Capability-denied shape (see `gateCheck`): carries `requiredCapability`.
      // The denial path is a config-shape signal, not a tool-error signal —
      // bucket it separately.
      if (Object.prototype.hasOwnProperty.call(obj, "requiredCapability")) {
        return { outcome: "denied", tokensEstimate: tokens };
      }
      return { outcome: "error", tokensEstimate: tokens };
    }
    return { outcome: "ok", tokensEstimate: tokens };
  };

  /** Record one dispatch on the session's metrics counter — peek-only on the
   *  registry. Calls against a not-yet-open session (e.g. a capability denial
   *  fired before the lazy session creation) are silently skipped: there's no
   *  SessionEntry to accumulate against, and the denial is still visible at the
   *  capability layer. Same posture as `noteWedgeOutcome` above. */
  const noteMetrics = (
    toolName: string,
    args: unknown,
    res: ToolResponse,
    startedAt: number,
  ): void => {
    const sessionId = (args as { session?: string } | undefined)?.session ?? DEFAULT_SESSION_ID;
    const entry = registry.peek(sessionId);
    if (!entry) return;
    const { outcome, tokensEstimate } = classifyOutcome(res);
    entry.metrics.record(toolName, outcome, Date.now() - startedAt, tokensEstimate);
  };

  /** Record one dispatched call into the diagnostics JSONL store. No-op when
   *  the diagnostics capability is OFF — the caller short-circuits on
   *  `diagnostics.enabled` BEFORE allocating anything. The recorder runs
   *  DOWNSTREAM of the URL sanitiser + secrets-masking chokepoint:
   *  by the time `res` lands here, every egress sink has already rewritten
   *  registered secret values back to `<NAME>` aliases. Args are additionally
   *  walked through `applyMaskDeep` so a secret echoed in the call args
   *  never reaches the JSONL raw. */
  const noteDiagnostics = (
    toolName: string,
    args: unknown,
    res: ToolResponse,
    startedAt: number,
  ): void => {
    if (!diagnostics.enabled) return;
    const sessionId = (args as { session?: string } | undefined)?.session ?? DEFAULT_SESSION_ID;
    const entry = registry.peek(sessionId);
    // Apply the per-session secrets mask to args BEFORE structural redaction
    // so a registered secret value echoed in the call args never lands raw
    // in the JSONL store.
    const maskedArgsIn = entry?.secrets ? entry.secrets.applyMaskDeep(args) : args;
    const parsed = firstJsonResult(res);
    const sizeBytes = res.content.reduce((n, item) => {
      if (item.type === "text") return n + Buffer.byteLength(item.text, "utf8");
      if (item.type === "image") return n + (typeof item.data === "string" ? item.data.length : 0);
      return n;
    }, 0);
    const obj = parsed?.obj ?? null;
    const ok = obj ? obj.ok !== false : true;
    const warningsCount = obj && Array.isArray(obj.warnings) ? obj.warnings.length : 0;
    let failureKind: string | undefined;
    if (!ok && obj) {
      if (Object.prototype.hasOwnProperty.call(obj, "requiredCapability")) {
        failureKind = "capability-denied";
        diagnostics.noteDenial();
      } else {
        const err = typeof obj.error === "string" ? obj.error : "";
        if (/anti-wedge timeout/i.test(err)) failureKind = "timeout";
        else if (/not found|no element matches|ref not found|locator did not resolve/i.test(err))
          failureKind = "target-not-found";
        else if (/must |invalid |unknown |expected /i.test(err)) failureKind = "bad-arg";
        else failureKind = "internal";
      }
    }
    const record: DiagnosticsRecord = {
      kind: "call",
      ts: new Date(startedAt).toISOString(),
      tool: toolName,
      sessionId,
      argsRedacted: redactArgs(maskedArgsIn),
      resultMeta: {
        ok,
        sizeBytes,
        warningsCount,
        ...(failureKind ? { failureKind } : {}),
      },
      durationMs: Date.now() - startedAt,
      capabilityDenials: diagnostics.denialsCount(),
    };
    const evalCap = buildEvalJsCapture(toolName, maskedArgsIn, obj);
    if (evalCap) record.evalJs = evalCap;
    diagnostics.write(record);
  };

  // Wrapper that preserves the inner handler's parameter type for typechecking
  // (destructuring inside each registration still works) but stores a
  // type-erased copy for `batch` dispatch. Page-exercising tools additionally
  // route their result through the wedge tracker; every tool is timed +
  // counted on the session's per-session metrics rollup. When the
  // `diagnostics` capability is on, each dispatch ALSO lands as a JSONL
  // record under $BROWX_WORKSPACE/diagnostics/<sessionId>/<ISO>.jsonl;
  // when off, the recorder is a zero-overhead gate check (no allocations,
  // no file IO).
  // Derived (RFC 0004 P2). Both are populated by `register` from the colocated
  // `{ batchable }` / `{ capability, deep, inputSchema }` metadata each tool
  // declares, so a tool's batchability, capability, deepness, and SDK type all
  // trace back to its one registration call. `BATCH_ALLOWED_TOOLS` replaces the
  // hand-maintained 71-entry literal; `await_human`, `batch`, the recording
  // controls and the config mutators simply never declare `{ batchable: true }`,
  // so they are excluded by construction rather than by an omission a human had
  // to remember. The host exposes the batch set via `batchAllowedTools` and the
  // full registration table via `registrations` (read by the SDK tool-types
  // codegen, D7).
  const BATCH_ALLOWED_TOOLS = new Set<string>();
  const registrations = new Map<string, ToolRegistration>();

  const register = <S extends z.ZodRawShape = Record<string, never>>(
    name: string,
    def: {
      description: string;
      inputSchema?: S;
      capability?: Capability;
      batchable?: boolean;
      deep?: boolean;
    },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResponse>,
  ): void => {
    // Colocated metadata → derived central maps (RFC 0004 P2 / D2). The
    // capability/deep facts feed the lower-layer registries; `batchable` feeds the
    // local batch allow-set; the whole record (incl. the zod schema) is kept for
    // the SDK tool-types codegen (D7). The capability gate then reads `TOOL_CAPABILITY`
    // (now derived from these declarations), so the assignment lives only here.
    if (def.capability !== undefined) declareToolCapability(name, def.capability);
    if (def.deep) declareDeepTool(name);
    if (def.batchable) BATCH_ALLOWED_TOOLS.add(name);
    registrations.set(name, {
      description: def.description,
      inputSchema: def.inputSchema,
      capability: def.capability,
      batchable: def.batchable,
      deep: def.deep,
    });
    const tracked = WEDGE_TRACKED_CAPABILITIES.has(def.capability ?? "");
    const wrapped = async (rawArgs: unknown): Promise<ToolResponse> => {
      // MCP-wire boundary: the SDK parses + validates the inbound payload against
      // this tool's `inputSchema` before dispatch, so the dispatched value IS the
      // handler's declared arg shape. This is the one place that boundary narrows.
      const args = rawArgs as z.infer<z.ZodObject<S>>;
      const startedAt = Date.now();
      const inner = tracked
        ? await noteWedgeOutcome(args, await handler(args))
        : await handler(args);
      noteMetrics(name, args, inner, startedAt);
      noteDiagnostics(name, args, inner, startedAt);
      return inner;
    };
    toolHandlers[name] = wrapped;
    // The SDK's `registerTool` generic cannot relate its conditional-typed
    // callback to a still-generic `S`; widening the config's schema to a concrete
    // `ZodRawShape` lets that conditional resolve, so `wrapped` (whose args are
    // narrowed at the wire boundary above and whose result is a CallToolResult)
    // matches with no assertion.
    const sdkConfig: { description: string; inputSchema?: z.ZodRawShape } = def;
    server.registerTool(name, sdkConfig, wrapped);
  };

  // ---------- action tools ----------

  const asActionResultText = async (p: Promise<unknown>) => {
    const r = await p;
    return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
  };

  /** JSON envelope for the non-action families: stringify with `tokensEstimate`. */
  const okText = (
    body: Record<string, unknown>,
  ): { content: Array<{ type: "text"; text: string }> } => {
    const json = JSON.stringify(body);
    const tokensEstimate = estimateTokens(json);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
      ],
    };
  };
  /** Same shape for an `ok:false` rejection so callers see a uniform envelope. */
  const errText = (
    tool: string,
    err: unknown,
  ): { content: Array<{ type: "text"; text: string }> } =>
    okText({ ok: false, tool, error: err instanceof Error ? err.message : String(err) });

  // The composition seam: bundle the shared state + helper closures into one
  // host and hand it to each per-family tool module. createServer stays the
  // registry composition root; the register() blocks live under src/tools/.
  const host: ToolHost = {
    register,
    entryFor,
    gateCheck,
    engineGate,
    confirmCtxFor,
    ctxFor,
    workspace,
    denyContent,
    asActionResultText,
    okText,
    errText,
    asTarget,
    hintFromTarget,
    actionTimeout,
    cfgActionTimeout,
    actionsFor,
    captureFor,
    storageFor,
    scriptFor,
    emulationFor,
    egressFor,
    caps,
    config,
    configStore,
    resolvedConfig,
    startOptions,
    z,
    toolHandlers,
    batchAllowedTools: BATCH_ALLOWED_TOOLS,
    registrations,
    registry,
    diagnostics,
    approvals,
    credentialsResolved,
    noteMetrics,
    noteDiagnostics,
    // `pluginRecords` is assigned after the host literal is built (plugin
    // runtime starts later); expose it lazily so get_config sees the live set.
    get pluginRecords() {
      return pluginRecords();
    },
  };

  return host;
}
