// Classify a failure as app-origin vs browxai-origin.
//
// A browxai-side context teardown/detach (another agent closed the session,
// an incognito context was discarded, an anti-wedge deadline fired) surfaces
// as a Playwright/CDP error that *looks* identical to an application
// navigation or renderer crash. Agents then file expensive false "CRITICAL:
// page crashed" defects against the app. This labels the failure so the agent
// can tell "the app broke" from "the tool tore the context down".

export type FailureSource = "app" | "browxai" | "unknown";

export interface FailureClass {
  source: FailureSource;
  /** one-line, agent-facing: what this almost certainly is + what to do. */
  hint: string;
}

const BROWXAI_PATTERNS =
  /(target (page|context|browser).*(closed|crashed)|context (was|has been) (closed|destroyed)|execution context was destroyed|browser has been closed|session closed|page has been closed|protocol error.*(target closed|session closed)|anti-wedge|deadline exceeded|deadlineerror|invariant violated|invarianterror)/i;

const APP_PATTERNS =
  /(page crashed|renderer (crash|process gone)|net::err_|err_(connection|name_not_resolved|aborted|timed_out)|navigation (failed|to .* was interrupted)|frame was detached due to navigation)/i;

/** Pure; exported for unit tests. */
export function classifyFailure(message: string): FailureClass {
  const m = message || "";
  // browxai teardown is checked first: "target closed" mid-navigation is far
  // more often a session reap than a genuine app crash, and a false
  // app-crash defect is the expensive mistake we're preventing.
  if (BROWXAI_PATTERNS.test(m)) {
    // Three browxai-origin shapes match here, each with a different recovery: a
    // context teardown is fixed by reopening; an anti-wedge deadline must NOT be
    // blindly retried (that is the wedged-session loop); an invariant violation
    // (L8) is a browxai-internal contract failure — a defect to report, not a
    // usage error, and the session itself is usually unaffected.
    const isDeadline = /anti-wedge|deadline exceeded|deadlineerror/i.test(m);
    const isInvariant = /invariant violated|invarianterror/i.test(m);
    let hint: string;
    if (isInvariant) {
      hint =
        "browxai-internal invariant violated (L8) — browxai reached a state one of its own modules guarantees cannot happen and refused with a structured error instead of returning a wrong answer. NOT an application crash and NOT a usage error: this indicates a bug in browxai. The session is usually unaffected — retry once; if it recurs, capture the message and file it as a browxai defect.";
    } else if (isDeadline) {
      hint =
        "anti-wedge deadline fired — browxai returned instead of stalling on a wedged page op. NOT an application crash; do not file an app-crash defect. Retry the call ONCE; if timeouts keep recurring on this session it is wedged — discard it (`close_session`) and `open_session` a fresh one. A bigger `timeoutMs` will not recover a wedged session.";
    } else {
      hint =
        "browxai-side context teardown/detach (session closed by another agent, or an incognito context discarded) — NOT an application crash. Re-open the session and retry; do not file an app-crash defect.";
    }
    return { source: "browxai", hint };
  }
  if (APP_PATTERNS.test(m)) {
    return {
      source: "app",
      hint: "application-origin failure (navigation/renderer). This one is a real app signal — safe to investigate as a defect.",
    };
  }
  return {
    source: "unknown",
    hint: "origin indeterminate — confirm the session is still open (list_sessions) before treating this as an app defect.",
  };
}
