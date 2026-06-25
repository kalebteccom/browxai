// Capability toggles —  security model. See `docs/threat-model.md` for the
// full design. The gist:
//
//   - Tools group into coarse categories (`read`, `navigation`, `action`, `human`,
//     `eval`, `byob-attach`, `file-io`). Each is independently enable/disable-able at
//     server start.
//   - Default set: read + navigation + action + human. `eval` / `byob-attach` /
//     `file-io` are off-by-default — opt in via `BROWX_CAPABILITIES`.
//   - The server's startup log lists the active set; `browxai doctor` warns when
//     dangerous capabilities are on (`eval`, `byob-attach`).
//
// Configuring:
//   BROWX_CAPABILITIES=read,navigation,action,human            # the default
//   BROWX_CAPABILITIES=read                                    # read-only server
//   BROWX_CAPABILITIES=read,navigation,action,human,eval       # opts in to eval_js

export type Capability =
  | "read"
  | "navigation"
  | "action"
  | "human"
  | "eval"
  | "byob-attach"
  | "file-io"
  | "network-body"
  | "clipboard"
  | "secrets"
  | "extensions"
  | "stealth"
  | "captcha"
  | "credentials"
  | "device-emulation"
  | "diagnostics"
  | "canvas";

export const ALL_CAPABILITIES: readonly Capability[] = [
  "read",
  "navigation",
  "action",
  "human",
  "eval",
  "byob-attach",
  "file-io",
  "network-body",
  "clipboard",
  "secrets",
  "extensions",
  "stealth",
  "captcha",
  "credentials",
  "device-emulation",
  "diagnostics",
  "canvas",
];

export const DEFAULT_CAPABILITIES: readonly Capability[] = [
  "read",
  "navigation",
  "action",
  "human",
];

/**
 * Capabilities that USED to be valid and have since been retired. A retired
 * capability is still ACCEPTED in `BROWX_CAPABILITIES` (and the `capabilities`
 * config key) — it is ignored with a deprecation warning, never an error — so
 * evolving the capability set can't crash an existing adopter's config.
 * Genuine typos (a name that was never a capability) are still rejected loudly.
 * A retired entry may be dropped entirely only in a major version bump.
 * See the "API evolution" rule in CLAUDE.md.
 *
 * The value is the agent/operator-facing reason + what to do instead.
 */
export const RETIRED_CAPABILITIES: Readonly<Record<string, string>> = {
  unstable:
    "the tools it gated (gestures, route mocking, compound act-and-observe " +
    "tools, visual regions, profile snapshot/restore) were promoted into the " +
    "default stable surface — it no longer gates anything; drop it from " +
    "BROWX_CAPABILITIES",
};

/**
 * The per-tool capability assignment is DERIVED (RFC 0004 P2 / D2): it lives at
 * each tool's `host.register({ capability })` call (the single source of truth,
 * src/tools/host.ts), not in a hand-maintained list here. This module owns the
 * closed *vocabulary* (`Capability` / `ALL_CAPABILITIES` above); the per-tool
 * rows are populated from the registration metadata via `declareToolCapability`,
 * collected once by the tools-layer bootstrap (`src/tools/tool-metadata.ts`).
 *
 * A tool with no declared capability is treated as `human` (coordination
 * primitive, always safe) — the same permissive default as before, now reachable
 * only for the control-plane primitives that legitimately carry no browser
 * capability (open_session, batch, get_config, …), never by a silent omission
 * (the completeness fitness test asserts every browser tool declares one).
 */
const TOOL_CAPABILITY_MAP = new Map<string, Capability>();

/** Record one tool's capability assignment from its colocated
 *  `host.register({ capability })` metadata (RFC 0004 P2). Idempotent for an
 *  identical re-declaration; a *conflicting* one throws (two registrations cannot
 *  disagree on one tool's gate). The only writer of the derived map. */
export function declareToolCapability(tool: string, capability: Capability): void {
  const existing = TOOL_CAPABILITY_MAP.get(tool);
  if (existing !== undefined && existing !== capability) {
    throw new Error(
      `declareToolCapability: "${tool}" already declared as "${existing}", got "${capability}"`,
    );
  }
  TOOL_CAPABILITY_MAP.set(tool, capability);
}

/** Lazy-collection seam (RFC 0004 P2). The tools layer installs a collector that
 *  runs the registration metadata once and populates the derived maps;
 *  `capabilities.ts` (a leaf) cannot import the tools layer, so the dependency is
 *  inverted through this setter. Every real entry point (`createServer`, the SDK
 *  client, the CLI, the package entry) reaches the tools-layer bootstrap, which
 *  installs the collector AND eagerly populates the map — so in production a gate
 *  read always sees the full derived rows. */
let toolMetadataCollector: (() => void) | undefined;
let toolMetadataLoaded = false;
/** True while the collector is mid-run. A re-entrant read during collection (the
 *  collector's own `resolveCapabilities`/`buildHost` path touches the gate) must
 *  tolerate the partially-populated map WITHOUT tripping the fail-safe — the
 *  collector is installed and running, so the map is about to be complete. */
let toolMetadataCollecting = false;
export function installToolMetadataCollector(collect: () => void): void {
  toolMetadataCollector = collect;
  // A late install (after the first read already ran the empty map) still takes
  // effect: clear the loaded flag so the next read collects.
  toolMetadataLoaded = false;
}
function ensureToolMetadataLoaded(): void {
  if (toolMetadataLoaded || toolMetadataCollector === undefined) return;
  toolMetadataLoaded = true; // set before running so re-entrant declares don't recurse
  toolMetadataCollecting = true;
  try {
    toolMetadataCollector();
  } finally {
    toolMetadataCollecting = false;
  }
}

/**
 * D1 fail-safe (RFC 0004 P2, SECURITY-CRITICAL): the capability gate must NEVER
 * fail OPEN. If a reader hits the derived map while it is empty AND no collector
 * was ever installed, the tools-layer bootstrap did not run — `isToolEnabled`
 * would otherwise pass EVERYTHING through the permissive `human` default,
 * silently un-gating `eval_js` / `register_secret` / `network_body` / the engine
 * gate. Rather than fail open we throw a structured, actionable error so the
 * misconfiguration is loud and impossible to ship. The guaranteed bootstrap
 * (`tool-metadata.ts`, imported by every real entry point) is the primary
 * mechanism that keeps this throw from firing in production; this is the backstop.
 *
 * The throw is suppressed only DURING collection (the collector's own gate read
 * legitimately sees a partial map) — at that point a collector is installed and
 * running, so the map is about to be complete.
 */
function assertGateBootstrapped(): void {
  if (TOOL_CAPABILITY_MAP.size > 0 || toolMetadataCollecting) return;
  throw new Error(
    "browxai capability gate read before the tool-metadata bootstrap ran: the derived " +
      "TOOL_CAPABILITY map is empty and no collector was installed. Refusing to fail OPEN " +
      "(which would un-gate eval_js / register_secret / network_body). Import the package " +
      'entry ("browxai") or call createServer before reading the capability gate. ' +
      "(RFC 0004 P2 / D1.)",
  );
}

/** The derived tool→capability map. Reading drives the lazy collection so the
 *  rows declared at registration are present for a standalone caller, then
 *  asserts the gate is bootstrapped (fail-safe — never returns an empty
 *  un-gated map to a consumer). */
export function toolCapabilityMap(): ReadonlyMap<string, Capability> {
  ensureToolMetadataLoaded();
  assertGateBootstrapped();
  return TOOL_CAPABILITY_MAP;
}

/** Back-compat `Record` view of the derived map for the consumers that index it
 *  by name (`TOOL_CAPABILITY[tool]`). A `Proxy` so a read both triggers the lazy
 *  collection and reflects any registration that ran after a prior read. Every
 *  access path that resolves a capability (the by-name `get`, the membership
 *  `has`, key enumeration, and the D2 `Symbol.iterator` Map-parity iterator)
 *  runs the D1 fail-safe — the gate never answers from an empty unbootstrapped
 *  map. */
export const TOOL_CAPABILITY: Record<string, Capability> = new Proxy(
  Object.create(null) as Record<string, Capability>,
  {
    get(_t, key) {
      ensureToolMetadataLoaded();
      // D2: Map-parity iteration — `for (const [tool, cap] of TOOL_CAPABILITY)`
      // and `[...TOOL_CAPABILITY]` delegate to the backing Map's iterator. Bound
      // to the Map so the internal-slot read keeps the right receiver.
      if (key === Symbol.iterator) {
        assertGateBootstrapped();
        return TOOL_CAPABILITY_MAP[Symbol.iterator].bind(TOOL_CAPABILITY_MAP);
      }
      if (typeof key !== "string") return undefined;
      assertGateBootstrapped();
      return TOOL_CAPABILITY_MAP.get(key);
    },
    has(_t, key) {
      ensureToolMetadataLoaded();
      assertGateBootstrapped();
      return typeof key === "string" && TOOL_CAPABILITY_MAP.has(key);
    },
    ownKeys() {
      ensureToolMetadataLoaded();
      assertGateBootstrapped();
      return [...TOOL_CAPABILITY_MAP.keys()];
    },
    getOwnPropertyDescriptor(_t, key) {
      ensureToolMetadataLoaded();
      assertGateBootstrapped();
      if (typeof key === "string" && TOOL_CAPABILITY_MAP.has(key)) {
        return { enumerable: true, configurable: true, value: TOOL_CAPABILITY_MAP.get(key) };
      }
      return undefined;
    },
  },
);

/*
 * Per-tool capability assignments are DERIVED (RFC 0004 P2 / D2) and live at each
 * tool's `host.register({ capability })` call (the single source of truth,
 * src/tools/host.ts) — never a hand-maintained list here. The threat-model
 * rationale for each tool's capability is documented canonically in:
 *   - docs/threat-model.md ("The capability set")
 *   - docs/ai-context/architecture/capability-posture-map.md
 * The verbatim pre-P2 mapping appendix that used to sit here has been removed; see
 * those docs (and the colocated registrations) for the authoritative posture.
 */

export interface CapabilityConfig {
  enabled: ReadonlySet<Capability>;
  /** Names of tools rejected at start because their capability isn't enabled. */
  disabledTools: ReadonlyArray<{ tool: string; capability: Capability }>;
  /** Non-fatal startup warnings — e.g. a retired capability was supplied.
   *  The caller (server.ts) logs these; they never abort startup. */
  warnings: readonly string[];
}

export function resolveCapabilities(env: NodeJS.ProcessEnv = process.env): CapabilityConfig {
  const raw = env.BROWX_CAPABILITIES?.trim();
  const list = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [...DEFAULT_CAPABILITIES];
  const warnings: string[] = [];
  const live: string[] = [];
  const unknown: string[] = [];
  for (const c of list) {
    if (ALL_CAPABILITIES.includes(c as Capability)) {
      live.push(c);
    } else if (Object.prototype.hasOwnProperty.call(RETIRED_CAPABILITIES, c)) {
      // Retired, not unknown — tolerate it so an old config never crashes.
      warnings.push(
        `BROWX_CAPABILITIES: "${c}" is a retired capability — ${RETIRED_CAPABILITIES[c]}. ` +
          `It is ignored (no effect); the rest of your config is honoured.`,
      );
    } else {
      unknown.push(c);
    }
  }
  if (unknown.length) {
    throw new Error(
      `BROWX_CAPABILITIES: unknown capability/capabilities ${unknown.map((u) => JSON.stringify(u)).join(", ")}. ` +
        `Valid: ${ALL_CAPABILITIES.join(", ")}.`,
    );
  }
  const enabled = new Set(live as Capability[]);
  const disabledTools: Array<{ tool: string; capability: Capability }> = [];
  for (const [tool, cap] of toolCapabilityMap()) {
    if (!enabled.has(cap)) disabledTools.push({ tool, capability: cap });
  }
  return { enabled, disabledTools, warnings };
}

/** Returns true iff the tool is enabled given the active capability set. */
export function isToolEnabled(tool: string, caps: CapabilityConfig): boolean {
  const cap = toolCapabilityMap().get(tool);
  if (!cap) return true; // unknown tool: pass through (human-coordination default)
  return caps.enabled.has(cap);
}

/**  confirm-required policy. Each name corresponds to a runtime hook (see
 *  src/policy/confirm.ts). Default: `navigate_off_allowlist,byob_action` when
 *  `BROWX_ALLOWED_ORIGINS` is set / `BROWX_ATTACH_CDP` is set respectively. */
export type ConfirmHook =
  | "navigate_off_allowlist"
  | "file_download"
  | "file_upload"
  | "byob_action";

const ALL_CONFIRM_HOOKS: readonly ConfirmHook[] = [
  "navigate_off_allowlist",
  "file_download",
  "file_upload",
  "byob_action",
];

const DEFAULT_CONFIRM_HOOKS: readonly ConfirmHook[] = ["navigate_off_allowlist", "byob_action"];

export function resolveConfirmHooks(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<ConfirmHook> {
  const raw = env.BROWX_CONFIRM_REQUIRED?.trim();
  if (!raw) return new Set(DEFAULT_CONFIRM_HOOKS);
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = list.filter((h) => !ALL_CONFIRM_HOOKS.includes(h as ConfirmHook));
  if (unknown.length) {
    throw new Error(
      `BROWX_CONFIRM_REQUIRED: unknown hook(s) ${unknown.map((u) => JSON.stringify(u)).join(", ")}. ` +
        `Valid: ${ALL_CONFIRM_HOOKS.join(", ")}.`,
    );
  }
  return new Set(list as ConfirmHook[]);
}
