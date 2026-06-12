# Architecture principles - the Kalebtec doctrine

The macro layer of how we build. Identical across browxai, docsxai, and remotxai;
each repo leads with its own exemplars, but the principles are the same doctrine.
New Kalebtec projects adopt it on day one.

## Purpose, and how this relates to code-quality.md

[`code-quality.md`](../agent-process/code-quality.md) is the **micro** layer:
SOLID-in-TypeScript, naming, function shape, comment discipline, the
no-half-finished rule. This doc is the **macro** layer: where the boundaries
are, which direction dependencies point, which seams are real, and where the
performance budget lives. Both bind on every change. A module can pass every
micro rule and still violate the architecture (a clean, well-named handler that
inlines its own capability check instead of calling the shared gate is tidy and
wrong). Read this first when the change moves a boundary, adds a surface that acts
on the world, or sits on a hot path. Read code-quality.md when shaping the code
inside a boundary that already exists.

The bar is the same one code-quality.md sets: elegance and pragmatism over speed
and convenience, with **performance as a design input, not an afterthought.**

## 1. Dependency direction and boundaries

The load-bearing rule: **the core depends on nothing outward.** Outward concerns
(protocols, IO, vendors, model providers, transports) are adapters that sit
behind a port the core owns. Dependencies point inward, toward the domain, never
out toward the framework.

browxai illustrates this through its seams:

- **Handlers depend on abstractions, not concrete backends.** Server handlers
  take abstract `Page` / `BrowserContext`, not a concrete CDP implementation;
  swapping the backend doesn't change handler code. The SDK depends on a
  `Transport` abstraction, not WebSocket / stdio specifics - the three transports
  (in-process, stdio-child, socket-attached) all conform to one port.
- **The plugin runtime is a dependency-inverted port.** Plugins call
  `api.callTool(...)` / `api.registerTool(...)` through the `PluginApi`
  interface; they never reach into browxai internals. An external package adds
  tools without any change to the core - substrate-level open/closed.
- **browxai is BYO-vision by design.** It does not bundle OCR or a hosted vision
  API. browxai's job is the substrate - pixels (`canvas_capture`), gestures,
  transform math, plugin dispatch; _understanding_ the pixels is the host agent's
  multimodal call. The model provider is an outward concern that lives in the
  caller, not in the server. This is the same boundary discipline docsxai applies
  when it refuses to import a model SDK into its engine.

The family echoes this everywhere: docsxai's engine sits behind a `BrowserDriver`
port (only `playwright-driver.ts` imports `playwright-core`) and routes all IO
through one `resolveWorkspacePath` chokepoint; remotxai's
`packages/adapter-contract` is the single Zod-schema source of truth that every
harness adapter (Claude Code, Codex, Pi) and the daemon build against - the
hexagonal host-core/adapters split made concrete.

### The honest tension: abstract only at a proven seam

A port you do not need is tech debt, the same as a missing one. Speculative
generality is the more seductive failure because it looks like good architecture.
**The test:** is there a second real implementation today, or a committed
near-term need? If yes, the seam is proven - build the port. If no, write the
concrete thing and inline it.

- browxai's `Transport` abstraction is **proven**: three transports conform to it
  today. The plugin runtime's `PluginApi` is **proven**: the workspace plugins
  (`example`, `figma`, `tldraw`, `excalidraw`) are real second implementations.
- docsxai's `BrowserDriver` is **proven**: `PlaywrightDriver` plus browxai as the
  real second driver. remotxai's adapter-contract is **proven**: three adapters.
- A single-implementation interface with no second consumer on the horizon is
  **usually not** - it adds an indirection, a file, and a lie ("this is
  swappable") for no payoff. Note the deliberate exceptions browxai _does_ allow,
  like `canvas_query({adapter, op, args})`'s inner-`op` dispatch at the canvas
  substrate layer: that is a substrate seam with real adapters behind it, not a
  pattern to copy into ordinary tools.

When in doubt, prefer the concrete code. Extracting a port from working code is a
cheap, safe refactor; deleting a speculative port that the codebase has grown
around is not.

## 2. Simplicity and YAGNI, reconciled with "perfect architecture"

"Perfect architecture" does not mean maximal architecture. It means **the
simplest design that honors the proven seams** - no fewer boundaries (the core
must stay clean), no more (every speculative port is deleted). The two pulls
resolve cleanly once you separate proven from speculative: hold the proven seams
without compromise, and refuse every unproven one.

The family's own cautionary tale is docsxai's dropped `DiscoveryStage` /
`MappingStage` / `CommitStage` pipeline (a deleted `pipeline.ts`). The original
design put the agent-orchestration loop **inside the engine** as resumable stage
objects. In practice, browxai's own MCP surface plus the calibrate-skill playbook
covered the same ground with no bespoke in-engine state machine. The lesson:
agent orchestration belongs in the agent's tooling layer, not duplicated in a
substrate. browxai holds the same line - the server is a curated tool surface,
not an agent loop; the inference loop lives in the host. Removing the premature
abstraction made the system smaller **and** more correct.

Concrete rules that follow:

- Three similar lines beat a premature abstraction. The `perf_audit` analyser
  registry exists because LCP / CLS / layout-thrash / memory are real, distinct
  categories - not because a registry looked clean. Extract on real divergence.
- No feature flags or compat shims when you can just change the code. Graceful
  input deprecation goes through the `RETIRED_*` registry pattern, not scattered
  shims. No `// removed`, no `_var` re-exports.
- Don't add error handling for states that can't occur. Validate at the system
  boundary (MCP wire, config parser, the Playwright/CDP edge); trust internal
  code past it.

## 3. Performance at the core

Performance is a design input. It shapes the boundary you draw, the buffer you
bound, the data you copy. But it is **measured, not guessed** - profile before
you optimize, and never trade a proven seam for a micro-optimization you can't
demonstrate.

**Hot path vs cold path.** Spend your optimization budget where the work is
continuous; leave the rare path simple. browxai draws this line per tool by
capability: `read` / `navigation` / `action` are on by default and run
constantly, so they are bounded by anti-wedge deadlines; a `diagnostics` run
(recorder, `perf_audit`, coverage, `layout_thrash_trace`, `memory_diff`) is
off-by-default and tolerates cost because it's rare. docsxai makes the same split
structural: calibration is rare and latency-tolerant, execution is continuous and
deterministic - and only the continuous loop earns careful allocation discipline.

**Bound the buffer; stream over slurp.** Unbounded reads are a latency and memory
bug waiting for a big input. The family bounds at the edge:

- browxai caps `canvas_capture` at 16384×16384 px, floors `gesture_chain`'s
  `move` at 5 ms and clamps `wait` at 5000 ms, and prefers a bounded-window
  `watch` poll over unbounded repeated calls - never regress to unbounded calls.
- `network-body` (full response bodies) is off-by-default partly because
  unbounded body capture is a cost; metadata-only `network_read` is the on path.
- docsxai truncates page-DOM snippets before they enter halt context and applies
  screenshot redaction in-memory before any byte hits disk; its blobs are
  content-addressed by sha256, so identical content is stored once.

**The cost of abstraction on a hot path.** A port indirection is nearly free on a
cold path and worth it for the seam. On a tight inner loop - a page-side function
running per element, a gesture program dispatching per step - an extra allocation
per iteration can matter, but only measurably. The rule: keep the seam at the
boundary; if a hot inner loop needs the concrete type, inline within the adapter,
never by collapsing the boundary the whole system depends on.

**Determinism where it pays.** A deterministic surface is what makes caching,
replay, and regression-diffing correct rather than hopeful. browxai's recorder /
replay path and docsxai's byte-identical `docsxai run` both lean on this; both are
keystone-tested against real Chromium so the determinism claim is verified, not
asserted.

## 4. Scalability seams - where the system grows

Growth should be **open/closed**: add a new file at a known extension point,
don't edit the core. The family's seams:

- **New engine / driver / backend = new adapter behind the existing port.** A new
  CDP backend behind `Page` / `BrowserContext`, a new SDK transport behind
  `Transport`, a second `BrowserDriver` in docsxai, a new harness adapter against
  remotxai's contract - none touch the core.
- **New capability = a new gated interface.** Anything posture-broadening (eval,
  network-body, byob-attach, clipboard, file-io, secrets, extensions, canvas, …)
  lands off-by-default behind a declared capability, with a per-tool keystone test
  asserting the gate blocks when not granted - in the same diff that adds it. See
  [`capability-posture-map.md`](capability-posture-map.md).
- **New tool = compose existing ports.** A new MCP tool is one handler file plus a
  capability-map entry plus a registry line in `server.ts` (composition only, no
  business logic) - the existing tools are unchanged.
- **New plugin = `register(api)`.** An external package extends the surface
  through the plugin runtime without a core change.

Statelessness and bounded concurrency are the runtime side of this. Where
concurrency exists, it is bounded with backpressure (deadlines, step caps, poll
windows), never unbounded fan-out.

## 5. Readability and maintainability

Code reads like the domain. One tool = one file (page-side function + handler +
types together); `server.ts` is registry composition only; the capability gate
lives in one place and handlers call it. The structure mirrors the problem so the
next reader navigates by intuition.

- **One reason to change per module.** `server.ts` changes when the registry
  changes, not when a tool's logic changes. `capabilities.ts` changes when the
  gate policy changes. If two unrelated reasons touch one file, split it.
- **The next-reader test.** Write for the agent or engineer who opens this file
  cold in six months with no context. Names carry the meaning; comments state the
  non-obvious constraint, never narrate the code (the full comment discipline,
  plus the public-surface hygiene rules, are in code-quality.md - follow them,
  don't restate them here).
- **Docs-impact is part of the change.** Every behavior-change diff updates
  `tool-reference.md`, the relevant `threat-model.md` row and capability table,
  `AGENTS.md` if a rule moved, and `CHANGELOG.md`. A boundary change that isn't
  reflected in the surface docs is half-done.

## 6. The decision record

When an architecture decision is non-obvious - a new boundary, a port extracted
or refused, a posture change, a seam moved - **write down why.** Code shows what;
the record preserves the reasoning a future reader (or a future you) needs to not
re-litigate it.

- Substantive decisions get a numbered RFC under [`../../rfcs/`](../../rfcs/).
- Root-cause findings and one-off diagnoses go in `investigations/` under this
  `ai-context/` tree (e.g. the screenshot-marks latency investigation).
- Captured lessons - the dom_export / element_export page-side-function trap, the
  adopter-report-driven surface changes - live in their topical `ai-context/`
  subdirs so the rationale travels with the code it governs.

Keep provenance out of the code and the public docs (no ticket IDs, no phase
tags - code-quality.md's public-surface hygiene rule is explicit on this); keep it
in the commit body, the RFC, and this `ai-context/` tree.

## 7. Review checklist

Every change that touches a boundary, a surface, or a hot path is reviewed
against this:

- [ ] **Dependency direction respected?** Core depends inward; no vendor / IO /
      provider import leaked past its adapter. (For browxai: handlers on abstract
      `Page` / `Transport`, no vision/model SDK bundled, plugins through
      `PluginApi`.)
- [ ] **Is the seam proven?** A new abstraction has a second real implementation
      or a committed near-term need. No speculative ports.
- [ ] **Simplest design that honors the constraints?** No premature abstraction,
      no compat shim (use `RETIRED_*` for graceful deprecation), no error handling
      for impossible states. Could three lines replace the new interface?
- [ ] **Hot path measured?** If it's on a continuous path, the cost is known, not
      guessed. Buffers bounded, no careless per-iteration allocation or copy.
- [ ] **Capability-gated if it acts on the world?** New world-touching surface is
      off-by-default behind a declared capability, with a keystone denial test, in
      the same diff.
- [ ] **Docs updated?** tool-reference / threat-model / capability table /
      CHANGELOG / AGENTS.md reflect the change; the decision is recorded if it was
      non-obvious.

## Related

- [`code-quality.md`](../agent-process/code-quality.md) - the micro layer (SOLID,
  naming, function shape, comments, public-surface hygiene).
- [`repo-map.md`](repo-map.md) - the source map and the load-bearing boundaries
  this doctrine protects.
- [`capability-posture-map.md`](capability-posture-map.md) - the on-by-default /
  gated capability lattice.
- [`../testing/unit-vs-keystone.md`](../testing/unit-vs-keystone.md) - why
  boundary behavior is keystone-tested against real Chromium.
