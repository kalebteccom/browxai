# network-body, secrets, and the egress chokepoint

The two capabilities most likely to leak: `network-body` (response bodies) and `secrets` (registered secret values). The order of composition is load-bearing.

## The two capabilities

### `network-body`

When granted, `network_body` returns the full response body (post-content-length) and `route_intercept` can rewrite payloads. Without it, `network_read` returns metadata only — URL, status, headers (with auth stripped), MIME, byte count.

Why off by default: response bodies routinely contain PII, OAuth tokens, customer data. A naive recorder enabled with `network-body` would write all of it to disk.

### `secrets`

`register_secret(name, value)` registers a value in process memory. Tools that emit user-visible text (snapshot, ActionResult, recorder writes) run through a secrets-masking sink that replaces registered values with `<secret:name>`.

Without `secrets`, the registration call returns `capability-denied`. Adopters that need credential injection must opt in.

## Order of composition (load-bearing)

When `diagnostics` + `network-body` + `secrets` are all active, the egress pipeline composes in this order:

1. Tool handler produces raw ActionResult (with response bodies if `network-body`).
2. **Secrets-masking sink applies first.** All registered secret values are replaced.
3. **Recorder writes second.** The recorder sees the masked payload.

Reversing the order would write raw secrets to the recorder file. The composition is enforced in `src/util/secrets-sinks.ts`; tests in `src/util/secrets-sinks.test.ts` verify the order.

## Adding a new egress path

Any new code path that emits user-visible text (a new recorder, a new diagnostics export, a new artifact writer) MUST:

- Route the payload through the secrets-masking sink before writing.
- Honor the `network-body` gate — never include response bodies unless granted.
- Use `resolveWorkspacePath` for filesystem touch (`src/util/workspace.ts`).
- Honor the no-trace contract (`src/util/no-trace.ts`) when `diagnostics` is not active.

## Adding a new sink

A sink is a value-mask transformer. Sinks are registered in `src/util/secrets-sinks.ts`. To add one:

1. Implement the transformer.
2. Register it in the sink list.
3. Add a test asserting it masks registered values in the new output shape.
4. Verify the composition order (mask before recorder) still holds.

## Related

- [`../recorder-and-replay/action-trace-contract.md`](../recorder-and-replay/action-trace-contract.md) — recorder shape (post-mask).
- [`../architecture/capability-posture-map.md`](../architecture/capability-posture-map.md) — capability table.
- [`../../threat-model.md`](../../threat-model.md) — threat-model rows.
