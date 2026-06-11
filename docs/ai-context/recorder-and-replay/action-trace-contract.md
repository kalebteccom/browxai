# Action-trace contract

Recorder IR shape and the no-trace contract that underwrites replayability.

## What the recorder captures

Each tool call that mutates page or session state produces an action-trace entry. The entry shape is intentionally narrow:

- `tool` — the canonical tool name.
- `args` — the input as accepted (post-validation, post-default).
- `ref` — the `[ref=eN]` of the target element, if any.
- `result` — the structured ActionResult (post-mask if secrets-masking applied).
- `t` — monotonic timestamp.
- `sessionId` — owning session.

Read-only tools (`snapshot`, `find`, `inspect`, `text_search`, `network_read` metadata, `console_read`, `screenshot`) do not produce action-trace entries unless `diagnostics` capability is active.

## The no-trace contract

When the `diagnostics` capability is **not** active, browxai leaves no artifact outside the workspace. Specifically:

- No recorder file is written.
- No console / network capture is persisted.
- Screenshots and downloads still go to the workspace path (via `resolveWorkspacePath`) — that's the workspace contract, not a trace.

The no-trace contract is enforced by tests in `src/util/no-trace.test.ts`. Any new tool that touches disk MUST go through `resolveWorkspacePath` and MUST honor the no-trace contract.

## Replayability (forward-looking)

A planned `.browx-flow.json` format will formalize the action-trace IR as a replayable script. Today's trace is a debugging artifact; tomorrow's trace is an executable replay. The contract above is the foundation:

- Stable tool names (semver-frozen) — replay against a newer browxai picks up the same handlers.
- Stable args (Zod schema versioned with the tool) — additive args are forward-compatible.
- Stable ref scheme (`[ref=eN]` within a session) — replay against the same starting snapshot finds the same nodes.

When you change a tool's input schema, consider replay-compat: an additive optional field is safe; a removed required field breaks replay.

## Related

- [`../secrets-and-egress/network-body-and-secrets.md`](../secrets-and-egress/network-body-and-secrets.md) — secrets-masking order (applies before recorder writes).
- [`../tool-registration/server-tool-registry.md`](../tool-registration/server-tool-registry.md) — ActionResult shape.
- [`../architecture/capability-posture-map.md`](../architecture/capability-posture-map.md) — `diagnostics` capability semantics.
