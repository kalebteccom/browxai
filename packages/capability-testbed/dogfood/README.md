# browxai dogfood harness

This directory contains the agent-driven dogfood harness for the capability
testbed. It measures how a real Codex session experiences the browxai MCP tool
surface while completing fixed goal-based missions.

The deterministic 198-tool harness remains under `src/harness`. Dogfood reuses
that manifest and those exercises, but it does not script tool calls for the
agent. Codex receives only the app URL, a browxai session id, the mission goal,
and the final `DOGFOOD_MISSION_DONE` marker requirement.

## Mock validation

The mock path does not launch a browser, bind the test app, or start Codex. It
validates mission selection, trace normalization, coverage gates, and report
generation.

```bash
pnpm --filter @browxai/capability-testbed dogfood --mock --mission all --k 1
```

Outputs are written under:

```text
packages/capability-testbed/dogfood/runs/<run-id>/
```

Each run contains JSONL traces and:

```text
reports/dogfood-report.json
reports/dogfood-report.md
reports/dogfood-report.normalized.json
```

## Live host run

Run this from the repository root on the host, not from inside a sandboxed
builder session:

```bash
pnpm build
pnpm --filter @browxai/capability-testbed dogfood --mission all --k 5
```

The wrapper starts the existing test app, starts host-owned
`browxai serve --socket`, probes the socket with MCP `initialize` and
`tools/list`, then starts `codex app-server` with a run-scoped MCP config that
points at the compiled socket proxy.

Default live posture:

```text
model=gpt-5.3-codex
effort=xhigh
sandbox=read-only
approvalPolicy=never
BROWX_HEADLESS=0
```

The Codex sandbox constrains model-generated shell commands. Chromium is owned
by the host-side browxai server, so browser launch does not depend on Codex
subprocess sandbox permissions.

## Useful flags

```text
--mission <id|all>
--k <number>
--mock
--headless
--headed
--timeout-ms <number>
--oracle-timeout-ms <number>
--run-root <path>
--workspace <path>
--browxai-socket <path>
--codex-bin <path>
--keep-open
--json
```

## Coverage and pass criteria

The catalog derives `expectedTools` from `MANIFEST`, including extension tools.
Startup validation fails if the mission union drifts from the manifest, if an
oracle tool lacks an `EXERCISES` entry, or if catalog surfaces drift from the
registered app surfaces.

A mission run passes only when all of these are true:

- Codex produced the final marker.
- The marker status is `done`.
- The host oracle results are `pass` or accepted `skip`.
- The Codex trace touched every required mission tool with a manifest-approved
  outcome.

Structured refusals and unavailable-provider results count as coverage when
they are the expected surface behavior. Schema failures, abandoned calls,
wrong-tool attempts, and ordinary errors do not.

`byob-attach`, `clipboard`, and `stealth` are recorded as rowless posture or
behavior tags until the manifest grows concrete rows for them. BYOB attach is
not included in the tool coverage denominator.
