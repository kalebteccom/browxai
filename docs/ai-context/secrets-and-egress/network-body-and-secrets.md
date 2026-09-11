# network-body, secrets, and the egress chokepoint

The two capabilities most likely to leak are `network-body` (response bodies) and `secrets` (registered secret values). The order they compose in is load-bearing.

## The two capabilities

### `network-body`

When granted, `network_body` returns the full response body, post-content-length. `route_intercept` can rewrite payloads too. Without the capability, `network_read` returns metadata only: URL, status, headers with auth stripped, MIME and byte count.

Why it's off by default: response bodies routinely carry PII, OAuth tokens and customer data. A naive recorder running with `network-body` granted would write all of it to disk.

### `secrets`

`register_secret(name, value)` registers a value in process memory. Tools that emit user-visible text (snapshot, ActionResult, recorder writes) run through a secrets-masking sink that replaces registered values with `<secret:name>`. Without `secrets`, the call returns `capability-denied`, so credential injection is opt-in.

## Order of composition (load-bearing)

When `diagnostics`, `network-body` and `secrets` are all active, the egress pipeline composes in this order:

1. The tool handler produces a raw ActionResult, with response bodies if `network-body` is granted.
2. **The secrets-masking sink applies first.** Every registered secret value is replaced.
3. The recorder writes second, and sees only the masked payload.

Reverse that and the recorder file gets raw secrets. `src/util/secrets-sinks.ts` enforces the composition, and `src/util/secrets-sinks.test.ts` verifies the order.

## Adding a new egress path

Any new code path that emits user-visible text (a new recorder, a new diagnostics export, a new artifact writer) MUST:

- Route the payload through the secrets-masking sink before writing.
- Honor the `network-body` gate. Never include response bodies unless granted.
- Use `resolveWorkspacePath` for filesystem touch (`src/util/workspace.ts`).
- Honor the no-trace contract (`src/util/no-trace.ts`) when `diagnostics` is not active.

## Adding a new sink

A sink is a value-mask transformer, and sinks live in `src/util/secrets-sinks.ts`. To add one:

1. Implement the transformer.
2. Register it in the sink list.
3. Add a test asserting it masks registered values in the new output shape.
4. Verify the composition order, mask before recorder, still holds.

## Related

- [`../recorder-and-replay/action-trace-contract.md`](../recorder-and-replay/action-trace-contract.md): recorder shape, post-mask.
- [`../architecture/capability-posture-map.md`](../architecture/capability-posture-map.md): capability table.
- [`../../threat-model.md`](../../threat-model.md): threat-model rows.
