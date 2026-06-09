# Capability posture map

Safe by default — no auto-broadening. Every off-by-default capability has a per-tool keystone test asserting the gate blocks when the capability is not granted (returns a structured `capability-denied` error, not a silent no-op).

## Default-on capabilities

These ship enabled. Withholding them turns browxai into a read-only crawler.

| Capability | Tools | Rationale |
|---|---|---|
| `read` | snapshot, find, text_search, inspect, console_read, network_read (metadata only), screenshot | Observation has no side effect on the page; safe to enable everywhere. |
| `navigation` | navigate, go_back, go_forward, reload | URL changes are visible to the agent and to the user. |
| `action` | click, fill, select, drag, scroll, hover, press, wait_for | User-emulating actions; bounded by anti-wedge deadlines. |
| `human` | confirmation hooks, await_human | Pause-for-human is a safety lever, not a posture broadener. |

## Off-by-default capabilities

Each requires explicit opt-in via `BROWX_CAPABILITIES` (env) or `createBrowxai({ capabilities })` (SDK). A loud warning is emitted on first activation.

| Capability | Tools | Why off by default |
|---|---|---|
| `eval` | `eval_js`, `poll_eval` | Arbitrary JS in page context bypasses curated handlers. |
| `network-body` | full response bodies, network interception (W-V12 lane) | Response bodies often contain PII / secrets. |
| `byob-attach` | attach to user's existing Chrome | Skips managed-profile isolation; touches user data. |
| `clipboard` | OS clipboard read/write | Cross-application data egress. |
| `file-io` | `upload_file`, downloads to workspace | Filesystem touch via the workspace chokepoint. |
| `secrets` | `register_secret`, secret materialization at egress | Secret values live in process memory; egress order matters. |
| `extensions` | install/inspect Chrome extensions | Extension code runs with elevated browser privileges. |
| `stealth` | anti-fingerprint posture tweaks | Adopter-controlled posture, not a default. |
| `captcha` | captcha solver glue | Third-party service integration. |
| `device-emulation` | viewport / UA / geolocation overrides beyond defaults | Spoofing surface; default profile is honest. |
| `diagnostics` | recorder, perf_audit, coverage, layout_thrash_trace, memory_diff | Captures session artifacts (workspace-scoped, but artifact-producing). |
| `canvas` | canvas-app eval routing (figma / tldraw / excalidraw plugins) | Composes with `eval`; canvas-app plugins gate through this. |

## Composition rules

- A tool may require **multiple** capabilities. `poll_eval` requires both `eval` and `diagnostics`. `canvas_query` requires `canvas` + the host adapter's declared capabilities.
- Capability composition is multiplicative: missing any required capability returns `capability-denied`.
- The gate is composed in `src/server.ts` at registration time. A handler MUST NOT inline its own capability check beyond calling the shared gate.

## Adding a new capability

1. Add the constant to `src/util/capabilities.ts` (default off).
2. Add the threat-model row in `docs/threat-model.md`.
3. Add the row in this file and in `AGENTS.md` capability table.
4. Add the keystone test asserting the gate blocks when capability unset.
5. CHANGELOG entry under `## Unreleased ### Added`.

## Retirement

Deprecating a capability: see [`../release-process/retired-registry-pattern.md`](../release-process/retired-registry-pattern.md). The retired value is accepted with a warning until the next major; never deleted abruptly.

## Related

- [`../../threat-model.md`](../../threat-model.md) — per-capability threat-model rows.
- [`../secrets-and-egress/network-body-and-secrets.md`](../secrets-and-egress/network-body-and-secrets.md) — egress composition order.
