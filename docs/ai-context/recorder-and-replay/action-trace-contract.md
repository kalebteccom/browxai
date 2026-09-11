# Action-trace contract

Recorder IR shape and the no-trace contract that underwrites replayability.

## What the recorder captures

Each tool call that mutates page or session state produces an action-trace entry. The entry shape is deliberately narrow:

- `tool`: the canonical tool name.
- `args`: the input as accepted, post-validation and post-default.
- `ref`: the `[ref=eN]` of the target element, if any.
- `result`: the structured ActionResult, post-mask if secrets-masking applied.
- `t`: monotonic timestamp.
- `sessionId`: owning session.

Read-only tools (`snapshot`, `find`, `inspect`, `text_search`, `network_read` metadata, `console_read`, `screenshot`) do not produce action-trace entries unless the `diagnostics` capability is active.

## The flow recorder's two step kinds

The `start_recording` / `end_recording` / `export_playwright_script` trace
(`src/page/recording.ts`, `RecordedStep`) is a discriminated union:

- `kind: "action"` is a `DispatchedAction` plus the URL and the resolved
  `selectorHint` / `stability`.
- `kind: "read"` is a `RecordedRead`: `extract` (schema + scope), `find`
  (query, with the chosen locator in the step's `selectorHint`), `snapshot`
  (scope), `eval_js` (expression).

Reads get their own arm because a read dispatches nothing. Forcing
`{type:"extract"}` into the action union would put a non-action into
`ActionResult.action` and into every action-shaped consumer downstream.

**Reads record the request, never the response.** The trace holds the schema,
the query, the expression and the scope. Extracted data, snapshot trees and
eval return values never go in, so the recorder stays off the secrets-and-PII
path: no page content reaches the YAML draft or the exported `.spec.ts`.

The flow-file YAML gained a `read: <tool>` step key alongside `action: <type>`,
with `schema` / `query` / `scope` / `expr` beneath it. Consumers that parse the
draft need to handle the new key; existing action steps are byte-identical.

Lowering to Playwright: `extract` → a per-field live re-read bound to a
`const`, `find` → a named locator `const`, `eval_js` → `page.evaluate` of the
recorded expression, `snapshot` → a comment. The exporter's `unhandled` counter
stays honest. A `snapshot`, and an `extract` field with no recorded selector,
lower to no executable step and get counted as unhandled.

## The no-trace contract

When the `diagnostics` capability is **not** active, browxai leaves no artifact outside the workspace. Specifically:

- No recorder file is written.
- No console or network capture is persisted.
- Screenshots and downloads still land in the workspace path via `resolveWorkspacePath`. The workspace contract covers those, and they don't count as traces.

Tests in `src/util/no-trace.test.ts` enforce the no-trace contract. Any new tool that touches disk MUST go through `resolveWorkspacePath` and MUST honor it.

## Replayability (forward-looking)

A planned `.browx-flow.json` format will formalize the action-trace IR as a replayable script. Today the trace is a debugging artifact. Making it executable rests on what the contract above already fixes:

- Stable tool names, semver-frozen, so a replay against a newer browxai picks up the same handlers.
- Stable args, with the Zod schema versioned alongside the tool, so additive args stay forward-compatible.
- A stable ref scheme (`[ref=eN]` within a session), so a replay against the same starting snapshot finds the same nodes.

When you change a tool's input schema, think about replay-compat: an additive optional field is safe, a removed required field breaks replay.

## Related

- [`../secrets-and-egress/network-body-and-secrets.md`](../secrets-and-egress/network-body-and-secrets.md): secrets-masking order, which applies before recorder writes.
- [`../tool-registration/server-tool-registry.md`](../tool-registration/server-tool-registry.md): ActionResult shape.
- [`../architecture/capability-posture-map.md`](../architecture/capability-posture-map.md): `diagnostics` capability semantics.
