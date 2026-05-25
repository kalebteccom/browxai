# CC-session brainstorm — agentic browser-tool wishlist (2026-05-26)

> Source: a Claude Code brainstorming session on what tends to matter when an
> agent is driving a real browser. Treated as a wishlist input on par with
> consumer adoption-run reports, not as a defect report against any specific
> browxai run. Status reconciliation against the v0.1.0 stable surface +
> shipped capability lanes lives in the portfolio (`projects/agent-browser-bridge/impl-docs/first-consumer-asks.md`,
> Round-21) — this doc is the raw input.

The session author's top-2 leverage picks for agentic browser tools in general:

1. **A11y-tree-as-input** — cheaper and more accurate than raw HTML.
2. **Replayable action trace** — makes failures debuggable instead of mysterious.

Both are already first-class in browxai's v0.1.0 stable surface (see
status mapping in Round-21).

## Pending work item

- **Request interception** — override concrete payload/request information while
  testing (e.g. turning a feature flag on/off, testing specific configuration
  edge cases).

## Feature ideas

Grouped by what tends to matter when an agent is driving a real browser.

### Observation / state capture

- DOM snapshot + accessibility-tree export (the a11y tree is often a better LLM
  input than raw HTML — smaller, semantic).
- Console log + uncaught error capture, surfaced back to the agent.
- Network waterfall capture (requests, timings, status codes) so the agent can
  reason about failures.
- Screenshot + element bounding boxes for visual grounding / set-of-marks
  prompting.
- `page.on('dialog')` handling so `alert` / `confirm` / `prompt` don't deadlock
  the session.

### Network control (beyond request interception above)

- Request mocking/stubbing with fixture replay (record once, replay
  deterministically).
- Latency/throttling injection and offline simulation for edge-case testing.
- Response rewriting (status codes, headers, error injection — 500s, 429s,
  timeouts).
- HAR record/replay for full-session reproducibility.

### Determinism / reliability

- Clock control via CDP `Emulation.setVirtualTimePolicy` — freeze/advance time
  for date-sensitive flows.
- Seeded randomness / fixed `Math.random`.
- Auto-wait primitives exposed to the agent (wait-for-network-idle,
  wait-for-selector, wait-for-stable-DOM) instead of raw sleeps.
- Retry-with-backoff wrapper on actions, with idempotency awareness.

### State & isolation

- Per-task browser contexts (cookies, storage, auth isolated).
- Storage-state save/restore (skip re-login by injecting auth state).
- Tab/popup management and target tracking via CDP `Target` domain.
- iframe and shadow-DOM traversal.

### Agent ergonomics

- Action trace / replayable session log (every step → screenshot + DOM diff)
  for debugging and evals.
- "Dry run" mode that plans actions without executing.
- Element resolution by semantic description with stable selector caching.
- Step-level checkpoints so a failed run can resume mid-task.

### Eval / observability

- Assertion hooks so a run produces pass/fail, not just "done".
- Token/latency/cost accounting per task.
- Flake detection (run N times, report variance).

### Device / env emulation

- Viewport, user-agent, geolocation, locale/timezone, permissions, dark mode.
