# RFC 0004 / Reference 03 — Open/closed registry & port patterns (the target architecture)

This is the **pattern catalogue** for RFC 0004 — the eight before/after designs that turn browxai's documented-but-unenforced doctrine into structure. Each pattern names a smell from the audit ([`0004-01-current-state-audit.md`](0004-01-current-state-audit.md)) with file:line evidence, states the target shape as compiling-shaped TypeScript over the real symbols (`EngineKind`, `BrowserSession`, `ToolHost`, `SessionEntry`, the substrate ports), and quantifies the OCP win as *files-to-edit before → after*. The patterns realize decisions **D1–D7** of the parent RFC ([`../0004-architecture-hardening.md`](../0004-architecture-hardening.md)); the fitness functions that keep each one true are specified in [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md); the sequenced, behavior-preserving rollout is in [`0004-04-refactor-plan.md`](0004-04-refactor-plan.md).

> **Reading rule.** This catalogue is the *target*, not the *diff*. Every AFTER block is the shape the seam converges to; the refactor plan reaches it strangler-fig, byte-identical per engine, gate-green at every step. Where a BEFORE block is abbreviated, the citation locates the verbatim source. The doctrine these patterns extend — the proven-seam test, the dependency direction, the one-tool-one-file rule — is [`architecture-principles.md`](../../ai-context/architecture/architecture-principles.md); this document is its mechanization at the wiring layer, not a restatement.

---

## How to read each pattern

| Field | Meaning |
|-------|---------|
| **Smell** | The concrete defect, with the audit's file:line evidence. The *category* (OCP / ISP / LSP / DRY / SRP) and the parent decision (D1–D7). |
| **Intent** | The named pattern (Registry, Derived Map, Port Segregation, Template Method, Decorator, Chokepoint) and the one-sentence reason it fits. |
| **Before** | Real current code, abbreviated to the load-bearing lines, with the source citation. |
| **After** | Compiling-shaped TypeScript over real browxai symbols. The seam, not the whole module. |
| **OCP win** | Files-to-edit for the canonical extension (a 6th engine / a new tool / a new transport) *before → after*, plus the law (L1–L10) and fitness function that now enforce it. |

The eight patterns and the extension each one closes:

| # | Pattern | Closes (the add that is currently edit-heavy) | Decision |
|---|---------|-----------------------------------------------|----------|
| 1 | **The `EngineRegistry`** | a 6th engine (today: 5–8 files) | D1 |
| 2 | **Metadata-at-registration + derived maps** | a new tool's capability/batch/deep facts (today: up to 5 lists) | D2 |
| 3 | **Port segregation** | a handler's contract; a session role | D3 |
| 4 | **The `PolicyBuffer` base** | a 6th policy class (today: full copy-paste) | D4 |
| 5 | **The `actionTool()` wrapper** | the 7-step action body (today: ~50× repeat) | D4 |
| 6 | **The `EgressSanitiser` chokepoint** | a new output sink that must mask (today: hope) | D4 |
| 7 | **Switch → registry** | a CLI subcommand / transport / analyser / mode | D6 |
| 8 | **The Safari `page()` capability** | the no-Page seam (today: 17 inline guards) | D5 |

---

## 1. THE `EngineRegistry` (D1) — the flagship

### Smell — engine *wiring* is hardcoded `if (engine === …)` in five-to-eight places

The five engine **adapters** are well-isolated classes (`PlaywrightChromiumAdapter`, `PlaywrightFirefoxAdapter`, `PlaywrightWebKitAdapter`, `AndroidCdpAdapter`, `SafaridriverHybridAdapter` — all exported from `src/engine/index.ts:31-54`). Their *instantiation and post-creation wiring* are not isolated; they are spread across the session layer as literal `engine === "…"` branches. Category **OCP**, severity **critical**. The audit's evidence, consolidated:

| Site | Evidence | What it does |
|------|----------|--------------|
| Managed factory | `src/session/managed.ts:22-42` (`engine === "android"`, `engine === "safari"`, else Playwright) | picks + launches the adapter |
| Incognito factory | `src/session/incognito.ts` (same launch chain) | same engine dispatch, ephemeral mode |
| BYOB factory | `src/session/byob.ts` (attach/refusal dispatch, *not* the same launch chain) | engine-literal dispatch over attach (`openAndroidByobSession`) / Safari refusal / Firefox-WebKit attach refusals / Chromium CDP attach |
| Substrate selectors | `src/tools/host-build.ts:288-357` — `actionsFor` / `captureFor` / `storageFor` / `scriptFor` / `emulationFor` each do `e.session.safari?.()` then fall through to the Playwright class | picks the per-capability substrate |
| Session post-wire | `src/tools/session-registry.ts:266,280,292,301,332,338,349,383,408,441,451,457,479,536,550,584,589` — 17 `sess.engine !== "safari"` guards | attaches console / HAR / video / bridge / policies / downloads / stealth / device-emu / workers |
| Deep gate | `src/engine/tool-gate.ts:38-88` — `DEEP_TOOLS` is a hand-maintained `Set<string>` of 31 names | refuses CDP-hard tools off Chromium |

The headline consequence is the falsification of the project's own flagship claim. architecture-principles §4 promises *"new engine = new adapter behind the existing port."* Today a sixth engine forces edits to `managed.ts`, `incognito.ts`, `byob.ts`, the five `host-build.ts` selectors, and the `session-registry.ts` post-wire — **5–8 existing files**, every one a merge-conflict surface and a place to forget a guard.

The dispatch repeats across **three engine-literal dispatch sites**. `managed.ts` and `incognito.ts` share the same launch chain; `byob.ts` is *not* the same chain — it dispatches over attach/refusal paths (`openAndroidByobSession` attach, Safari refusal, Firefox/WebKit attach refusals, then Chromium CDP attach) — but it branches on the same engine literals, so it is the third site a sixth engine must touch. From `managed.ts:26-42`:

```typescript
// BEFORE — src/session/managed.ts:22-42 (abbreviated; incognito.ts shares this launch
// chain; byob.ts branches on the same engine literals via attach/refusal paths)
const engine: EngineKind = opts.browserType ?? "chromium";
if (engine === "android") {
  await new AndroidCdpAdapter().launch(); // attach-only — refuses with structured error
}
if (engine === "safari") {
  const handle = await new SafaridriverHybridAdapter().launchManaged();
  return buildSafariSession(handle); // the Playwright path below is never reached
}
// … Playwright launch path: firefox / webkit channel resolution, then chromium as the implicit else
```

And the substrate selectors (`host-build.ts:288-357`) are five verbatim copies of one shape — the audit flags this as both OCP and DRY:

```typescript
// BEFORE — src/tools/host-build.ts:288-357 (5 selectors, identical skeleton)
const actionsFor = (e: SessionEntry): ActionSubstrate => {
  const safariHandle = e.session.safari?.();
  if (safariHandle) return new SafariActionSubstrate(safariHandle, e.refs);
  return new PlaywrightActionSubstrate(() => ctxFor(e), e.session.engine);
};
const captureFor = (e: SessionEntry): CaptureSubstrate => {
  const safariHandle = e.session.safari?.();
  if (safariHandle) return new SafariCaptureSubstrate(safariHandle);
  return new PlaywrightCaptureSubstrate(() => e.session.page(), e.refs, { describeTarget, save });
};
// storageFor / scriptFor / emulationFor — same five lines, only the class names change
```

A sixth substrate (a future `DiagnosticsSubstrate`) copies the skeleton a sixth time; a sixth *engine* (a non-Playwright WebDriver engine) forces a new branch into all five selectors *and* the seventeen registry guards *and* the three dispatch sites.

### Intent — the **Registry** pattern (Gamma et al.; the "replace conditional with polymorphism + lookup table" refactoring)

One `EngineEntry` per engine, registered in *one* file, captures the four things the session layer needs from an engine: how to make the adapter, how to make the per-capability substrates, what the engine declares as capabilities, and what post-creation wiring it wants. The factories, selectors, and gate become **data-driven lookups keyed by `session.engine`** — no literal branches anywhere above the seam. This is the literal realization of architecture-principles §4 and the single highest-leverage refactor in the RFC.

### After — `EngineEntry` + `ENGINE_REGISTRY`, data-driven everywhere

The contract (new file, `src/engine/registry.ts`), built over the real `EngineKind`, `EngineCapabilities`, `BrowserSession`, `SessionEntry`, and the substrate-port types:

```typescript
// AFTER — src/engine/registry.ts (new file; the only place an engine's name appears as data)
import type { EngineKind, EngineCapabilities } from "./types.js";
import { EngineNotYetSupportedError } from "./select.js"; // the real refusal error lives here
import type { BrowserSession, SessionOptions } from "../session/types.js";
import type { SessionMode, SessionEntry } from "../session/registry.js"; // registry.ts:44 mode union
// There is no src/page/index.ts barrel today — each substrate type is exported
// from its own module. (Adding a barrel is an option, but the import below names
// the real per-substrate files so the sketch resolves against the tree as-is.)
import type { ActionSubstrate } from "../page/action-substrate.js";
import type { CaptureSubstrate } from "../page/capture-substrate.js";
import type { StorageSubstrate } from "../page/storage-substrate.js";
import type { ScriptSubstrate } from "../page/script-substrate.js";
import type { EmulationSubstrate } from "../page/emulation-substrate.js";
import type { SnapshotSubstrate } from "../page/snapshot-substrate.js";
import type { NetworkSubstrate } from "../page/network-substrate.js";

/** The per-capability substrate set a session is wired with. The five
 *  `host-build.ts` selectors collapse into producing one of these, and so do
 *  the two standalone `*-substrate-select.ts` files: `snapshotSubstrateFor` /
 *  `networkSubstrateFor` (each with a hardcoded `engine === "safari"` branch at
 *  `snapshot-substrate-select.ts:44` / `network-substrate-select.ts:44`, audit
 *  page-core) fold in here so the registry closes those Safari branches too —
 *  no engine-name dispatch survives above the seam. */
export interface SubstrateBundle {
  actions: (e: SessionEntry) => ActionSubstrate;
  capture: (e: SessionEntry) => CaptureSubstrate;
  storage: (e: SessionEntry) => StorageSubstrate;
  script: (e: SessionEntry) => ScriptSubstrate;
  emulation: (e: SessionEntry) => EmulationSubstrate;
  snapshot: (e: SessionEntry) => SnapshotSubstrate;
  network: (e: SessionEntry) => NetworkSubstrate;
}

/** Everything the session layer needs from an engine, declared once. An adapter
 *  file registers exactly one of these; nothing else above the seam names the
 *  engine. This is the single `EngineEntry` shape the whole RFC suite standardizes
 *  on — `{ kind, capabilities, makeAdapter, makeSubstrates, postWire }`. */
export interface EngineEntry {
  readonly kind: EngineKind;
  /** The static capability declaration (deep / sub-interfaces). Today this is
   *  `capabilitiesFor(kind)` in src/engine/capabilities.ts — the registry makes
   *  the adapter the owner of its own row, not a central table. */
  readonly capabilities: EngineCapabilities;
  /** Launch + return the lifecycle session. Subsumes the per-engine launch/attach
   *  branching across the three dispatch sites; the factories keep only their
   *  *mode* concern (managed/byob; ephemeral refusal becomes the adapter's
   *  `launchEphemeral` throwing, per audit engine-adapters#6). */
  makeAdapter(opts: SessionOptions): Promise<BrowserSession>;
  /** Build the per-capability substrate selectors for a session of this engine.
   *  Subsumes host-build.ts:288-357 — the Safari-vs-Playwright choice is now the
   *  engine's own concern, expressed once. */
  makeSubstrates(): SubstrateBundle;
  /** Post-creation bookkeeping this engine wants. Subsumes the 17 `sess.engine
   *  !== "safari"` guards in session-registry.ts — a Playwright engine attaches
   *  console/HAR/video/policies/downloads; Safari attaches its minimal set. */
  postWire(entry: SessionEntry): void;
}

const REGISTRY = new Map<EngineKind, EngineEntry>();

/** Add-only registration. Called once per adapter file at module load. A sixth
 *  engine is a sixth `registerEngine(...)` call in a new file — no edits here. */
export function registerEngine(def: EngineEntry): void {
  if (REGISTRY.has(def.kind)) {
    throw new Error(`engine-registry: ${def.kind} registered twice`);
  }
  REGISTRY.set(def.kind, def);
}

/** The data-driven lookup the factories/selectors/gate call. Throws the same
 *  structured `EngineNotYetSupportedError` (`src/engine/select.js`) the current
 *  engine-select path does — a declared-but-unregistered engine is a refusal,
 *  never a silent default. The session-mode dispatch (persistent/incognito/attached,
 *  `SessionMode` at registry.ts:44 — distinct from the managed/byob `SessionMode`
 *  at types.ts:9) stays in the factories; the registry resolves only the *engine*. */
export function engineEntry(kind: EngineKind): EngineEntry {
  const def = REGISTRY.get(kind);
  if (!def) throw new EngineNotYetSupportedError(kind);
  return def;
}
```

Each adapter file ends with its registration — the only line that mentions the engine by name:

```typescript
// AFTER — bottom of src/engine/adapters/safaridriver-hybrid.ts (mirrored in each adapter file)
registerEngine({
  kind: "safari",
  capabilities: capabilitiesFor("safari")!,
  makeAdapter: async (opts) =>
    buildSafariSession(await new SafaridriverHybridAdapter().launchManaged()), // → Promise<BrowserSession>, the managed.ts:36-41 flow
  makeSubstrates: () => ({
    // All seven SubstrateBundle fields — the snapshot/network branches at
    // snapshot-substrate-select.ts:44 / network-substrate-select.ts:44 fold in here.
    actions: (e) => new SafariActionSubstrate(e.session.safari!(), e.refs),
    capture: (e) => new SafariCaptureSubstrate(e.session.safari!()),
    storage: (e) => new SafariStorageSubstrate(e.session.safari!()),
    script: (e) => new SafariScriptSubstrate(e.session.safari!()),
    emulation: (e) => new SafariEmulationSubstrate(e.session.safari!()),
    snapshot: (e) => {
      // SafariClassicSnapshotSubstrate takes a SafariSnapshotIO seam ({ exec, currentUrl }),
      // not the raw handle — exactly the wrapping live snapshot-substrate-select.ts:46-50 does.
      const h = e.session.safari!();
      return new SafariClassicSnapshotSubstrate({
        exec: (body, args) => h.webDriver.executeScript(h.sessionId, body, args),
        currentUrl: () => h.webDriver.currentUrl(h.sessionId),
      });
    }, // execute/sync DOM-walk over the SafariSnapshotIO seam
    network: () => new SafariNoopNetworkSubstrate(), // no protocol-level network on Safari
  }),
  postWire: (entry) => attachSafariMinimalBookkeeping(entry), // console-BiDi only
});
```

The three call sites collapse to one shape. The factory chain in `managed.ts:22-42` becomes:

```typescript
// AFTER — src/session/managed.ts (the engine-literal dispatch is gone; the factory
// keeps only its MODE concern and asks the registry for the engine's adapter)
export async function openManagedSession(opts: SessionOptions = {}): Promise<BrowserSession> {
  const engine: EngineKind = opts.browserType ?? "chromium";
  return engineEntry(engine).makeAdapter(opts);
}
```

The five substrate selectors in `host-build.ts:288-357` become one bundle lookup, captured once per session:

```typescript
// AFTER — src/tools/host-build.ts (the five copies are gone)
const substrates = engineEntry(session.engine).makeSubstrates();
const actionsFor = substrates.actions;   // SessionEntry => ActionSubstrate
const captureFor = substrates.capture;   // … etc; the ToolHost shape is unchanged
```

And the seventeen `sess.engine !== "safari"` guards in `session-registry.ts` collapse into one call — each engine's definition owns what it attaches:

```typescript
// AFTER — src/tools/session-registry.ts (the 17 guards are gone)
const entry = buildEntry(session /* … */);
engineEntry(session.engine).postWire(entry); // Playwright: full set; Safari: minimal
```

`DEEP_TOOLS` becomes derivable too — see Pattern 2 — but even before that, the gate's *engine* dimension reads `engineEntry(kind).capabilities.deep` instead of carrying engine knowledge.

### OCP win

| Extension | Before | After |
|-----------|--------|-------|
| Add a sixth engine | edit `managed.ts` + `incognito.ts` + `byob.ts` + 5 selectors in `host-build.ts` + 17 guards in `session-registry.ts` (**5–8 files**) | **1 new file** (`adapters/<engine>.ts`) with one `registerEngine(...)` call |
| Add a sixth substrate | copy the 5-line selector skeleton a 6th time across every engine | add one field to `SubstrateBundle`, implement it in each `makeSubstrates` |

Enforced by **L1 — Closed core** (`no-engine-literal-branches` lint rule banning `engine === "<literal>"` above the seam) and the **engine-adapter-contract keystone** — a synthetic sixth engine registered with `registerEngine(...)` that must drive the engine-agnostic core (navigate / snapshot / find / click) with **zero core edits**. That keystone is the executable proof of architecture-principles §4; today the claim is documented and unverified (audit harness-and-docs#3).

---

## 2. METADATA-AT-REGISTRATION + DERIVED MAPS (D2)

### Smell — every tool's facts are hand-listed in up to five disjoint god-lists

A tool today carries no metadata about itself; instead, *facts about the tool* live in central lists the author must remember to edit. Category **OCP**, severity **critical**. The lists:

| Fact | Where it is hand-listed | Evidence | Silent-failure mode if forgotten |
|------|-------------------------|----------|----------------------------------|
| Capability that gates the tool | `TOOL_CAPABILITY` (181 entries) | `src/util/capabilities.ts:87-524` | defaults to `human` → capability gate silently off (audit policy-util#0) |
| Batchable in compound tools? | `BATCH_ALLOWED_TOOLS` (71-entry `Set`) | `src/tools/host-build.ts:640-712` | tool silently *not* batchable (audit tools-and-seam#5) |
| CDP-deep (refuse off Chromium)? | `DEEP_TOOLS` (31 names) | `src/engine/tool-gate.ts:38-88` | tool runs on Firefox/WebKit and **crashes mid-call** instead of refusing (audit engine-adapters#2,#7) |
| SDK type surface | `src/sdk/tool-types.ts` (673 LOC, hand-mirrored) | admits zod is source of truth, mirrors it anyway | drift between SDK types and the wire schema (audit plugin-sdk#2; see D7) |

The defining property of all four: the fact lives *away from* the `host.register(...)` call that defines the tool, so adding a tool means editing the tool module **and** up to four central files — and every miss is silent, not a compile error. `isToolEnabled` (`capabilities.ts:574`) returns the permissive default for an unmapped tool; the batch set simply doesn't contain it; the deep gate doesn't know about it until a Firefox user hits a runtime crash.

The current `register` signature already proves the colocation is *almost* there — it takes `description` and `inputSchema`, just not the gating facts (`src/tools/host.ts:60-64`):

```typescript
// BEFORE — src/tools/host.ts:60-64 (register takes description + schema, but no gating metadata)
register: <S extends z.ZodRawShape = Record<string, never>>(
  name: string,
  def: { description: string; inputSchema?: S },
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResponse>,
) => void;
```

So `click` declares its schema inline at `action-tools.ts:45-64`, but its capability (`"action"`) is asserted 480 lines away in `capabilities.ts`, its batchability in a 71-entry `Set` in `host-build.ts`, and its (non-)deepness by absence from `tool-gate.ts`. Three sources of truth for one tool's three facts.

### Intent — **colocated declaration + derived maps** (DO-178C configuration-data discipline: declare once, derive the rest)

Extend `register` so a tool states its own gating facts where it is defined; build the central maps by **iterating the registry at startup** instead of hand-maintaining them. The single source of truth becomes the registration call.

### After — metadata on `register`, maps derived

```typescript
// AFTER — src/tools/host.ts (register gains a metadata bundle)
import type { Capability } from "../util/capabilities.js";

export interface ToolMeta {
  /** The capability that gates this tool. Replaces the TOOL_CAPABILITY row. */
  capability: Capability;
  /** May a compound/batch tool dispatch to this tool? Replaces BATCH_ALLOWED_TOOLS membership. */
  batchable?: boolean;
  /** Needs the raw-CDP escape hatch — refused on engines that declare `deep:false`.
   *  Replaces DEEP_TOOLS membership. */
  deep?: boolean;
}

register: <S extends z.ZodRawShape = Record<string, never>>(
  name: string,
  def: { description: string; meta: ToolMeta; inputSchema?: S },
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResponse>,
) => void;
```

`click` now declares everything in one place:

```typescript
// AFTER — src/tools/action-tools.ts (one source of truth for click's three facts)
host.register(
  "click",
  {
    description: "Click an element by `ref`/`selector`/`named`/`coords`. Returns an ActionResult.",
    meta: { capability: "action", batchable: true }, // not `deep` — runs cross-engine
    inputSchema: { ...REF_OR_SELECTOR, button: z.enum(["left","right","middle"]).optional(), ...ACTION_OPTS },
  },
  async (args) => { /* handler unchanged */ },
);
```

`register` records each `ToolMeta` into a side-table keyed by name. The three central maps become pure derivations of that table:

```typescript
// AFTER — src/tools/registry-maps.ts (derived, never hand-edited)
import { registeredTools } from "./host.js"; // ReadonlyMap<string, ToolMeta>, populated by register

export const TOOL_CAPABILITY: ReadonlyMap<string, Capability> = new Map(
  [...registeredTools()].map(([name, m]) => [name, m.capability]),
);

export const BATCH_ALLOWED_TOOLS: ReadonlySet<string> = new Set(
  [...registeredTools()].filter(([, m]) => m.batchable).map(([name]) => name),
);

export const DEEP_TOOLS: ReadonlySet<string> = new Set(
  [...registeredTools()].filter(([, m]) => m.deep).map(([name]) => name),
);
```

The SDK type-types file (D7) is the fourth derivation: codegen reads the same registrations (which already carry their zod `inputSchema`) and emits `sdk/tool-types.ts` from `z.infer`, retiring the 673-line hand-mirror.

### The completeness invariant this enables

Once the facts are colocated, a fitness function can assert the property that no human-maintained list can: **every registered tool has a metadata row, and every name in every derived map traces back to a real registration.** No orphan in `TOOL_CAPABILITY` (a renamed tool whose stale row lingers), no tool defaulting to `human` by oversight, no `DEEP_TOOLS` entry for a tool that no longer exists. The check is a few lines over `registeredTools()` — see [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md) (L2 — Single source of truth).

### OCP win

| Extension | Before | After |
|-----------|--------|-------|
| Add a tool with a capability/batch/deep posture | edit the tool module + `capabilities.ts` + `host-build.ts` + `tool-gate.ts` (+ `sdk/tool-types.ts`) — **up to 5 files**, each miss silent | edit **1 file** (the `host.register` call); maps + types derive |

Enforced by **L2 — Single source of truth** (the completeness fitness tests + the tool-types codegen drift check). This single change closes four OCP findings at once (capabilities, batch, deep, SDK types).

---

## 3. PORT SEGREGATION (D3 / ISP)

### Smell — a 35-member `ToolHost` and a 40-field `SessionEntry`, both passed whole

Two god-objects sit at the center of the tool layer. Category **ISP**, severity **medium-to-high**.

- **`ToolHost`** declares 35 members (`src/tools/host.ts:54-189` — `register`, `entryFor`, `gateCheck`, `engineGate`, `confirmCtxFor`, `ctxFor`, `actionsFor`, `captureFor`, `storageFor`, `scriptFor`, `emulationFor`, `asTarget`, `actionTimeout`, `okText`, `errText`, `denyContent`, `asActionResultText`, …). A handler uses 8–12 of them (audit tools-and-seam#8): `click` touches exactly `gateCheck`, `entryFor`, `confirmCtxFor`, `denyContent`, `asTarget`, `actionTimeout`, `actionsFor`, `hintFromTarget`, `asActionResultText` (`action-tools.ts:66-85`). Adding a helper to the host forces an edit to the 35-member interface and recompiles every consumer.
- **`SessionEntry`** carries 40 fields (`src/session/registry.ts:48-224` — `session`, `refs`, `snapshotSubstrate`, `networkSubstrate`, `frames`, `console`, `network`, `ws`, `wsInteractive`, `workers`, `bridge`, `recorder`, `feedback`, `clipboard`, `routes`, `regions`, `emulation`, `clock`, `seededRandom`, `perf`, `coverage`, `wedge`, `metrics`, `dialog`, `permission`, `notification`, `fsPicker`, `deviceEmulation`, …). A tool that reads `e.refs` and `e.dialog` still depends on the whole bag and recompiles when any field changes (audit session#3).

### Intent — **Interface Segregation** (Martin): a consumer depends on the narrow role it uses, not the bag

Split `ToolHost` into composable sub-ports a handler takes à la carte; split `SessionEntry` into role-bundles its consumers actually use. The host *implementation* stays one object — segregation is about the **contract** the handler depends on, not the object's identity.

### After — sub-ports and role bundles

```typescript
// AFTER — src/tools/host-ports.ts (the 35-member ToolHost composed from narrow roles)
/** Capability/engine gating + denial envelopes. */
export interface GateHost {
  gateCheck(toolName: string): ToolResponse | null;
  engineGate(toolName: string, e: SessionEntry): ToolResponse | null;
  denyContent(toolName: string, decision: { reason: string }): ToolResponse;
}
/** Session resolution + confirm context. */
export interface SessionHost {
  entryFor(sessionId?: string): Promise<SessionEntry>;
  confirmCtxFor(e: SessionEntry): ConfirmContext;
}
/** Action dispatch surface: targets, deadlines, the engine-selected port, envelopes. */
export interface ActionHost {
  asTarget(args: RawTargetArgs, toolName: string, refs: RefRegistry): ResolvedTarget;
  actionTimeout(args: { timeoutMs?: number }): { ms: number; warning?: string };
  actionsFor(e: SessionEntry): ActionSubstrate;
  hintFromTarget(e: SessionEntry, t: RawTargetArgs): { selectorHint: string; stability?: string } | undefined;
}
/** JSON / ActionResult envelope builders, shared by every family. */
export interface EnvelopeHost {
  okText(body: Record<string, unknown>): ToolResponse;
  errText(tool: string, err: unknown): ToolResponse;
  asActionResultText(p: Promise<unknown>): Promise<ToolResponse>;
}
/** Tool registration — `register` is a ToolHost member (host.ts:60). Every
 *  function that wires a tool (registerClick, actionTool) depends on this role. */
export interface RegisterHost {
  register<S extends z.ZodRawShape = Record<string, never>>(
    name: string,
    def: { description: string; meta: ToolMeta; inputSchema?: S },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResponse>,
  ): void;
}

/** The concrete host still satisfies all of them — segregation is in the contract,
 *  not the object. The composition root keeps building one ToolHost. */
export type ToolHost = RegisterHost & GateHost & SessionHost & ActionHost & EnvelopeHost /* … */;
```

A handler now depends on exactly the roles it uses. The `click` body, retyped:

```typescript
// AFTER — an action handler takes the roles it actually calls, not all 35 members.
// `register` lives on RegisterHost (it is a ToolHost member, host.ts:60), so any
// function that calls host.register must include RegisterHost in its intersection.
function registerClick(host: RegisterHost & GateHost & SessionHost & ActionHost & EnvelopeHost): void {
  host.register("click", { /* … */ }, async (args) => {
    const g = host.gateCheck("click");                          // GateHost
    if (g) return g;
    const e = await host.entryFor(args.session);                // SessionHost
    const c = await confirmByobAction("click", host.confirmCtxFor(e));
    if (!c.ok) return host.denyContent("click", c);             // GateHost
    const target = host.asTarget(args, "click", e.refs);        // ActionHost
    const td = host.actionTimeout(args);                        // ActionHost
    return host.asActionResultText(                             // EnvelopeHost
      host.actionsFor(e).click({ target, button: args.button, deadlineMs: td.ms }),
    );
  });
}
```

`SessionEntry` segregates the same way — consumers depend on a role bundle, not the 40-field interface:

```typescript
// AFTER — src/session/roles.ts (role bundles over the existing fields; SessionEntry composes them)
export interface ObserveRole { refs: RefRegistry; snapshotSubstrate: SnapshotSubstrate; console: ConsoleBuffer; }
export interface NetworkRole { network: SessionNetworkRing; ws: SessionWsRing; networkSubstrate: NetworkSubstrate; }
export interface PolicyRole  { dialog: DialogPolicyState; permission: PermissionPolicyState; notification: NotificationPolicyState; fsPicker: FsPickerPolicyState; }

// The full entry is still one object — composed, not re-shaped, so no field moves at runtime.
export type SessionEntry = SessionCore & ObserveRole & NetworkRole & PolicyRole /* … */;
```

### OCP win

| Extension | Before | After |
|-----------|--------|-------|
| Add a host helper used by one family | edit the 35-member `ToolHost` interface; every consumer recompiles | add the member to the one sub-port that family depends on |
| A handler's contract | implicitly "all 35" — a reader cannot tell what it touches | the function signature *is* the dependency list (GateHost & SessionHost & …) |

Enforced by **L4 — Segregated contracts** (an interface-member budget that fails the build when a single port exceeds its cap, plus the dependency-cruiser "ToolHost split" rule). The win is also documentary: the segregated signature makes a handler's real dependencies legible to the next agent without reading the body.

---

## 4. THE `PolicyBuffer` BASE (D4)

### Smell — five policy classes share a verbatim buffer+record body

Five sibling policy classes each maintain an identical bounded ring with the same four methods. Category **DRY**, severity **high**. Evidence (audit session#0):

| Class | File | The shared body |
|-------|------|-----------------|
| `DialogPolicyState` | `src/session/dialog.ts:60-99` | `buffer: T[]` + `cap` + `record` + `since` + `raisedSince` |
| `PermissionPolicyState` | `src/session/permission.ts:134-183` | identical |
| `NotificationPolicyState` | `src/session/notification.ts:113-148` | identical |
| `FsPickerPolicyState` | `src/session/fs-picker.ts:148-181+` | identical |
| `DeviceEmulationState` | `src/session/device-emu.ts:155-195` | identical |

The verbatim shape, from `dialog.ts:62-99`:

```typescript
// BEFORE — src/session/dialog.ts:62-99 (copy-pasted into 4 sibling classes)
private buffer: DialogRecord[] = [];
private readonly cap: number;            // hard bound so a chatty page can't grow it
record(rec: DialogRecord): void {
  this.buffer.push(rec);
  if (this.buffer.length > this.cap) this.buffer.shift();
}
since(since: number): DialogRecord[] {
  return this.buffer.filter((r) => r.ts >= since);
}
raisedSince(since: number): boolean {
  return this.buffer.some((r) => r.ts >= since && r.handledAs === "raised");
}
```

A bug in the cap logic (off-by-one, timestamp comparison) must be fixed in five places; a sixth policy (`StoragePolicyState`) copies the pattern a sixth time. The bound is also load-bearing — this is L7 territory — so five independent copies of the bound is five places it can drift.

### Intent — **Template Method via composition** (a generic `PolicyBuffer<TRecord>` the five classes delegate to)

Extract the bounded ring once as a generic over any record with a `ts: number`; each policy class composes one instance and forwards. Composition over inheritance keeps each policy free to own its policy-specific state (`policy`, `wired` WeakSet) while sharing the buffer.

### After — `PolicyBuffer<TRecord>` + thin policy classes

```typescript
// AFTER — src/session/policy-buffer.ts (new; the one home for the bounded record ring)
/** A bounded, timestamp-ordered record ring. The single source of the buffer+cap
 *  discipline the five policy classes shared. `TRecord` is constrained to carry a
 *  `ts` so `since` is uniform — the audit's "standardise field naming on ts" fix. */
export class PolicyBuffer<TRecord extends { ts: number }> {
  private readonly buffer: TRecord[] = [];
  constructor(private readonly cap = 200) {}

  /** Append; drop the oldest past `cap`. The one place the bound lives. */
  record(rec: TRecord): void {
    this.buffer.push(rec);
    if (this.buffer.length > this.cap) this.buffer.shift();
  }
  since(ts: number): TRecord[] {
    return this.buffer.filter((r) => r.ts >= ts);
  }
  /** Predicate over the window — each policy passes its own "raised" test. */
  matchedSince(ts: number, pred: (r: TRecord) => boolean): boolean {
    return this.buffer.some((r) => r.ts >= ts && pred(r));
  }
}
```

`DialogPolicyState` becomes a thin owner of policy state plus a `PolicyBuffer`:

```typescript
// AFTER — src/session/dialog.ts (the buffer body is gone; only dialog-specific logic remains)
export class DialogPolicyState {
  private policy: DialogPolicy;
  private readonly records: PolicyBuffer<DialogRecord>;
  private readonly wired = new WeakSet<Page>(); // dialog-specific, stays

  constructor(initial: DialogPolicy = { mode: "raise" }, cap = 200) {
    this.policy = normalise(initial);
    // Forward the cap so a non-default bound is honored — the current class
    // stores `this.cap = cap` and `record` enforces it (`dialog.ts:71-82`);
    // dropping it here would silently ignore any non-default cap.
    this.records = new PolicyBuffer<DialogRecord>(cap);
  }
  current(): DialogPolicy { return { ...this.policy }; }
  record(rec: DialogRecord): void { this.records.record(rec); }
  since(since: number): DialogRecord[] { return this.records.since(since); }
  raisedSince(since: number): boolean {
    return this.records.matchedSince(since, (r) => r.handledAs === "raised");
  }
}
```

The other four collapse the same way; the policy-specific predicate (`handledAs === "raised"`, a permission grant test, etc.) is the only varying line.

### OCP win

| Extension | Before | After |
|-----------|--------|-------|
| Fix a buffer-cap bug | edit the body in 5 classes | edit `PolicyBuffer` once |
| Add a 6th policy class | copy the full buffer+record body | compose `new PolicyBuffer<TRecord>()` and forward |

Enforced by the **`jscpd` duplication budget** (L-derived; see D11) — the five-fold copy is exactly the duplication a budget catches and bans from re-accruing. The bound moving into one place also satisfies **L7 — Bounded everything** with a single tested cap instead of five.

---

## 5. THE `actionTool()` WRAPPER (D4)

### Smell — a seven-step action body repeated ~50×

Every action handler runs the same seven-step pipeline (audit tools-and-seam#9). Category **DRY**, severity **medium**, but high-leverage because the repeat count is ~50 and because the steps include the *error-handling and gating* posture — if the refusal shape changes, fifty handlers must change. The seven steps, verbatim from `click` (`src/tools/action-tools.ts:66-85`):

```typescript
// BEFORE — src/tools/action-tools.ts:66-85 (the same 7 steps in click/fill/press/shortcut/hover/select/…)
async (args) => {
  const g = host.gateCheck("click");                                   // 1. capability gate
  if (g) return g;
  const e = await host.entryFor(args.session);                          // 2. resolve session entry
  const c = await confirmByobAction("click", host.confirmCtxFor(e));    // 3. confirm hook
  if (!c.ok) return host.denyContent("click", c);
  const target = host.asTarget(args, "click", e.refs);                  // 4. resolve target
  const td = host.actionTimeout(args);                                  // 5. anti-wedge deadline
  return host.asActionResultText(                                       // 7. envelope
    host.actionsFor(e).click({ target, /* … */ deadlineMs: td.ms }),    // 6. actionsFor(e).<verb>
  );
}
```

`fill` (`:95-115`), `press` (`:128-146`), `shortcut` (`:164+`), and ~46 others are the same skeleton with the verb and arg-mapping swapped. The engine-gate step (`engineGate`) is sometimes present, sometimes forgotten — the inconsistency the audit also flags (tools-and-seam#10): unwrapped handlers can leak an unhandled rejection.

### Intent — **higher-order wrapper / Decorator** (one `actionTool()` owns the pipeline; the body supplies only step 6)

A single higher-order function takes the tool name, its options (which gates/confirm it needs), and a `body` that does only the engine-agnostic dispatch. The wrapper guarantees the gate → entry → confirm → target → timeout → engineGate sequence and the envelope, uniformly, for every action tool — making the catch-all and the engine-gate *structural* rather than per-handler discipline.

### After — `actionTool(name, opts, body)`

```typescript
// AFTER — src/tools/action-tool.ts (new; the one home for the 7-step pipeline)
interface ActionToolOpts {
  /** The confirm hook this tool runs (byob-action / navigation / none). */
  confirm?: "byob-action" | "navigation" | "none";
  /** Whether the tool needs a resolved target (press/shortcut can be target-less). */
  requiresTarget?: boolean;
}

/** Register an action tool: the wrapper runs gate → entry → confirm → target →
 *  timeout → engineGate and wraps the body in the standard ActionResult envelope
 *  and a catch-all. `body` does ONLY the engine-agnostic dispatch (step 6). */
function actionTool(
  host: RegisterHost & GateHost & SessionHost & ActionHost & EnvelopeHost, // RegisterHost: host.register
  name: string,
  def: { description: string; meta: ToolMeta; inputSchema?: z.ZodRawShape },
  opts: ActionToolOpts,
  body: (ctx: {
    args: Record<string, unknown>;
    e: SessionEntry;
    actions: ActionSubstrate;
    target?: ResolvedTarget;
    deadlineMs: number;
  }) => Promise<unknown>,
): void {
  host.register(name, def, async (args) => {
    const g = host.gateCheck(name);                                    // 1
    if (g) return g;
    const e = await host.entryFor((args as { session?: string }).session); // 2
    const eg = host.engineGate(name, e);                               // engine gate — now never forgotten
    if (eg) return eg;
    if (opts.confirm && opts.confirm !== "none") {                     // 3
      const c = await runConfirm(opts.confirm, name, host.confirmCtxFor(e));
      if (!c.ok) return host.denyContent(name, c);
    }
    const target = opts.requiresTarget !== false                       // 4
      ? host.asTarget(args as RawTargetArgs, name, e.refs)
      : undefined;
    const td = host.actionTimeout(args as { timeoutMs?: number });     // 5
    return host.asActionResultText(                                    // 7 (+ catch-all inside)
      body({ args, e, actions: host.actionsFor(e), target, deadlineMs: td.ms }), // 6
    );
  });
}
```

`click` shrinks to its one engine-agnostic line:

```typescript
// AFTER — src/tools/action-tools.ts (click is now just step 6)
actionTool(host, "click",
  { description: "Click an element …", meta: { capability: "action", batchable: true }, inputSchema: CLICK_SCHEMA },
  { confirm: "byob-action" },
  ({ actions, target, args, deadlineMs }) =>
    actions.click({ target: target!, button: args.button as Button, force: args.force as boolean, deadlineMs }),
);
```

### OCP win

| Extension | Before | After |
|-----------|--------|-------|
| Change the action pipeline (e.g. add a metrics step) | edit ~50 handler bodies | edit `actionTool` once |
| Add a new action tool | copy the 7-step skeleton, hope you include `engineGate` and the catch-all | one `actionTool(...)` call; the pipeline is guaranteed |

Enforced by **L3 — One reason to change** (the `max-lines-per-function` budget — a handler that re-inlines the pipeline exceeds it) and by a lint rule that flags an action handler calling `host.register` directly instead of `actionTool`. The wrapper also closes the error-handling inconsistency (tools-and-seam#10): the catch-all is now structural.

---

## 6. THE `EgressSanitiser` CHOKEPOINT (D4)

### Smell — masking is hand-called at each sink; forgetting it leaks

Secrets-masking + URL-sanitisation is a *discipline*, not a *guarantee*. Category **error-handling / spaghetti**, severity **medium**, but the consequence is a data leak. Evidence:

- The composition helper exists but is **optional**: `composeUrlAndSecretsInText` (`src/util/secrets.ts:256`) applies URL-sanitiser then secrets-masking in the right order — but a caller must *remember* to invoke it (audit policy-util#3).
- `src/page/network.ts` reimplements the fold+mask three times (`foldInteresting` at `:140`; `NetworkTap.close` inlines it at `:259-263`; `NetworkBuffer.recent`/`iter` again at `:677`) — and `iter()` (`network.ts:66`, `:663`, `:933`) returns a **raw, unmasked snapshot** by design, so a handler that returns `iter()` results leaks raw URLs (audit page-features#1,#7).
- Diagnostics masks args by calling `applyMaskDeep` directly (`src/util/secrets.ts:183`) without the URL pass — different sinks apply different subsets of the masking.

The pattern is "remember to call the masker at every output path." There is no compile-time signal that an output path is unmasked.

### Intent — **the Chokepoint pattern** (one injected `EgressSanitiser` every output path routes through; absence is a type error)

Introduce one `EgressSanitiser` that owns the URL-sanitiser + the `SecretRegistry` and exposes the only masking surface. Inject it into every sink. A new output path *cannot compile* without a sanitiser argument — masking moves from discipline to type-enforced guarantee.

### After — `EgressSanitiser` injected into sinks

```typescript
// AFTER — src/util/egress.ts (new; the single masking surface)
import type { SecretRegistry } from "./secrets.js";
import { sanitizeUrl, sanitizeUrlsInText } from "./url-sanitizer.js"; // American spelling; real exports
import type { NetworkEntry } from "../page/network.js";

/** A branded output type only this chokepoint can mint — the SAME branded type as
 *  the maintainability standard (0004-02 §4.3). A handler that builds a ToolResponse
 *  from a raw `string` instead of a `SanitisedText` no longer compiles, so masking
 *  is a *compile-time* guarantee, not a discipline. */
export type SanitisedText = string & { readonly __egress: unique symbol };

/** The one masking chokepoint. Composes URL-sanitisation and secrets-masking in
 *  the audited order. Every sink that produces client-facing output takes one of
 *  these — a new sink can't compile without it, and can't return un-branded text. */
export class EgressSanitiser {
  constructor(private readonly secrets: SecretRegistry | null) {}

  /** URL-sanitise then secrets-mask a single string, minting the branded type.
   *  (Was composeUrlAndSecretsInText — same composition, now a chokepoint the
   *  dispatcher owns and the type system enforces.) */
  maskText(text: string): SanitisedText {
    const urlClean = sanitizeUrlsInText(text);
    return (this.secrets ? this.secrets.applyMaskInText(urlClean) : urlClean) as SanitisedText;
  }
  /** Deep-mask any structured payload. (Was the bare applyMaskDeep at each call site.) */
  maskDeep<T>(value: T): T {
    return this.secrets ? this.secrets.applyMaskDeep(value) : value;
  }
  /** Mask a network entry's url+payload — the one fold the three network.ts copies share. */
  maskEntry(e: NetworkEntry): NetworkEntry {
    return { ...e, url: sanitizeUrl(e.url) };
  }
}
```

A network sink takes the sanitiser instead of re-implementing the fold; `NetworkBuffer.recent` and `NetworkTap.close` both route through `maskEntry`, retiring the three duplicate copies. The unmasked `iter()` is renamed to `rawIter()` so the absence of masking is *named*, and the masked path is the default a sink reaches for. A handler's client-facing text path is typed `SanitisedText`, so an unmasked `string` cannot be returned:

```typescript
// AFTER — src/page/network.ts (one fold, sanitiser-injected; raw access is loudly named)
class NetworkBuffer {
  constructor(private readonly egress: EgressSanitiser /* … */) {}
  /** Masked snapshot — the default a tool returns. */
  recent(limit: number): readonly NetworkEntry[] {
    return foldInteresting(this.ring.slice(-limit)).map((e) => this.egress.maskEntry(e));
  }
  /** UNMASKED. Internal callers only; the name is the warning. */
  rawIter(): readonly NetworkEntry[] { return this.ring; }
}
```

### OCP win

| Extension | Before | After |
|-----------|--------|-------|
| Add a new output sink | remember to call `composeUrlAndSecretsInText` (or leak) | the sink's constructor *requires* an `EgressSanitiser` — omitting it is a compile error |
| Change the masking order/rule | edit each hand-call site (4+ in network.ts alone) | edit `EgressSanitiser` once |

Enforced by **L2 / L6 — Validate at the edge** (the masking becomes a *compile-time* guarantee, the parent RFC's exact phrasing for D4(d)) and a dependency-cruiser rule that forbids a tool-layer module from importing `SecretRegistry` directly — output goes through the chokepoint, never around it.

---

## 7. SWITCH → REGISTRY (D6)

### Smell — five extensibility points are `switch`/stringly-map over real, multi-case seams

Every one of these has multiple real cases *today* (so the seam is proven, not speculative), yet each adds a case by editing a central conditional. Category **OCP**, severity **medium**.

| Switch | Evidence | Cases today |
|--------|----------|-------------|
| CLI subcommand | `src/cli.ts:46-86` (`switch (subcommand)`) | doctor / chrome / init / serve / plugin |
| Plugin-CLI subcommand | `src/plugin/cli.ts:503-537` | install / remove / list / info / upgrade / sync |
| SDK transport | `src/sdk/index.ts:206-231` (`switch (mode)`) | in-process / stdio-child / socket |
| Perf analysers | `src/page/perf-audit.ts:88-97` (`ANALYSERS` record) **+** `AuditCategory` union (`:23-31`) **+** `ALL_AUDIT_CATEGORIES` array (`:33-42`) | 8 categories, **3 edit sites each** |
| Session mode / PM verbs | `src/session/types.ts:9` mode literals; `src/plugin/cli.ts:151-160` `PM_VERBS` | managed/byob; pnpm/npm |

The perf analyser registry is the sharpest case because architecture-principles §2 *cites it as browxai's OCP exemplar* — yet its implementation needs three coordinated edits to add a category (the `ANALYSERS` record, the `AuditCategory` union, the `ALL_AUDIT_CATEGORIES` array), and a typo in a category string is silently dropped at `composeReport` (audit page-features#3). The exemplar is not exemplary.

```typescript
// BEFORE — src/page/perf-audit.ts:23-97 (one fact — "the audit categories" — stated three times)
export type AuditCategory = "render-blocking" | "unused-code" | /* … */ | "font-loading";       // :23-31
export const ALL_AUDIT_CATEGORIES: AuditCategory[] = ["render-blocking", /* … */];               // :33-42
export const ANALYSERS: Record<AuditCategory, AuditCategoryAnalyser> = {
  "render-blocking": analyseRenderBlocking, /* … */ "font-loading": analyseFontLoading,          // :88-97
};
```

```typescript
// BEFORE — src/sdk/index.ts:206-231 (composition root edits to add a transport)
switch (mode) {
  case "in-process":   transport = await openInProcessTransport(/* … */); break;
  case "stdio-child":  transport = await openStdioChildTransport(/* … */); break;
  case "socket":       /* endpoint guard */ transport = await openSocketTransport(/* … */); break;
  default: throw new Error(`browxai-sdk: unknown transport "${String(mode)}"`);
}
```

### Intent — **Registry** (the `Map<key, factory>` registered add-only). The perf case additionally uses **derive-from-the-source** so the union and array stop being a second/third source of truth.

### After — the analyser registry made actually data-driven, and a transport factory map

The perf-audit exemplar, fixed so the category set is declared **once** and the type + array derive (the audit's own `as const` fix):

```typescript
// AFTER — src/page/perf-audit.ts (one source of truth; union + array derive; OCP exemplar made real)
export const ANALYSERS = {
  "render-blocking":    analyseRenderBlocking,
  "unused-code":        analyseUnusedCode,
  "oversize-images":    analyseOversizeImages,
  "layout-thrashing":   analyseLayoutThrashing,
  "long-tasks":         analyseLongTasks,
  "leak-suspects":      analyseLeakSuspects,
  "cache-opportunities":analyseCacheOpportunities,
  "font-loading":       analyseFontLoading,
} as const satisfies Record<string, AuditCategoryAnalyser>;

export type AuditCategory = keyof typeof ANALYSERS;                          // derived — was :23-31
export const ALL_AUDIT_CATEGORIES = Object.keys(ANALYSERS) as AuditCategory[]; // derived — was :33-42
```

The SDK transport switch becomes a factory registry — a fourth transport is a registration, not a composition-root edit:

```typescript
// AFTER — src/sdk/transport-registry.ts (add-only; the SdkTransport contract is the real one from transport.ts)
// There is no TransportMode type today — derive it from the real options union
// (`BrowxaiSdkOptions.transport?: "in-process" | "stdio-child" | "socket"`,
// src/sdk/types.ts:132) so the registry key stays in lockstep with the SDK surface:
export type TransportMode = NonNullable<BrowxaiSdkOptions["transport"]>;

export interface TransportFactory {
  open(opts: BrowxaiSdkOptions): Promise<SdkTransport>;
}
const TRANSPORTS = new Map<TransportMode, TransportFactory>();
export function registerTransport(mode: TransportMode, factory: TransportFactory): void {
  TRANSPORTS.set(mode, factory);
}
export function openTransport(mode: TransportMode, opts: BrowxaiSdkOptions): Promise<SdkTransport> {
  const f = TRANSPORTS.get(mode);
  if (!f) throw new Error(`browxai-sdk: unknown transport "${String(mode)}"`);
  return f.open(opts);
}
// registerTransport("in-process", { open: (o) => openInProcessTransport(o) }); … per transport file
```

`createBrowxai` (`sdk/index.ts:197`) loses its switch and calls `openTransport(mode, opts)`. The CLI subcommand switches (`cli.ts:46`, `plugin/cli.ts:503`) become a `Map<string, CommandHandler>` populated once at load (the `--version`/`--help`/unknown branches stay as the literal fast paths they are). `PM_VERBS` (`plugin/cli.ts:151-160`) becomes a `PackageManagerAdapter` interface with pnpm/npm implementations.

### OCP win

| Extension | Before | After |
|-----------|--------|-------|
| Add a perf category | 3 edits (record + union + array), typo silently dropped | 1 edit (the record); type + array derive; typo is a compile error |
| Add a transport | edit the `switch` in the composition root | `registerTransport(...)` in a new transport file |
| Add a CLI subcommand | edit the `switch` | register a `CommandHandler` |

Enforced by **D6 / L1** and the **dependency-cruiser layering rule** (the SDK composition root may not grow per-transport `import`s). The perf-audit fix specifically discharges the parent RFC's note that the cited exemplar must become genuinely exemplary.

---

## 8. THE SAFARI `page()` CAPABILITY (D5)

### Smell — `page()` throws on Safari → 17 defensive guards leak the no-Page seam everywhere

`BrowserSession.page()` is typed as a total method returning `Page` (`src/session/types.ts:86`, documented as throwing at `src/session/types.ts:95`), but the Safari implementation *throws unconditionally* at `src/session/safari-session.ts:35` (`NO_PLAYWRIGHT_PAGE`). That is a Liskov violation: a `BrowserSession` is not substitutable, because calling a contract method crashes on one implementation. The symptom is 17 defensive `sess.engine !== "safari"` guards scattered through `session-registry.ts` (`:266,280,292,301,332,338,349,383,408,441,451,457,479,536,550,584,589`) — every caller that wants `page()` must first check the engine by name. Category **LSP**, severity **high** (audit session#2, engine-adapters#4).

```typescript
// BEFORE — src/session/types.ts:86 — a total method one implementation can't honour
export interface BrowserSession {
  readonly engine: EngineKind;
  page(): Page;            // Safari: THROWS. The 17 guards are the leak this creates.
  cdp?(): CDPSession;      // already correctly optional/capability-gated
  safari?(): SafariSessionHandle;
  close(): Promise<void>;
}
```

```typescript
// BEFORE — src/tools/session-registry.ts (one of 17; the engine name leaks into the factory)
if (sess.engine !== "safari") attachDialogPolicy(sess.page().context(), dialogState); // :338
```

Note the codebase already got `cdp?()` right — it is optional and consumers route through `requireCdp()` with a structured error (`types.ts:87-92`). And `safari?()` is *already* the correct capability shape (`src/session/types.ts`). The residual defect is that `page()` is still typed total, so the no-Page seam leaks as 17 runtime guards rather than a compile-time narrowing.

### Intent — **make absence a type, not a throw** (the capability is *declared*, callers must *narrow*; the no-Page handling lives once in `EngineRegistry.postWire`)

Type `page()` as optional — present only when the engine has a Playwright Page — so the type system *forces* a caller that needs it to narrow, exactly as `cdp?()` already does. The 17 guards move into the single `EngineRegistry.postWire` (Pattern 1), where each engine's definition attaches only the bookkeeping it supports. The port-conformance contract test then forbids any port method that throws unconditionally — the smell can never recur.

### After — `page?()` optional + the guards relocated to `postWire`

```typescript
// AFTER — src/session/types.ts (page is a capability; absence is typed, like cdp/safari already are)
export interface BrowserSession {
  readonly engine: EngineKind;
  /** The Playwright Page — present ONLY on Playwright-backed engines. Absent on
   *  Safari (no-Page). A caller that needs it must narrow (`if (s.page)`); the
   *  type system enforces what 17 runtime guards used to. */
  page?(): Page;
  cdp?(): CDPSession;
  safari?(): SafariSessionHandle;
  close(): Promise<void>;
}
```

A Playwright-only caller narrows once; the 17 inline guards become each engine's own `postWire`:

```typescript
// AFTER — the Playwright engine definition owns its post-wire; Safari owns its minimal one
// (in registerEngine(...) for each Playwright engine)
postWire: (entry) => {
  const ctx = entry.session.page!().context(); // narrowed: this branch only runs for Page-bearing engines
  attachConsole(ctx, entry.console);
  attachDialogPolicy(ctx, entry.dialog);
  attachDownloadCapture(ctx, entry.downloads);
  // … the other 15 attaches, in one place, no engine-name check
},
```

```typescript
// AFTER — Safari's definition attaches only what it supports — the guards have no reason to exist
postWire: (entry) => attachSafariConsoleBidi(entry), // console over BiDi; nothing Page-bound
```

The audit's "remove the runtime refusal from `SafariActionSubstrate`" recommendation (page-core#5) is the same principle one layer down: with the capability gate (`engineGate`) refusing unsupported tool/engine pairs *before* dispatch, a substrate method should never be reached for an action it can't do — so it implements only what it supports rather than returning `safariUnsupportedAction(...)` at runtime. The ISP split of `ActionSubstrate` into `BaseActionSubstrate` (navigate/click/fill/press) + role interfaces (page-core#1) means Safari *can't* be forced to implement methods it refuses — unsupported becomes a compile error, not a runtime envelope.

### OCP win

| Extension | Before | After |
|-----------|--------|-------|
| Add a non-Playwright engine (no Page) | add a 19th, 20th, … `engine !== "<engine>"` guard at every `page()` site | the type forces narrowing; the engine's `postWire` attaches its own set; **zero guards** |
| A caller that needs `page()` | nothing stops it calling `page()` on Safari → runtime crash | `page` is `Page | undefined` — the compiler requires the narrow |

Enforced by **L5 — Substitutable adapters** (the port-conformance contract test runs against *every* adapter, including a synthetic one, and **fails on any port method that throws unconditionally**) and **L1** (no caller may branch on engine name to compensate for a leaky port). This makes the Safari no-Page seam — which RFC 0002/0003 introduced as the project's first non-Playwright engine — a typed capability rather than 17 places to remember.

---

## Cross-cutting: why these eight, and how they compose

The patterns are not independent fixes; they reinforce. **Pattern 1 (`EngineRegistry`)** is the keystone — it absorbs the substrate selectors (the DRY half of its own smell), gives Pattern 8 its home for the relocated guards, and reads `capabilities.deep` so the deep gate stops carrying engine knowledge. **Pattern 2 (metadata-at-registration)** makes `DEEP_TOOLS` derivable, which closes the last engine-aware central list. **Pattern 3 (port segregation)** is what makes **Pattern 5 (`actionTool`)** legible — the wrapper's `body` depends on `ActionHost & EnvelopeHost`, not the 35-member bag. **Pattern 6 (`EgressSanitiser`)** and **Pattern 4 (`PolicyBuffer`)** are the two DRY extractions that turn discipline into structure (a compile-time masking guarantee; a single bounded ring). **Pattern 7 (switch → registry)** generalizes the registry move to the CLI/transport/analyser/mode seams the audit proved are multi-case today.

Every AFTER block above is a *target shape*, reached strangler-fig: the registry lands behind the existing call sites, the maps derive alongside the hand-lists until the completeness test confirms parity, then the hand-lists are deleted. No pattern changes external behavior; the five-engine keystone suite is the regression gate throughout. The fitness function that *keeps* each pattern true — the lint rule, the contract test, the budget — is the inseparable other half, specified in [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md). Without it, these patterns are documentation that the next agent can drift past; with it, the drift is a red build.

---

## References

- [`../0004-architecture-hardening.md`](../0004-architecture-hardening.md) — the parent RFC: the thesis, the ten laws (L1–L10), the decisions (D1–D12), the phasing. This catalogue realizes **D1–D7**.
- [`0004-01-current-state-audit.md`](0004-01-current-state-audit.md) — the adversarial audit: the 80 findings with file:line evidence and the OCP extension-scenario tables this document's "before" columns draw from.
- [`0004-02-maintainability-standard.md`](0004-02-maintainability-standard.md) — the ten laws in full, with the safety-critical lineage each enforcer derives from.
- [`0004-04-refactor-plan.md`](0004-04-refactor-plan.md) — the sequenced, behavior-preserving rollout from each "before" to each "after," with per-phase file inventories and rollback.
- [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md) — the executable enforcer for every pattern here: `no-engine-literal-branches`, the engine-adapter-contract keystone, the completeness/port-conformance tests, the size/complexity/duplication budgets, the dependency-cruiser layering.
- [`../0002-multi-engine-bidi.md`](../0002-multi-engine-bidi.md) — the `BrowserEngine` port these registries close over.
- [`../0003-capability-ports-decoupling.md`](../0003-capability-ports-decoupling.md) — the capability substrates Patterns 1, 3, and 8 build on; its line-range module decomposition is the SRP debt Pattern 3 (D3) pays down.
- [`../../ai-context/architecture/architecture-principles.md`](../../ai-context/architecture/architecture-principles.md) — the doctrine extended here: §1 (proven-seam test), §4 ("new engine = new adapter" — the claim Pattern 1 makes true), §2 (the perf-analyser OCP exemplar Pattern 7 makes real).
- [`../../ai-context/agent-process/code-quality.md`](../../ai-context/agent-process/code-quality.md) — the micro-rules these macro patterns sit above; the comment-hygiene and no-inline-disable norms apply to every AFTER block.
