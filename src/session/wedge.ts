// W-T1 — per-session wedge detector.
//
// The anti-wedge deadline (see util/deadline.ts) makes every individual call
// return within its budget — but an agent driving a wedged session sees only
// a stream of separate `ok:false` timeouts and must *infer* that the whole
// session is dead. In practice agents miss that inference and retry the dead
// session for a long time. This converts the inference into a server-provided
// signal: after WEDGE_THRESHOLD consecutive anti-wedge deadline-timeouts on a
// session, results carry `sessionWedged: true` + a discard-and-reopen hint.
// Any responsive call (a success, or a fast non-timeout error) clears the
// streak — a responsive call proves the session is still alive.

export const WEDGE_THRESHOLD = 3;

export class WedgeTracker {
  private consecutive = 0;

  /** A call against this session hit the anti-wedge deadline. */
  recordTimeout(): void {
    this.consecutive += 1;
  }

  /** A call against this session returned responsively (a success, or a fast
   *  non-timeout error). The session answered — clear the streak. */
  recordResponsive(): void {
    this.consecutive = 0;
  }

  /** Consecutive anti-wedge timeouts seen so far. */
  get count(): number {
    return this.consecutive;
  }

  /** True once the session has timed out WEDGE_THRESHOLD times in a row. */
  wedged(): boolean {
    return this.consecutive >= WEDGE_THRESHOLD;
  }

  /** Agent-facing recovery hint for a wedged session. */
  hint(): string {
    return (
      `${this.consecutive} consecutive anti-wedge timeouts on this session — ` +
      `it is wedged. STOP retrying it: raising \`timeoutMs\` or re-navigating ` +
      `in place will NOT recover a wedged session. Discard it with ` +
      `\`close_session\`, then \`open_session\` (or any call on a fresh id) ` +
      `to get a clean session. Page state in the wedged session is lost — ` +
      `restart that work in the new session.`
    );
  }
}
