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
        "browxai hit an internal check that failed and returned an error instead of a wrong answer. This is a bug in browxai, so do not file an app-crash defect. The session is usually fine. Retry once, and if it recurs, report the message as a browxai defect.";
    } else if (isDeadline) {
      hint =
        "anti-wedge deadline fired: browxai returned instead of waiting on a stuck page operation. This is not an application crash, so do not file an app-crash defect. Retry the call once. If timeouts keep recurring on this session it is wedged: call `close_session`, then `open_session` for a fresh one. A larger `timeoutMs` does not recover a wedged session.";
    } else {
      hint =
        "The browser context was closed or detached on the browxai side (another agent closed the session, or an incognito context was discarded). This is not an application crash, so do not file an app-crash defect. Open the session again and retry.";
    }
    return { source: "browxai", hint };
  }
  if (APP_PATTERNS.test(m)) {
    return {
      source: "app",
      hint: "Application-side failure (navigation or renderer). This is a real app signal, so it is safe to investigate as a defect.",
    };
  }
  return {
    source: "unknown",
    hint: "Origin unclear. Confirm the session is still open with `list_sessions` before treating this as an app defect.",
  };
}
