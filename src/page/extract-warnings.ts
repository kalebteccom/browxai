// One-shot deprecation warnings for the retired extract options. Module state so
// adopters don't spam stderr on every call; the test-only reset hooks let the
// regression suite re-assert the warn fires. Split out of extract.ts.

/** One-shot warn for the RETIRED `mode:"llm-assisted"` arg (v0.3.2). Module
 *  state so adopters don't spam stderr on every extract call. */
let __llmAssistedWarned = false;
export function warnLlmAssistedRetired(): void {
  if (__llmAssistedWarned) return;
  __llmAssistedWarned = true;
  console.warn(
    'browxai: extract({ mode: "llm-assisted" }) is RETIRED as of v0.3.2 — ' +
      "the `mode` arg is no longer part of the SDK type. Treating as " +
      'mode:"deterministic" (the only supported path). Drop the arg from ' +
      "your call site to silence this warning.",
  );
}
/** Test-only hook — resets the one-shot guard so the warn-emission can be
 *  re-asserted in isolation. Not exported from `index.ts`. */
export function __resetLlmAssistedWarnedForTests(): void {
  __llmAssistedWarned = false;
}

/** One-shot warn for the RETIRED `x-browx-source.query` per-field hint
 *  (v0.3.3). The natural-language tree-scan ranker is unreliable in
 *  production — wrightxai's smoke trial saw the LLM author a prose query
 *  for a per-row numeric field on Hacker News, and the resolver returned
 *  null for every row (one stale ref re-used across all 30 row scopes,
 *  no partialMiss surfaced — the agent burned 14 revisions). Same shape
 *  of defect as R-1's `mode:"llm-assisted"`: advertised in the typed SDK,
 *  unreliable at runtime. Retired at the typed boundary; tolerated at
 *  runtime with a one-shot warn + per-call `partialMisses` entry so the
 *  caller sees the actionable diagnostic.
 *
 *  Note: this guards the EXPLICIT user-supplied `query`. The implicit
 *  "property-name as query" lowering path (`resolveObject` stamps
 *  `{ query: name }` for an un-hinted property) is unchanged — the bare
 *  property-name case still works on testid-rich pages and is the
 *  documented primary path. */
let __explicitNlQueryWarned = false;
export function warnExplicitNlQueryRetired(): void {
  if (__explicitNlQueryWarned) return;
  __explicitNlQueryWarned = true;
  console.warn(
    "browxai: extract() — explicit per-field `x-browx-source.query` is " +
      "RETIRED as of v0.3.3. The NL tree-scan ranker is unreliable on " +
      "prose-style queries (uniform null/0 across rows, no partialMiss " +
      "surfaced — see R-5 / wrightxai smoke trial). Use " +
      "`x-browx-source.selector` (raw CSS / selectorHint) for per-field " +
      "targeting; the implicit property-name lowering still works for " +
      "testid-friendly pages. The runtime still attempts resolution and " +
      "records a partialMisses entry so the diagnostic surfaces in " +
      "evidence — drop explicit `query:` to silence this warning.",
  );
}
/** Test-only hook — resets the one-shot guard so the warn-emission can be
 *  re-asserted in isolation. Not exported from `index.ts`. */
export function __resetExplicitNlQueryWarnedForTests(): void {
  __explicitNlQueryWarned = false;
}
