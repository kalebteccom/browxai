# RFC 0005 — Harness install docs and plugin marketplace distribution

**Date:** 2026-06-17
**Status:** Draft — proposal. Local prerequisite work may land behind this RFC;
remote relay, marketplace, and cloud-product work require review before
implementation.
**Author:** Codex, with parallel platform research agents for repo/docs context,
Claude surfaces, and OpenAI surfaces.
**Review owner:** Project owner
**RFC mode:** Pre-build alignment RFC, with architecture-contract sections where
the relay and schema-discovery boundaries need to be durable. Format inspired by
the `dev-rfc` guidance: state the problem, compare approaches fairly, specify
service and observability expectations, and define rollout/verification before
implementation.

---

## 1. Executive Summary

browxai needs a clearer installation and distribution story across cloud MCP
products and local MCP harnesses.

The public happy path should lead with remote support through a first-party
hosted relay:

- `browxai remote connect` pairs a user-controlled browxai/browser host with
  the hosted relay;
- browsers still run on user-controlled hardware;
- the hosted relay provides the public HTTPS MCP endpoint required by Claude
  remote surfaces and ChatGPT;
- browxai core remains relay-agnostic through a provider-neutral relay contract.

The same workstream also ships the local and marketplace story:

- clearer Getting Started harness tabs after the remote quickstart;
- installable Claude and Codex harness plugins;
- root-level marketplace catalogs generated from monorepo package sources;
- explicit first-party browser setup via `browxai browser install`;
- exact `playwright-core` pinning;
- rich schema discoverability across stdio and socket transports.

Cloud products such as Claude.ai, Claude Cowork, Claude Code cloud, Claude
Desktop sandboxed access, and ChatGPT should have a documented happy path
through that first-party relay. Self-hosted and third-party relays remain
compatible if they satisfy the same contract. The relay must proxy the full
enabled browxai tool surface, not a reduced browser-control subset.

## 2. Decision Summary

| Area             | Decision                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Getting Started  | Lead with `browxai remote connect` through the first-party hosted relay, then provide harness-specific local and fallback tabs.                  |
| Claude remote    | Claude.ai web, Claude Cowork, Claude Code cloud, and Claude Desktop sandboxed MCP access use the hosted relay happy path by default.             |
| Claude local     | Claude Code local gets the first-class local plugin/marketplace path and local stdio fallback.                                                   |
| ChatGPT          | ChatGPT uses Developer Mode / Apps remote MCP through the hosted relay happy path; no local stdio path.                                          |
| Harness plugins  | Build harness plugins for Claude and Codex. Keep them distinct from browxai runtime plugins.                                                     |
| Marketplace      | Keep marketplace source/artifacts under monorepo packages, but commit generated root catalogs at `.claude-plugin/` and `.agents/plugins/`.       |
| Plugin assets    | Do not block on screenshots. Reuse docs artwork, a generated asset, or a polished test harness site asset if the marketplace UI wants media.     |
| Browser setup    | Add `browxai browser install`; do not download browsers during harness plugin install.                                                           |
| Browser pinning  | Pin `playwright-core` exactly so browser revisions are traceable to the installed browxai package.                                               |
| Relay model      | Default to the first-party hosted relay/control plane, while supporting self-hosted and third-party relays. No hosted browser fleet.             |
| Relay scope      | Relay the full enabled browxai MCP surface, including runtime plugin tools, subject only to explicit operator policy filters.                    |
| Relay guarantees | First-party relay guarantees belong in product terms. Third-party/org relays are operator responsibility; compatibility is protocol-facing only. |
| Socket schemas   | Socket `tools/list` must expose the same schemas as stdio MCP before marketplace docs depend on schema-discoverability claims.                   |

## 3. Problem Statement

The current public Getting Started page has one generic MCP configuration block.
That is technically correct for some local clients, but it hides important
differences between major harnesses:

- Claude Code and Codex can launch local stdio MCP servers.
- Claude.ai, Claude Cowork, Claude Code cloud, Claude Desktop sandboxed MCP
  access, and ChatGPT require remote MCP reachable from the cloud product.
- Claude and Codex have distinct plugin and marketplace package formats.
- browser binary setup currently leaks Playwright implementation details into
  user instructions.
- socket serve currently must remain argument-safe while also becoming
  schema-discoverable.

The risk is onboarding ambiguity. A user can install browxai correctly and still
be handed instructions for a harness that cannot reach local stdio. The first
command on browxai.com should instead match how most cloud products will use
browxai: pair a local browser host to a public MCP relay. A future marketplace
package could also hide browser download requirements or create a vendor-specific
relay dependency in browxai core.

## 4. Context

### 4.1 Current browxai state

- `website/src/content/docs/getting-started.md` has a single "Wire it into an
  MCP client" path.
- `harness/adapters/claude-code/` and `harness/adapters/codex/` already contain
  deeper harness guidance, but the public docs do not present them as first-class
  tabs.
- `package.json` has `pnpm install-browser`, which should call the first-party
  browser install command rather than Playwright directly.
- `browxai doctor` checks browser availability and reports missing Chromium; its
  user-facing fix should point at `browxai browser install`.
- `browxai serve --socket` must both forward raw arguments to the same handlers
  used by in-process driving and expose rich `tools/list` schemas.
- Tool registration metadata is now the right source of truth for schemas,
  capability, batchability, and deepness.

### 4.2 Platform constraints

| Surface                         | Local stdio | Remote MCP                                              | Marketplace / plugin distribution                                               | Implication                                                                                |
| ------------------------------- | ----------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Claude.ai / Cowork / cloud      | No          | Custom connectors use remote MCP reachable by Claude    | Claude plugin UI supports custom marketplaces; remote surfaces are relay-shaped | Docs must say "remote relay required" and cannot show local `.mcp.json` as the happy path. |
| Claude Code local               | Yes         | HTTP also supported; SSE is deprecated in current docs  | Claude Code plugins and `.claude-plugin/marketplace.json`                       | First-class local plugin target.                                                           |
| Claude Desktop sandboxed access | Not enough  | Same remote-MCP requirement for Cowork-style sandboxing | Same Claude marketplace/plugin ecosystem                                        | Treat as Claude remote, not local stdio.                                                   |
| ChatGPT                         | No          | Developer Mode / Apps use remote MCP over HTTPS         | No custom marketplace JSON equivalent; app/private connector flows              | Docs must be remote-app/relay only.                                                        |
| Codex local                     | Yes         | Streamable HTTP MCP also supported                      | Codex plugins and `.agents/plugins/marketplace.json`                            | First-class local plugin target.                                                           |
| Generic MCP                     | Varies      | Varies                                                  | None                                                                            | Keep protocol-level stdio JSON as fallback.                                                |

### 4.3 External documentation facts used

- Claude marketplace docs require `.claude-plugin/marketplace.json` at the
  marketplace root and support relative paths and git subdirectory plugin
  sources.
- Codex marketplace docs require `$REPO_ROOT/.agents/plugins/marketplace.json`
  for repo marketplaces and support local path and `git-subdir` plugin sources.
- OpenAI remote MCP docs describe remote MCP servers as public-internet servers
  that import tools via `tools/list`, support approval controls, and may use
  bearer/OAuth authorization.
- ChatGPT app connector docs require an HTTPS MCP endpoint and metadata refresh.
- MCP Streamable HTTP transport uses JSON-RPC over POST, optional server-sent
  event streams, protocol-version handling, session handling, and origin/auth
  requirements.

## 5. Goals

- Make Getting Started harness-specific and truthful about local vs remote
  support.
- Make the first public happy path `browxai remote connect` through the
  first-party hosted relay.
- Ship Claude and Codex harness plugins through custom marketplaces.
- Make the Claude marketplace installable through the Claude plugin UI.
- Keep harness plugins separate from browxai runtime plugins.
- Put marketplace sources under monorepo packages while exposing required
  root-level marketplace catalogs.
- Provide explicit first-party browser setup via `browxai browser install`.
- Pin browser setup to the installed browxai package by exactly pinning
  `playwright-core`.
- Define a provider-neutral relay contract for cloud products so the first-party
  hosted relay, self-hosted relays, and third-party relays can all use the same
  browxai-side behavior.
- Support all enabled browxai tools through compatible relays, including runtime
  plugin tools.
- Make socket serve schema-discoverable before marketplace docs rely on that
  claim.
- Preserve the safe-by-default capability posture.

## 6. Non-Goals

- No hosted browser-execution service or browser fleet. The first-party hosted
  relay is a control plane and public MCP endpoint; browser execution remains on
  user-controlled hardware.
- No public ChatGPT app submission in the first implementation phase.
- No provider-specific relay SDK in browxai core. The public happy path may use
  the first-party hosted relay by default, but the codebase contract remains
  relay-agnostic.
- No hosted-relay product-program, authentication, pricing, metering, support,
  or product-terms definition in this repo. Those product decisions live outside
  the browxai technical RFC.
- No change to the stable MCP tool names, output shapes, default capabilities, or
  browser session lifecycle as part of the docs/marketplace work.
- No attempt to collapse Claude and Codex package formats into one literal file.
- No silent browser download during harness plugin install.
- No warranty, certification, endorsement, or brand license for third-party or
  organization-run relays.

## 7. Requirements

### 7.1 Functional requirements

- Getting Started has separate instructions for Claude remote surfaces, Claude
  Code, ChatGPT, Codex, and Generic MCP.
- Getting Started leads with the remote quickstart:
  `browxai remote connect`.
- `browxai remote connect` defaults to the first-party hosted relay and supports an
  override such as `--relay-url` or equivalent configuration for self-hosted and
  third-party relays.
- Claude and Codex harness plugins include the `driving-browxai` skill or
  equivalent harness-native guidance.
- Harness plugins invoke `browxai` directly and list prerequisites: Node, the
  browxai package, browser binaries, and platform-level Playwright/browser
  dependencies.
- Root marketplace catalogs are generated and committed at:
  - `.claude-plugin/marketplace.json`
  - `.agents/plugins/marketplace.json`
- Marketplace source packages live under:
  - `packages/marketplace-claude/`
  - `packages/marketplace-codex/`
  - future `packages/marketplace-<harness>/`
- Browser installation uses `browxai browser install --engine <kind>` or
  `browxai browser install --all`.
- Socket `tools/list` exposes the same tool schemas as stdio MCP.
- Relay-mediated discovery exposes the same enabled browxai tool set as direct
  local discovery under the same capability policy.

### 7.2 Security and trust requirements

- Harness plugin install must not enable off-by-default capabilities.
- Harness plugin install must not download browsers automatically.
- Harness plugin install must not attach to a user's real browser profile.
- Browser install must print the browxai version, Playwright version, target
  engine, resolved browser path, and download host before downloading.
- `doctor` must report browser setup state and actionable fixes.
- Relays must authenticate cloud callers and map each remote principal to an
  explicit browxai host, workspace, browser profile policy, capability policy,
  and audit scope.
- Pairing should require explicit local host approval, not just possession of a
  remote credential.
- Relays must not expose Playwright, CDP, or raw browser-debugging endpoints to
  cloud products.
- Relays must not silently broaden capabilities beyond the paired host's policy.

### 7.3 Operability and observability requirements

- Local onboarding should be diagnosable with `browxai doctor` and a first
  read-only browser tool call.
- Marketplace generation must be drift-checked: source package metadata and root
  marketplace catalogs cannot diverge silently.
- Browser setup must be idempotent: already-installed browsers should produce a
  clear "ready" result rather than a confusing reinstall path.
- Relay implementations should emit operator-visible events for pairing,
  authorization failures, paired-host offline state, tool-list cache refresh,
  tool-call start/end, cancellation, timeout, and backpressure.
- Relay logs must treat tool arguments, page content, URLs, and browser outputs
  as sensitive. Redaction and retention are operator responsibilities.
- No runtime SLA is promised by this RFC. Hosted relay terms, support posture,
  authentication policy, pricing, metering, and retention are product contracts
  outside this repo. Third-party and organization-run relays are governed by
  their operators' terms and policies.

## 8. Proposed Design

### 8.1 Public remote happy path

The first command shown on browxai.com should be the remote-support path:

```sh
browxai remote connect
```

This command defaults to the first-party hosted relay. It should:

- run local preflight checks for Node, browxai, browser binaries, workspace
  access, and selected engine;
- clearly prompt before any browser download, delegating to
  `browxai browser install` when needed;
- start or connect to a user-controlled browxai/browser host;
- open or print a pairing URL for the hosted relay;
- print the resulting HTTPS MCP endpoint and harness-specific next steps;
- support a relay override for self-hosted or third-party relays without
  changing browxai core.

The hosted relay is first-party onboarding and public MCP reachability. It is
not a browser fleet: browser execution, browser profiles, local files, and
off-by-default capabilities remain under the paired user's hardware and policy.

### 8.2 Getting Started harness chooser

After the remote quickstart, replace the current generic MCP wiring section with
harness-specific tabs or equivalent sections:

- **Claude.ai / Cowork / Claude Desktop sandboxed access:** remote connector
  only. Use `browxai remote connect` as the happy path. The browser remains on
  user-controlled hardware.
- **Claude Code:** local stdio command, project `.mcp.json`, verification with
  `/mcp`, and marketplace plugin path once available.
- **ChatGPT:** Developer Mode / Apps path using the MCP endpoint produced by
  `browxai remote connect`. Local package install alone is not sufficient.
- **Codex:** `codex mcp add browxai -- browxai`, equivalent TOML, verification
  with `/mcp` or `codex mcp list`, and marketplace plugin path once available.
- **Generic MCP:** protocol-level stdio JSON for clients that launch local MCP
  servers.

The page can use MDX tabs if that fits the Starlight setup. Plain Markdown
sections are acceptable if they are clearer and less fragile.

### 8.3 Harness plugin package shape

Use **harness plugin** for Claude/Codex install bundles. Use **browxai plugin**
only for packages loaded by the browxai runtime via `browxai plugin install`.

Harness plugins should include:

- a local stdio MCP config invoking `browxai`;
- `driving-browxai` guidance or harness-native equivalent;
- metadata, icons, docs links, privacy/terms links, and install-surface copy;
- no hooks in the first version unless a later security pass proves they are
  necessary.

Screenshots should not block initial release. If media is needed, reuse docs
site artwork, generate a simple browxai asset, or polish the test harness site
into a representative browser automation demo.

### 8.4 Marketplace generation and publication

The installable marketplace source is the browxai repo root because Claude and
Codex both read fixed root catalog paths.

```text
browxai repo root
  .claude-plugin/marketplace.json        # generated Claude catalog
  .agents/plugins/marketplace.json       # generated Codex catalog
  packages/marketplace-claude/           # Claude source metadata/artifacts
  packages/marketplace-codex/            # Codex source metadata/artifacts
```

Each marketplace package owns native source metadata, plugin artifacts, assets,
and validation scripts. Root catalogs are committed generated outputs because
clients read those paths.

Catalog entries point at plugin directories inside the repo, using the native
source shape:

- Claude: relative path or `git-subdir` plugin source.
- Codex: relative path or `git-subdir` plugin source.

Dedicated per-environment marketplace repositories are rejected for this RFC.
Reopen only if a future client proves it cannot tolerate both root catalogs in
one repo.

### 8.5 Browser setup CLI

Add:

```sh
browxai browser install --engine chromium
browxai browser install --engine firefox
browxai browser install --engine webkit
browxai browser install --all
```

Implementation contract:

- use browxai's installed `playwright-core` dependency;
- do not require `npx playwright` or a global Playwright tool;
- print browxai version, Playwright version, target engine, expected browser
  revision, resolved executable path, and download host;
- make download size and network access explicit before fetching;
- respect Playwright's browser cache and mirror variables;
- document any future `BROWX_*` mirror/pin variables;
- return structured errors that `browxai doctor` can cite;
- keep Chromium required for default managed mode;
- keep Firefox and WebKit opt-in;
- keep postinstall hooks disabled.

The published package should pin `playwright-core` exactly. `doctor` should
report mismatches between the expected Playwright/browser revision and the
executable it finds.

### 8.6 Schema and socket discoverability

Socket `tools/list` must expose the same input schemas as stdio MCP before the
marketplace docs claim schema-discoverability is uniform.

Implementation direction:

- expose the live registration table from `createServer()` alongside `handlers`;
- serialize the same registration input schemas used by stdio registration for
  socket `ListTools`;
- keep socket `tools/call` argument-safe by forwarding raw arguments into the
  validated handlers;
- do not reintroduce transport-layer validation that strips arguments;
- add regression tests for both argument preservation and listed schema shape.

### 8.7 Relay architecture contract

Cloud products consume browxai through a provider-neutral relay:

```text
cloud MCP host
  -> public HTTPS Streamable HTTP MCP endpoint
  -> relay adapter
  -> paired browxai host on user-controlled hardware
  -> local browser profile/process
```

The first remote connector implementation should support both, with the
first-party hosted relay as the default public happy path:

- **self-hosted relay:** an operator runs the public Streamable HTTP MCP relay
  and pairs it with browxai/browser hosts they control;
- **first-party hosted relay/control plane:** the first-party relay operates
  pairing, signaling, routing, and the public MCP endpoint, but browser
  processes and profiles stay on user-controlled hardware.

WebRTC data channels remain the most promising first research lane for the
browser-host leg because they can keep browser automation close to user hardware
while presenting a public MCP URL to cloud products. WebSocket, secure tunnel,
QUIC, or another transport can also satisfy the browxai-side contract if MCP
JSON-RPC semantics are preserved end-to-end.

### 8.8 Cloud product relay contract

The relay contract has four actors:

- **cloud MCP host:** Claude.ai, Claude Cowork, Claude Code cloud, Claude
  Desktop sandboxed access, ChatGPT, or another cloud/sandboxed MCP client;
- **relay operator:** the first-party hosted relay, an organization-run relay,
  or a third-party relay;
- **browxai host:** the process running on user-controlled hardware, with the
  selected workspace, browser engine, profile policy, and capability policy;
- **browser:** the local browser process or profile controlled by that browxai
  host.

The contract is intentionally protocol-facing. A relay may use WebRTC data
channels, WebSockets, QUIC, an SSH-style tunnel, or another host-leg transport,
but the cloud-facing behavior must remain MCP and the browxai-side semantics
must match a direct local browxai session.

Cloud-facing endpoint contract:

- expose one HTTPS Streamable HTTP MCP endpoint per paired remote connector, or
  an authenticated endpoint that routes by remote principal and selected host;
- complete MCP initialize and capability negotiation before exposing tools;
- answer `tools/list` from the paired browxai host's live registration metadata,
  after applying only explicit operator policy filters;
- preserve tool names, descriptions, annotations, and JSON input schemas;
- accept `tools/call` with JSON arguments and forward those arguments without
  schema-based mutation or stripping;
- map cloud-principal identity to one explicit browxai host, workspace,
  browser-profile policy, capability policy, and audit scope;
- require relay-level authentication and authorization before any browser-control
  tool can be called.

Browxai-host contract:

- connect outbound from user-controlled hardware; no inbound firewall hole is
  required for the browser host;
- pair only after explicit local approval and show which relay, remote principal,
  workspace, browser policy, and capabilities will be exposed;
- send heartbeats and host state so cloud products can receive a clear offline
  or unavailable error instead of hanging;
- report registration changes when capabilities, runtime plugins, or policies
  change, so relay-side discovery caches can invalidate;
- enforce browxai's local capability gates even if the relay has a broader
  remote authorization scope;
- never expose raw Playwright, CDP, browser-debugging, filesystem, or profile
  endpoints to the relay or cloud product outside the curated browxai tools.

Tool-call contract:

- preserve JSON-RPC request identity across the relay so responses, errors, and
  cancellations correlate to the originating cloud request;
- propagate cancellation, timeout, backpressure, and host shutdown semantics;
- return structured MCP errors for unknown tools, insufficient relay scope,
  denied local capabilities, invalid arguments, host offline, host busy,
  timeout, cancellation, and browser/session failure;
- treat tool arguments, URLs, screenshots, extracted text, network records, and
  tool outputs as sensitive data in relay logs and telemetry;
- avoid storing browser output by default; retention and redaction are relay
  operator responsibilities and must be disclosed by that operator.

Compatibility language for self-hosted and third-party relays is limited to this
contract. browxai can document that a relay is compatible with the protocol
shape only when it preserves discovery, call, error, cancellation, and policy
semantics. That statement is not a certification, warranty, endorsement, hosted
service guarantee, or permission to use project branding beyond normal project
licenses.

### 8.9 Relay MCP requirements

The public side of any relay must:

- expose HTTPS Streamable HTTP MCP, preferably at `/mcp`;
- satisfy JSON-RPC over POST, `Accept` behavior, protocol-version handling,
  session headers when sessions are used, and GET/SSE or correct 405 behavior;
- validate `Origin` where applicable;
- require authentication for browser control;
- support MCP initialization, `tools/list`, and `tools/call`;
- preserve tool names, descriptions, annotations, and JSON input schemas;
- expose the full enabled browxai tool surface, including runtime plugin tools,
  unless an explicit operator policy filter hides tools;
- return MCP protocol errors for offline hosts, unauthorized callers, missing
  capabilities, and timed-out browser actions;
- authenticate the cloud product with bearer/OAuth or the product's approved
  remote-connector mechanism.

The browxai side of any relay must:

- connect outbound from user-controlled hardware;
- require no inbound firewall hole for the browser host;
- preserve MCP JSON-RPC semantics even if the relay leg uses another transport;
- forward raw tool arguments without schema-based argument stripping;
- preserve cancellation, timeouts, backpressure, and structured tool errors;
- treat browxai registration metadata as the discovery source of truth;
- avoid importing provider-specific relay SDKs into browxai core.

First-party hosted relay product guarantees belong in product terms outside this
repo. Third-party and organization-run relays are the responsibility of their
operators and are governed by their own terms. browxai compatibility language for
non-first-party relays is protocol-facing only. It is not a warranty,
certification, endorsement, hosted service guarantee, or permission to use
project branding beyond normal project licenses.

## 9. Approach Comparison

| Option                                      | Pros                                                                  | Cons                                                                      | Decision                    |
| ------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------- |
| Keep only generic MCP docs                  | Minimal work; protocol-correct for some clients                       | Confusing for major harnesses; hides local vs remote split                | Rejected                    |
| Harness-specific docs only                  | Faster than marketplace work                                          | Still leaves manual setup burden on users                                 | Use as P1, not the endpoint |
| Claude/Codex marketplace plugins            | Better install UX; can package guidance and MCP config                | Requires native package formats and validation                            | Accepted                    |
| One literal marketplace format              | Simpler source model                                                  | Claude and Codex formats differ                                           | Rejected                    |
| Root catalogs generated from package source | Satisfies client root-path requirements while keeping monorepo source | Requires drift checks                                                     | Accepted                    |
| Separate marketplace repos                  | Clean per-client roots                                                | Splits source, validation, releases, and docs from browxai                | Rejected for this RFC       |
| Auto-install browsers during plugin install | Fewer steps                                                           | Large network side effect; poor managed-environment posture               | Rejected                    |
| `browxai browser install`                   | Explicit, diagnosable, first-party setup                              | Requires CLI implementation and tests                                     | Accepted                    |
| Local-first public quickstart               | Easier to ship from existing code                                     | Does not match how Claude remote surfaces or ChatGPT actually connect     | Rejected                    |
| `browxai remote connect` first              | Matches cloud-product happy path; hides relay complexity              | Requires hosted relay onboarding and pairing flow                         | Accepted                    |
| Hosted browser fleet                        | Simple cloud product mental model                                     | High trust, tenancy, cost, compliance, and profile-ownership burden       | Rejected                    |
| Relay to user-controlled browsers           | Preserves local profile model and self-hosting                        | Requires pairing, auth, reconnect, and relay behavior testing             | Accepted                    |
| Reduced remote tool subset                  | Easier first relay                                                    | Creates divergent product semantics and confusing docs                    | Rejected                    |
| Full enabled tool surface through relay     | Same browxai everywhere under same policy                             | Higher relay correctness burden                                           | Accepted                    |
| Delay socket rich schemas                   | Avoids blocking marketplace work                                      | Undermines schema-discoverability docs and remote relay cache correctness | Rejected                    |
| Fix socket schemas before marketplace docs  | Cleaner adopter contract                                              | Adds one implementation prerequisite                                      | Accepted                    |

## 10. Rollout Plan

### P0 — Review and acceptance

- Review this RFC for product boundaries, security posture, and packaging
  decisions.
- Do not start remote relay, marketplace package, or cloud-product
  implementation until the root marketplace and relay contract decisions are
  accepted.
- Local prerequisite work may land independently when it does not commit the
  project to a relay provider or marketplace format.

### P1 — Docs clarity

- Draft current Getting Started with truthful harness-specific local vs remote
  setup. Cloud/sandboxed harnesses get relay endpoint instructions; local
  harnesses get stdio instructions.
- When `browxai remote connect` exists, promote that command to the first public
  quickstart through the first-party hosted relay.
- Document `browxai browser install` as the browser setup command.
- Add schema-discoverability docs near Tool Reference.
- Link to existing harness adapter READMEs.
- Run the website docs build.

### P2 — Browser setup and pinning

- Add `browxai browser install`.
- Pin `playwright-core` exactly.
- Update `doctor` fix text and revision reporting.
- Add idempotence and missing-dependency tests.

### P3 — Socket schema discoverability

- Expose registration metadata to socket `tools/list`.
- Add socket tests for argument preservation and schema shape.
- Update docs to say stdio and socket expose the same schemas.

### P4 — Remote happy path implementation

- Add `browxai remote connect`.
- Default to the first-party hosted relay.
- Require explicit local host approval during pairing.
- Add relay override support for self-hosted and third-party relays.
- Pair a user-controlled browxai/browser host with the relay.
- Print the hosted relay MCP endpoint and harness-specific next steps.
- Verify no browser process runs on relay-provider infrastructure.

### P5 — Local marketplace prototypes

- Add `packages/marketplace-claude/`.
- Add `packages/marketplace-codex/`.
- Generate root `.claude-plugin/marketplace.json`.
- Generate root `.agents/plugins/marketplace.json`.
- Validate both catalogs from the repo root.
- Prove each client ignores the other client’s root catalog.

### P6 — Public marketplace distribution

- Publish marketplace catalogs from the browxai repo root.
- Update Getting Started to prefer marketplace install for Claude Code and Codex,
  with manual MCP config as fallback.
- Add security copy that explains what the plugin installs and what it does not
  enable.

### P7 — Remote connector hardening

- Deepen the relay design for OAuth/auth, browser tenancy, self-hosted relay
  operation, managed control-plane operation, WebRTC feasibility, full-surface
  proxying, operator responsibility language, and cloud connector review
  requirements.
- Turn Claude remote and ChatGPT tabs into product-specific happy paths once the
  hosted relay smoke tests pass.

## 11. Verification Plan

Docs:

- `pnpm --filter @browxai/website build`
- Starlight link validation
- no stale references to package-manager browser setup once the CLI command
  lands

Browser setup:

- clean-cache install for Chromium
- already-installed idempotence run
- missing dependency / mirror / network error cases
- `browxai doctor` reports expected vs actual Playwright/browser revision

Remote happy path:

- `browxai remote connect` pairs against the first-party hosted relay in a test
  account.
- pairing requires explicit local host approval.
- `browxai remote connect --relay-url <self-hosted-url>` pairs against a
  self-hosted relay using the same browxai-side contract.
- the hosted relay returns a public HTTPS MCP endpoint that imports the expected
  tool list.
- the paired browser process runs only on user-controlled hardware.
- Claude remote and ChatGPT setup instructions can consume the emitted MCP URL.

Marketplace:

- Claude: validate from repo root, add repo root as a local marketplace, install
  through the Claude plugin UI, confirm MCP config visibility.
- Codex: add repo root as a marketplace, install plugin, confirm bundled MCP
  server visibility.
- Drift check: package source metadata and generated root catalogs match.
- Coexistence check: Claude ignores Codex catalog and Codex ignores Claude
  catalog.

Schema:

- stdio `tools/list` includes schemas for representative core and plugin tools.
- socket `tools/list` includes the same schema shape.
- socket `tools/call` preserves required arguments.

Relay:

- MCP Inspector / protocol tests against the relay HTTP endpoint.
- behavior tests against one self-hosted relay prototype.
- behavior tests against one managed-control-plane or WebRTC/tunnel prototype.
- unauthorized, insufficient-scope, and valid-scope auth tests.
- discovery-cache invalidation on plugin and capability changes.
- direct-local vs relay-mediated discovery comparison under the same policy.
- hostile-page and prompt-injection tests before public app submission.

## 12. Risks and Mitigations

| Risk                                       | Mitigation                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Marketplace root catalogs clutter repo     | Keep them generated and tiny; source lives in `packages/marketplace-*`.                                          |
| Claude/Codex marketplace formats drift     | Generate from shared source and validate native outputs.                                                         |
| Plugin install implies hidden trust change | No hooks, no browser downloads, no capability broadening in v1 harness plugins.                                  |
| Browser install supply-chain ambiguity     | Exact `playwright-core` pin, explicit install command, `doctor` revision reporting.                              |
| Remote relay becomes vendor-specific       | Make the hosted relay the default product path, but keep browxai core relay-SDK-free and protocol-only.          |
| Product policy leaks into browxai RFC      | Keep launch-program, auth, pricing, metering, support, and product terms outside this repo's technical contract. |
| Relay operators overclaim compatibility    | State that behavior tests are not certification, warranty, endorsement, or brand permission.                     |
| Full-surface relay is complex              | Phase it behind a separate relay design; local marketplace work does not wait on remote implementation.          |
| Socket schema export regresses call path   | Keep discovery and dispatch separate; preserve raw argument forwarding.                                          |

## 13. Resolved Questions

- **What does "Claude app" mean here?** Claude.ai web, Claude Cowork, Claude
  Code cloud, and Claude Desktop sandboxed MCP access are remote-MCP surfaces.
  Claude Code local remains the local stdio/plugin target.
- **Where do marketplaces live?** In this repo. Source/artifacts live under
  monorepo packages; generated catalogs live at client-required root paths.
- **Do screenshots block marketplace release?** No. Use docs artwork, generated
  assets, or a polished test harness asset only if useful.
- **How should harness plugins invoke browxai?** Invoke `browxai` directly and
  make prerequisites explicit through docs and `doctor`.
- **What is the browser install command?** `browxai browser install`.
- **What is the first public remote command?** `browxai remote connect`,
  defaulting to the first-party hosted relay.
- **Should `playwright-core` be pinned?** Yes, exactly.
- **Which relay operating model ships first?** The first-party hosted relay is the
  public default. Self-hosted and third-party relays stay supported through
  relay URL/configuration overrides and the same protocol contract.
- **What remote-MCP subset is enough?** None. The relay should proxy the full
  enabled browxai tool surface under the active policy.
- **What does relay compatibility guarantee?** Only behavior in the tested
  protocol sense. Relay operation, terms, retention, and guarantees belong to
  the relay operator.
- **When does socket schema work happen?** Before marketplace docs rely on
  schema-discoverability claims.

## 14. References

- dev-rfc skill reference:
  `https://www.skills.sh/pproenca/dot-skills/dev-rfc`
- Claude Code plugin marketplaces:
  `https://code.claude.com/docs/en/plugin-marketplaces`
- Claude Code plugins:
  `https://code.claude.com/docs/en/plugins`
- Claude Code MCP:
  `https://code.claude.com/docs/en/mcp`
- Claude custom connectors:
  `https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp`
- Claude desktop vs web connectors:
  `https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors`
- Codex plugin build:
  `https://developers.openai.com/codex/plugins/build`
- Codex plugins:
  `https://developers.openai.com/codex/plugins`
- Codex MCP:
  `https://developers.openai.com/codex/mcp`
- ChatGPT Developer Mode:
  `https://developers.openai.com/api/docs/guides/developer-mode`
- ChatGPT Apps connection:
  `https://developers.openai.com/apps-sdk/deploy/connect-chatgpt`
- OpenAI MCP and connectors:
  `https://developers.openai.com/api/docs/guides/tools-connectors-mcp`
- MCP Streamable HTTP transport:
  `https://modelcontextprotocol.io/specification/2025-11-25/basic/transports`
