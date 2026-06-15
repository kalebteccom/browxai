// The EngineRegistry (RFC 0004 D1) — the one place an engine's name appears as
// data. Each engine registers a single `EngineEntry` record (in its own
// adapters/<engine>.engine.ts module); the session factories, the substrate
// selection, and the post-creation wiring then resolve everything by a
// data-driven lookup keyed on `session.engine` — no `if (engine === "literal")`
// branch survives above the seam.
//
// This realizes architecture-principles §4 ("new engine = new adapter behind the
// existing port"): a sixth engine is a sixth `registerEngine(...)` call in a new
// file, with no edit to managed.ts / incognito.ts / byob.ts / session-registry.ts
// / host-build.ts. The strangler-fig discipline (RFC 0004 §1.2): the registry is
// a pure indirection over the SAME adapter instances + the SAME post-wire steps
// the if-chains drove, so each engine's observable session is byte-identical —
// only the dispatch MECHANISM changes.

import type { Locator } from "playwright-core";
import type { EngineKind, EngineCapabilities } from "./types.js";
import { invariant } from "../util/invariant.js";
import { EngineNotYetSupportedError } from "./select.js";
import { setEngineCapabilities, engineCapabilities } from "./capability-registry.js";
import type { BrowserSession, SessionOptions } from "../session/types.js";
import type { SessionEntry } from "../session/registry.js";
import type { ActionSubstrate } from "../page/action-substrate.js";
import type { CaptureSubstrate } from "../page/capture-substrate.js";
import type { StorageSubstrate } from "../page/storage-substrate.js";
import type { ScriptSubstrate } from "../page/script-substrate.js";
import type { EmulationSubstrate } from "../page/emulation-substrate.js";
import type { SnapshotSubstrate } from "../page/snapshot-substrate.js";
import type { NetworkSubstrate } from "../page/network-substrate.js";
import type { ActionContext } from "../page/actionresult.js";
import type { RefRegistry } from "../page/refs.js";
import type { ScreenshotSaveResult } from "../page/screenshot-save.js";
import type { CapabilityConfig } from "../util/capabilities.js";
import type { ConfigStore } from "../util/config-store.js";
import type { Workspace } from "../util/workspace.js";

/** The per-capability substrate set a session is wired with. The five
 *  `host-build.ts` selectors (actionsFor / captureFor / storageFor / scriptFor /
 *  emulationFor) collapse into producing one of these, and so do the two
 *  standalone `*-substrate-select.ts` files (`snapshotSubstrateFor` /
 *  `networkSubstrateFor`) — the engine owns the Safari-vs-Playwright-vs-CDP
 *  choice once, expressed here, so no engine-name dispatch survives above the
 *  seam. Each field is a `(e) => Substrate` selector: the engine handle is
 *  captured per-session from the `SessionEntry`, so the per-call surface carries
 *  no engine type. (0004-03 §1.) */
export interface SubstrateBundle {
  actions: (e: SessionEntry) => ActionSubstrate;
  capture: (e: SessionEntry) => CaptureSubstrate;
  storage: (e: SessionEntry) => StorageSubstrate;
  script: (e: SessionEntry) => ScriptSubstrate;
  emulation: (e: SessionEntry) => EmulationSubstrate;
  snapshot: (e: SessionEntry) => SnapshotSubstrate;
  network: (e: SessionEntry) => NetworkSubstrate;
}

/** The per-server host config the `makeSubstrates` factory needs — the exact
 *  `ctxFor` + `describeTarget` + screenshot-`save` dependencies host-build supplied
 *  inline before the fold. These CLOSE OVER server-scoped security boundaries
 *  (`ctxFor` carries the server's originPolicy / config.testAttributes / caps
 *  gating; `save` writes under the server's `workspace.root`), so the composition
 *  root threads its OWN per-server set at the `makeSubstrates(deps)` call site —
 *  never a module-global, which would let a second `createServer()` in the same
 *  process overwrite the first server's boundary (the in-process SDK transport
 *  composes one server per transport). Threading explicitly keeps each server's
 *  substrates bound to ITS deps, so cross-server contamination is impossible. */
export interface SubstrateDeps {
  /** Build the `ActionContext` for an action dispatch — the verbatim `ctxFor`
   *  closure from host-build (it closes over the server's config/originPolicy/caps). */
  ctxFor: (e: SessionEntry) => ActionContext;
  /** The structured one-liner alongside an element screenshot. */
  describeTarget: (
    loc: Locator,
    refs: RefRegistry,
    target: { ref: string } | { selector: string } | { coords: { x: number; y: number } },
  ) => Promise<string>;
  /** Persist a screenshot buffer to the server's workspace-rooted path. */
  save: (
    buf: Buffer,
    args: { path: string; format: "png" | "jpeg"; fullPage: boolean },
  ) => ScreenshotSaveResult;
}

/** The per-server host config the `postWire` step needs — the same locals
 *  `buildSessionRegistry` owns. These too are server-scoped (`caps` is the
 *  server's capability gate, `workspace.root` its sandbox write-root), so the
 *  composition root threads its OWN set at the `postWire(entry, deps)` call site
 *  rather than a module-global: a second server with different caps/workspace must
 *  never reach across and wire THIS server's sessions. */
export interface PostWireDeps {
  caps: CapabilityConfig;
  configStore: ConfigStore;
  workspace: Workspace;
}

/** Everything the session layer needs from an engine, declared once in the
 *  engine's own adapter-registration module. Adding an engine = a new module
 *  that calls `registerEngine(record)` once; no edit to any session factory, the
 *  session registry, or host-build. This is the single `EngineEntry` shape the
 *  whole RFC 0004 suite standardizes on (0004-03 §1) — over the real session
 *  types, not placeholders. */
export interface EngineEntry {
  readonly kind: EngineKind;
  /** The static capability declaration (deep / sub-interfaces) — today this is
   *  `capabilitiesFor(kind)`; the registry makes the adapter the owner of its
   *  own row, not a central table. */
  readonly capabilities: EngineCapabilities;
  /** Launch + return the lifecycle session for one of the session modes. Subsumes
   *  the per-engine launch/attach branching the three session factories carried;
   *  the factories keep only their MODE concern (the launch mode is threaded
   *  through `opts.launchMode`, defaulting to managed). */
  makeAdapter(opts: SessionOptions): Promise<BrowserSession>;
  /** Build the per-capability substrate selectors for a session of this engine.
   *  Subsumes the five host-build.ts selectors + the two standalone selectors —
   *  the Safari-vs-Playwright-vs-CDP choice is the engine's own concern. The
   *  composition root passes its OWN per-server `SubstrateDeps` (originPolicy /
   *  workspace / caps / ctxFor, threaded explicitly — NOT a module-global —
   *  precisely to preserve per-server isolation when two servers share a process). */
  makeSubstrates(deps: SubstrateDeps): SubstrateBundle;
  /** Post-creation wiring previously scattered as `sess.engine !== "safari"`
   *  guards across session-registry.ts — now owned by the engine that needs it.
   *  The four Playwright engines attach the full console/bridge/policy/download/
   *  stealth/device-emulation/ws-interactive/workers set; Safari attaches only its
   *  BiDi console bridge (and the synthetic in-memory engine attaches nothing).
   *
   *  Takes the composition root's OWN per-server `PostWireDeps` (caps / configStore
   *  / workspace) — threaded explicitly at the call site, NOT read from a
   *  module-global, so a second server in the same process can never wire THIS
   *  server's sessions with its capabilities or sandbox root.
   *
   *  Returns `void` OR a `Promise<void>`: the four Playwright engines AWAIT their
   *  context attaches (so the session is fully wired before the factory returns it,
   *  byte-identical to the pre-relocation inline awaits), while the no-op engines
   *  return sync `void`. The session factory `await`s the result. */
  postWire(entry: SessionEntry, deps: PostWireDeps): void | Promise<void>;
}

const REGISTRY = new Map<EngineKind, EngineEntry>();

/** Add-only registration. Called once per adapter-registration module at module
 *  load. A sixth engine is a sixth `registerEngine(...)` call in a new file — no
 *  edit here. Re-registering an engine is a programming error, surfaced loudly so
 *  a duplicate (e.g. a double-imported barrel) never silently shadows. */
export function registerEngine(def: EngineEntry): void {
  // L8: the record's own `kind` must match the capability row's `engine` — the
  // registry keys on `def.kind` while the gate reads `def.capabilities.engine`,
  // so a mismatch would silently gate the wrong engine. Each adapter module
  // already wires `{ kind: K, capabilities: capabilitiesFor(K) }`, so this holds
  // on every valid registration; the invariant catches a copy-paste swap at
  // module load, not in production.
  invariant(
    def.kind === def.capabilities.engine,
    `engine "${def.kind}" registered with capabilities for "${def.capabilities.engine}"`,
  );
  if (REGISTRY.has(def.kind)) {
    throw new Error(`engine-registry: "${def.kind}" registered twice`);
  }
  REGISTRY.set(def.kind, def);
  // Mirror the capability declaration into the decoupled side-table so the engine
  // gate can read it without importing this module (which would form a cycle).
  setEngineCapabilities(def.kind, def.capabilities);
}

/** The data-driven lookup the factories / selectors / post-wire call. Throws the
 *  same structured `EngineNotYetSupportedError` the engine-select path does — a
 *  declared-but-unregistered engine is a refusal, never a silent default. The
 *  session-mode dispatch stays in the factories; the registry resolves only the
 *  ENGINE. */
export function engineEntry(kind: EngineKind): EngineEntry {
  const def = REGISTRY.get(kind);
  if (!def) throw new EngineNotYetSupportedError(kind);
  return def;
}

/** Whether an engine has a registered entry. Lets a caller branch on
 *  registration presence (e.g. a test) without forcing the throw. */
export function hasEngine(kind: EngineKind): boolean {
  return REGISTRY.has(kind);
}

/** Non-throwing capability lookup — re-exported from the decoupled capability
 *  side-table (`capability-registry.ts`) so callers can import it from the registry
 *  surface. The gate imports it from the side-table directly to avoid a cycle. */
export { engineCapabilities };

/** Whether an engine's BYOB/attach lane requires an explicit `BROWX_ATTACH_CDP`
 *  endpoint. Android attach is endpoint-DISCOVERED over adb (no endpoint needed);
 *  every other engine's CDP-attach lane requires the loopback endpoint. The
 *  session registry consults this so its attached-mode precondition stays
 *  engine-agnostic (the one android-specific fact lives here, in the engine layer,
 *  not as a literal branch in the session registry). */
export function byobAttachNeedsEndpoint(kind: EngineKind): boolean {
  return kind !== "android";
}
