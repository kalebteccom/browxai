// Runtime configuration sourced from env. Resolved once at startup so behaviour
// is predictable per-session. Adopters who need to add a project-conventional
// data-attribute (e.g. some codebases use `data-type`, `data-cy`, `data-qa`)
// can do so without code changes:
//
//   BROWX_TEST_ATTRIBUTES=data-testid,data-test,data-cy,data-qa,data-type
//
// The list is order-sensitive: the **first** match on a node wins as its `testId`
// and the matched attribute name flows through to selectorHint so the agent
// transcribes the right selector ("[data-type=\"foo\"]", not "[data-testid=\"foo\"]").

const DEFAULT_TEST_ATTRIBUTES = ["data-testid", "data-test", "data-cy", "data-qa"];

/**
 * Threshold below which `snapshot()` emits the "low-content" warning (Phase-1.5
 * ask #11). Tuned conservatively — most non-trivial pages have well more than 5
 * interactive descendants in the a11y tree; a hydrated page returning fewer is
 * almost always a sparse-a11y SPA where the DOM-walk fallback wins.
 */
export const LOW_A11Y_THRESHOLD = 5;

export interface BrowxConfig {
  testAttributes: string[];
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): BrowxConfig {
  const raw = env.BROWX_TEST_ATTRIBUTES?.trim();
  const list = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_TEST_ATTRIBUTES;
  return { testAttributes: list };
}
