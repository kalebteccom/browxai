// invariant() — assert an internal contract (RFC 0004 L8).
//
// browxai already contains faults at three boundaries as STRUCTURED, recoverable
// refusals rather than crashes: the anti-wedge deadline (`DeadlineError`,
// deadline.ts:13-32), the secrets scope check (`materialize` returns
// `{ok:false, error}`, secrets.ts), and the capability gate (a denied tool
// returns a refusal). L8 generalizes that single proven pattern: every internal
// invariant that, if violated, means browxai itself is in a corrupt state — a
// registry with two entries for one key, a ring whose cap went non-positive, a
// precedence chain that lost a layer — surfaces through the SAME structured-
// refusal envelope, contained at the dispatch boundary, never propagated as an
// uncontained throw that wedges the dispatch loop.
//
// `invariant(cond, msg)` is the fault-containment generalization: it throws an
// `InvariantError` (a tagged, contained error, NOT a bare `assert`) whose message
// is an explicit agent-facing playbook — same posture as `DeadlineError`. The
// dispatcher maps `InvariantError` to a `ToolResponse{ok:false}` the agent can
// act on, exactly as it maps `DeadlineError`. The `classifyFailure` patterns
// (failure.ts) already route a browxai-origin fault to the right recovery, and
// `invariant violated` joins that family.
//
// CRITICAL: an invariant asserts only what the surrounding code ALREADY
// guarantees on valid inputs, so it is a NO-OP in production and on every test —
// the assertion-density fitness function and the full unit + keystone suites run
// with NO invariant firing. An invariant that fires on a legitimate edge case is
// a bug in the invariant, not a feature; assert contracts the code depends on,
// never user-supplied data (that is the boundary's job — L6, validate at the
// edge), and never an optional/best-effort condition.

/** A contained, structured invariant violation — the L8 analogue of
 *  `DeadlineError`. Carries the violated-contract message verbatim; the
 *  dispatcher renders it as a structured refusal (`ToolResponse{ok:false}`),
 *  never a raw throw past the dispatch boundary. `name` is `"InvariantError"` so
 *  the failure classifier and any catch-site can recognise a browxai-origin
 *  internal fault (vs an application/page error). */
export class InvariantError extends Error {
  constructor(message: string) {
    super(
      `invariant violated: ${message}. This is a browxai-internal contract failure ` +
        `(NOT an application or page error) — browxai reached a state one of its own ` +
        `modules guarantees cannot happen, so it refused instead of returning a wrong ` +
        `answer or crashing the dispatch loop. This is a RECOVERABLE signal: the tool ` +
        `returned a structured refusal. Treat it as a defect to report (it indicates a ` +
        `bug in browxai, not in your usage); the session itself is usually unaffected ` +
        `— retry the call, and if it recurs, capture the message and file it.`,
    );
    this.name = "InvariantError";
  }
}

/**
 * Assert an internal invariant. On a falsy `cond`, throws `InvariantError` (a
 * contained, structured refusal — never a bare `assert`/crash). The TypeScript
 * `asserts cond` signature narrows the type after the call, so a passing
 * invariant also tells the compiler the condition holds (the L6 boundary
 * discipline, applied internally) — e.g. `invariant(x !== undefined, …)` lets
 * the code below treat `x` as defined.
 *
 * Use ONLY for contracts the surrounding code already depends on, so the call is
 * a no-op on every valid input. Never validate user/wire data here (that is the
 * boundary's job, L6); never assert an optional or best-effort condition.
 *
 *   invariant(REGISTRY.size > 0, "engine registry is empty at dispatch");
 *   invariant(cap > 0, `ring cap must be positive, got ${cap}`);
 */
export function invariant(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new InvariantError(msg);
  }
}
