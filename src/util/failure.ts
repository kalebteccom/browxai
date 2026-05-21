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
  /(target (page|context|browser).*(closed|crashed)|context (was|has been) (closed|destroyed)|execution context was destroyed|browser has been closed|session closed|page has been closed|protocol error.*(target closed|session closed)|anti-wedge|deadline exceeded|deadlineerror)/i;

const APP_PATTERNS =
  /(page crashed|renderer (crash|process gone)|net::err_|err_(connection|name_not_resolved|aborted|timed_out)|navigation (failed|to .* was interrupted)|frame was detached due to navigation)/i;

/** Pure; exported for unit tests. */
export function classifyFailure(message: string): FailureClass {
  const m = message || "";
  // browxai teardown is checked first: "target closed" mid-navigation is far
  // more often a session reap than a genuine app crash, and a false
  // app-crash defect is the expensive mistake we're preventing.
  if (BROWXAI_PATTERNS.test(m)) {
    // Both a context teardown and an anti-wedge deadline match here, but the
    // right recovery differs — a teardown is fixed by reopening, a deadline
    // must NOT be blindly retried (that is the wedged-session loop).
    const isDeadline = /anti-wedge|deadline exceeded|deadlineerror/i.test(m);
    return {
      source: "browxai",
      hint: isDeadline
        ? "anti-wedge deadline fired — browxai returned instead of stalling on a wedged page op. NOT an application crash; do not file an app-crash defect. Retry the call ONCE; if timeouts keep recurring on this session it is wedged — discard it (`close_session`) and `open_session` a fresh one. A bigger `timeoutMs` will not recover a wedged session."
        : "browxai-side context teardown/detach (session closed by another agent, or an incognito context discarded) — NOT an application crash. Re-open the session and retry; do not file an app-crash defect.",
    };
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
