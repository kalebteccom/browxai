// anti-wedge deadline.
//
// Several inner paths have no Playwright/CDP timeout (`page.evaluate`,
// CDP `send`, a wedged renderer). `withDeadline` races the operation against
// a timer so the *tool always returns* within the deadline. It cannot cancel
// a hung CDP send (the orphaned op settles/errors in the background) — but the
// agent is unblocked with a structured error instead of stalling forever.

export const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
export const MIN_ACTION_TIMEOUT_MS = 1;
export const MAX_ACTION_TIMEOUT_MS = 3_600_000; // 1h hard ceiling

export class DeadlineError extends Error {
  constructor(
    public readonly label: string,
    public readonly ms: number,
  ) {
    super(
      `anti-wedge timeout: "${label}" did not complete within ${ms}ms. ` +
        `This is a RECOVERABLE signal, not a fatal error — the tool returned ` +
        `instead of stalling. Decide which case applies: (a) a transient ` +
        `hiccup — retry the call ONCE; (b) repeated timeouts on this session ` +
        `(snapshot / navigate / screenshot all timing out) — the session is ` +
        `WEDGED: discard it with \`close_session\`, then \`open_session\` a ` +
        `fresh one; retrying or re-navigating in place will NOT recover it; ` +
        `(c) one genuinely slow call — raise \`timeoutMs\` for THAT call only. ` +
        `Raising \`timeoutMs\` never fixes a wedged session, and values near ` +
        `the 1h ceiling are essentially always a mistake.`,
    );
    this.name = "DeadlineError";
  }
}

/**
 * Clamp a requested timeout into [MIN, MAX]. Returns the effective value plus
 * an optional warning when the request was out of range (so the tool can
 * surface "you asked for an insane timeout; clamped").
 */
export function clampTimeout(
  requested: number | undefined,
  fallback: number,
): {
  ms: number;
  warning?: string;
} {
  const raw = requested ?? fallback;
  if (raw > MAX_ACTION_TIMEOUT_MS) {
    return {
      ms: MAX_ACTION_TIMEOUT_MS,
      warning:
        `timeoutMs=${raw} exceeds the 1h hard ceiling — clamped to ${MAX_ACTION_TIMEOUT_MS}ms. ` +
        `A multi-minute action timeout is essentially always a mistake (a real ` +
        `op completes in well under 5s; longer means a no-op/wedge).`,
    };
  }
  if (raw < MIN_ACTION_TIMEOUT_MS) return { ms: MIN_ACTION_TIMEOUT_MS };
  return { ms: raw };
}

/**
 * Race `p` against `ms`. Rejects with `DeadlineError` on expiry. The timer is
 * always cleared (no leaked handles) whichever side wins.
 */
export function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
