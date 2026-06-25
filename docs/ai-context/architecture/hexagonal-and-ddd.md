# Hexagonal architecture and DDD — the layer map

How browxai is shaped, and the words it is shaped in. The macro doctrine
([`architecture-principles.md`](architecture-principles.md), §4a, laws L1–L10)
says _why_ the boundaries are where they are; this page says _where things go_
and _what to call them_. Read it when deciding where new code belongs, or before
moving a boundary.

browxai already obeys ports-and-adapters. Dependencies point **inward**: the core
depends on nothing outward, and every outward concern — a browser engine, a wire
transport, a vendor CLI, the filesystem, a page realm — sits behind a port the
core owns. The mapping below is descriptive of the code as it is, enforced by the
fitness suite ([`fitness-functions.md`](fitness-functions.md)), not an idealized
target. It is the unifying frame over the more specific
[`engine-adapters.md`](engine-adapters.md) (the engine seam) and
[`repo-map.md`](repo-map.md) (the directory index).

## The layers

Five roles, dependencies pointing inward. browxai is one npm package, not a crate
graph, so the dependency rule is enforced by dependency-cruiser
(`.dependency-cruiser.cjs`) and the custom lint rules rather than by the compiler
— see [`fitness-functions.md`](fitness-functions.md) for the exact checks.

| Role          | Where                                                                                                                                                                                                                                                                                                                                                                                                                | Holds                                                  | Never holds                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------- |
| Domain / core | `src/page/*` (a11y tree, selector synthesis + ranking, `ActionResult` shaping, extract resolution, verify vocabulary, engine-blind network shapes), `src/session/*` (session identity, the per-session policy state classes), `src/util/*` (predicate vocabulary, deadline/invariant, egress masking, the capability vocabulary), `src/policy/*` (origin lattice, confirmation), `src/plugin/{depgraph,manifest}.ts` | entities, value objects, invariants, pure algorithms   | IO, vendor types, transports, engine literals |
| Application   | the tool-handler orchestration: `src/page/{actionresult,actions,extract,plan,archive,asset-export,perf-audit}.ts`, `src/util/batch.ts`, flake-check, config-store, `src/plugin/runtime.ts` validation/load                                                                                                                                                                                                           | use cases that compose domain through ports            | concrete adapters, vendor names               |
| Ports         | the engine port (`src/engine/{types,index}.ts`), the `ToolHost` + its ISP sub-ports (`src/tools/host.ts`), the capability **substrate** ports (`src/page/*-substrate-types.ts`), the `SdkTransport` port (`src/sdk/transport.ts`), the `CredentialProvider` port, the plugin `PluginApi` (`src/plugin/types.ts`)                                                                                                     | the contracts the core owns and the outside implements | implementations                               |
| Adapters      | engine adapters (`src/engine/adapters/*`), substrate **implementations** (`src/page/*-substrate.ts`, `NetworkTap`), session attach halves (`*-attach`, `byob-attach.ts`, `launch-options.ts`), SDK transports (`src/sdk/transport-*.ts`), the `__browx` bridge (`src/helper/*`), vendor credential adapters, the plugin host adapter                                                                                 | concrete port implementations                          | business rules, cross-layer reach-in          |
| Composition   | `src/server.ts` (composition root), `src/tools/{host-build,session-registry,tool-metadata}.ts`, the six `*-tools.ts` aggregators, `src/session/{managed,incognito,byob}.ts`, the `*.engine.ts` registrations, `src/cli/*`                                                                                                                                                                                            | wiring; engine names as **data**                       | domain rules, engine **literals** in handlers |

The one non-negotiable: **an inner role never reaches outward.** A `src/page`
handler does not import a concrete engine adapter or a transport; `src/util` does
not import a handler; `src/server.ts` and `src/tools/*` do not import `src/sdk` or
`src/cli`. The dependency-cruiser rules are the gate; a new cross-layer import
fails the graph and names the rule it broke.

The page realm is a distinct adapter even though it lives beside domain code: a
`*_PAGE_SCRIPT` string constant or a `*_FN` page-side function literal is
browser-only JavaScript that runs in a different runtime, with its own reason to
change. It is an adapter to the page, not core logic, and is split out as such
(see [`module-and-file-size.md`](module-and-file-size.md)).

## Ports and adapters

A **port** is a contract the core owns because it has a real, _proven_ need —
a second implementation today or a committed one (the proven-seam test,
[`architecture-principles.md`](architecture-principles.md) §2). browxai's proven
ports, each with multiple implementations:

- **the engine port** — `chromium / firefox / webkit / safari / android` all
  implement it; engine identity lives only as data in `src/engine` tables, never
  as an `engine === "…"` branch in a handler (`no-engine-literal-branches`).
- **the capability substrate ports** (`Action` / `Capture` / `Storage` /
  `Script` / `Emulation` / `Snapshot` / `Network`) — Playwright and Safari
  implementations behind each.
- **`SdkTransport`** — in-process, socket, and stdio-child transports.
- **`ToolHost`** and its segregated sub-ports — the interface-segregation seam a
  handler depends on a narrow slice of, never the whole host.
- **`CredentialProvider`**, **`PluginApi`** — the vendor-credential and plugin
  seams.

The **composition root** is `src/server.ts`: the one place that knows both the
concrete adapters and the use cases and wires one to the other. It resolves
config, policy, and workspace, builds the `ToolHost`, runs every
`register*Tools`, wires the plugin runtime, and returns start / shutdown /
handlers. It is wiring-only — business logic in the root is a smell the size
budget (`max-lines` ≤ 280 on `server.ts`) catches.

## DDD building blocks, as used here

- **Value object** — immutable, compared by value. The **capability** is the
  load-bearing one: a closed vocabulary (`src/util/capabilities.ts`) that gates
  what every tool may do, checked **once** at the shared gate
  (`ToolHost.gateCheck`), never inlined in a handler
  (`no-inlined-capability-checks`).
- **Aggregate** — owns its invariants and is the unit of consistency. The
  **session** is the worked example: `SessionRegistry` owns identity and the
  per-session state bundle (policy, storage, recording, capability state), in one
  of three **modes** (managed / incognito / byob-attach). Lifecycle invariants
  live on the session, not as scattered `if` checks.
- **Domain error vs IO failure** — a violated invariant is a structured
  `InvariantError` (`src/util/invariant.ts`) the dispatch boundary renders as a
  `ToolResponse` refusal; an IO/engine failure surfaces as a shaped failure in
  the `ActionResult`. Callers branch on a typed shape, never a string.
- **Use case** — one user-meaningful operation (click, snapshot, extract,
  open_session): a handler in `src/page` or `src/session` that orchestrates ports
  and domain and holds no rule that belongs on the session aggregate or the
  capability vocabulary.
- **`ActionResult`** — the structured envelope an action emits (pre-state,
  dispatch, settle, post-state, shaped sub-blocks). Its _shaping and types_ are
  domain; its _lifecycle orchestration_ (`actionresult.ts`) is application.

## Ubiquitous language

Use these terms exactly, in code and prose:

- **session** — a live browser context with identity, owned by `SessionRegistry`.
  **mode** — how it was created (managed / incognito / byob-attach).
- **capability** — the closed gating vocabulary; **the gate** — the single check
  at `ToolHost.gateCheck`.
- **engine** — a browser backend, present only as data in `src/engine` tables.
- **port** — a contract the core owns; **substrate** — the capability-shaped port
  family a session exposes (`Action` / `Capture` / …).
- **tool handler** — the use-case unit; **`register*Tools`** — its MCP
  registration wrapper (size-exempt by design).
- **`ActionResult`** — the structured action envelope. **composition root** —
  `src/server.ts`.

## Where new work goes — a decision rule

- A new invariant or business rule → a method on the owning thing (the session
  aggregate, the capability vocabulary), in the domain.
- A new user-meaningful operation → a new handler (`src/page` / `src/session`)
  plus its `register*Tools` row; the metadata (capability / batchable / deep) is
  declared **at** `host.register`, never in a hand-edited central list
  ([`fitness-functions.md`](fitness-functions.md)).
- A new browser backend → a new engine adapter + a `CAPABILITIES` row + one
  registration; **never** an edit to `src/session/{managed,incognito,byob}.ts`
  or an `engine === "…"` branch ([`engine-adapters.md`](engine-adapters.md)).
- A new backend / vendor / transport → a new adapter behind an existing port; add
  the port only if the seam is proven (a second real implementation).
- A new MCP endpoint → a handler extracted from state in the registration layer;
  no business logic in the registration wrapper.

## Related

- [`architecture-principles.md`](architecture-principles.md) — the macro
  doctrine and the ten laws (L1–L10) these layers serve.
- [`module-and-file-size.md`](module-and-file-size.md) — the one-reason-to-change
  size discipline and its budget.
- [`fitness-functions.md`](fitness-functions.md) — the executable checks that
  hold every boundary above in place.
- [`engine-adapters.md`](engine-adapters.md) — the engine port and its adapters
  in depth. [`repo-map.md`](repo-map.md) — the directory index.
