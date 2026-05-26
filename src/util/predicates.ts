// Shared predicate vocabulary.
//
// One source of truth for "did this thing hold?" assertions across `verify_*`
// (assertive read primitives that fail-emit) and `batch.expect` (per-call
// post-conditions inside a batch). NOT an arbitrary-JS path: the predicate
// `kind` is a fixed enum, and the `key` accessor is restricted to a fixed
// allow-list of namespaced dotted paths into model-supplied data. The model
// chooses *which* key and *which* expected value; the *vocabulary* is server-
// owned. `eval_js` (gated behind the `eval` capability) is the only arbitrary-
// JS escape hatch; the predicate engine deliberately does NOT add a second.
//
// Composition kinds (`and`/`or`/`not`) are leaf-recursive — you can build
// "value contains "foo" AND warnings.length lt 3" without an `eval` round
// trip.
//
// `evaluatePredicate(predicate, data)` returns one of:
//   { ok: true }                         — predicate held
//   { ok: false, expected, actual, …}    — predicate did not hold; carries
//                                          enough to populate a failure
//
// The `data` argument is a small bag the caller assembles — e.g. for a
// verify-family call: `{ actionResult: {...}, snapshot: {...} }`. The
// accessor-key allow-list (`isAllowedKey`) caps which paths the model may
// probe.

export type LeafKind =
  | "equals"
  | "notEquals"
  | "contains"
  | "notContains"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "between"
  | "matches"
  | "exists";

export type CompositeKind = "and" | "or" | "not";

export type PredicateKind = LeafKind | CompositeKind;

export interface LeafPredicate {
  kind: LeafKind;
  /** Dotted accessor into `data`. Must be in the allow-list (see `isAllowedKey`). */
  key: string;
  /** Comparison value for kinds that take one (equals/notEquals/contains/
   *  notContains/gt/lt/gte/lte/matches). Required by those kinds. */
  value?: string | number | boolean | null;
  /** `between` bounds. Required by `between`. Inclusive. */
  lo?: number;
  hi?: number;
}

export interface CompositePredicate {
  kind: CompositeKind;
  /** Operand predicates. `and`/`or` need ≥1; `not` takes exactly the first. */
  predicates: Predicate[];
}

export type Predicate = LeafPredicate | CompositePredicate;

export interface PredicatePass { ok: true }
export interface PredicateFail {
  ok: false;
  /** Stable kind label of the failing leaf (or the failing combinator). */
  kind: PredicateKind;
  /** Accessor key that failed (when produced by a leaf). Composite combinators
   *  surface the first failing child's key for diagnosis. */
  key?: string;
  /** Human-readable label for the expected condition — e.g. "equals \"x\"",
   *  "between 0 and 10", "and([…])". Stable shape; used by callers as
   *  `failure.expected`. */
  expected: string;
  /** The actual value the accessor resolved to, or a structural description
   *  for composite failures ("3 of 4 children passed", etc). */
  actual: unknown;
}

export type PredicateResult = PredicatePass | PredicateFail;

/** Allow-listed accessor key prefixes for `data` paths. The predicate engine
 *  refuses any `key` whose root segment isn't on this list — keeps adopters
 *  from probing into objects we haven't deliberately surfaced. New surfaces
 *  must be added here (and documented). */
const ALLOWED_KEY_ROOTS: ReadonlySet<string> = new Set([
  // `verify_predicate` data bag
  "actionResult",
  "snapshot",
  "element",
  "value",
  // `batch.expect` shorthand routing
  "expect",
]);

/** Does `key` start with one of the allow-listed roots? Pure; exported for
 *  tests + the registration-time validator. */
export function isAllowedKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  const root = key.split(".")[0] ?? "";
  return ALLOWED_KEY_ROOTS.has(root);
}

/** The full set of allow-listed roots — exported so docs / tool descriptions
 *  can render the list without a second source of truth. */
export function allowedKeyRoots(): readonly string[] {
  return [...ALLOWED_KEY_ROOTS].sort();
}

/**
 * Resolve a dotted accessor key against `data`. Supports the special trailing
 * `.length` segment over arrays + strings (returns the numeric length).
 * Returns `undefined` for missing intermediate keys. Pure; exported for tests.
 */
export function resolveKey(data: unknown, key: string): unknown {
  if (!isAllowedKey(key)) return undefined;
  const parts = key.split(".");
  let cur: unknown = data;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (part === "length" && (Array.isArray(cur) || typeof cur === "string")) {
      cur = (cur as { length: number }).length;
      continue;
    }
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Top-level evaluator. Pure; the engine never touches DOM / page / network —
 *  callers stage the data bag and pass it in. */
export function evaluatePredicate(predicate: Predicate, data: unknown): PredicateResult {
  // Composite first so we don't fall through.
  if (predicate.kind === "and") {
    return evalAnd(predicate, data);
  }
  if (predicate.kind === "or") {
    return evalOr(predicate, data);
  }
  if (predicate.kind === "not") {
    return evalNot(predicate, data);
  }
  return evalLeaf(predicate as LeafPredicate, data);
}

function evalAnd(p: CompositePredicate, data: unknown): PredicateResult {
  if (!Array.isArray(p.predicates) || p.predicates.length === 0) {
    return { ok: false, kind: "and", expected: "and([…]) with ≥1 child", actual: "no children" };
  }
  for (let i = 0; i < p.predicates.length; i++) {
    const r = evaluatePredicate(p.predicates[i]!, data);
    if (!r.ok) {
      return {
        ok: false,
        kind: "and",
        ...(r.key !== undefined ? { key: r.key } : {}),
        expected: `and(child[${i}]: ${r.expected})`,
        actual: r.actual,
      };
    }
  }
  return { ok: true };
}

function evalOr(p: CompositePredicate, data: unknown): PredicateResult {
  if (!Array.isArray(p.predicates) || p.predicates.length === 0) {
    return { ok: false, kind: "or", expected: "or([…]) with ≥1 child", actual: "no children" };
  }
  const childActuals: unknown[] = [];
  for (const child of p.predicates) {
    const r = evaluatePredicate(child, data);
    if (r.ok) return { ok: true };
    childActuals.push(r.actual);
  }
  return {
    ok: false,
    kind: "or",
    expected: `or(any of ${p.predicates.length} children)`,
    actual: childActuals,
  };
}

function evalNot(p: CompositePredicate, data: unknown): PredicateResult {
  if (!Array.isArray(p.predicates) || p.predicates.length !== 1) {
    return { ok: false, kind: "not", expected: "not(child) with exactly one child", actual: `${p.predicates?.length ?? 0} children` };
  }
  const r = evaluatePredicate(p.predicates[0]!, data);
  if (r.ok) {
    return {
      ok: false,
      kind: "not",
      expected: "not(child) — child should NOT hold but did",
      actual: "child predicate held",
    };
  }
  return { ok: true };
}

function evalLeaf(p: LeafPredicate, data: unknown): PredicateResult {
  if (!isAllowedKey(p.key)) {
    return {
      ok: false,
      kind: p.kind,
      key: p.key,
      expected: `accessor key on the allow-list (roots: ${allowedKeyRoots().join(", ")})`,
      actual: `unknown root in key "${p.key}"`,
    };
  }
  const actual = resolveKey(data, p.key);
  switch (p.kind) {
    case "equals":
      if (sameValue(actual, p.value ?? null)) return { ok: true };
      return fail(p, actual, `equals ${jsonish(p.value)}`);
    case "notEquals":
      if (!sameValue(actual, p.value ?? null)) return { ok: true };
      return fail(p, actual, `notEquals ${jsonish(p.value)}`);
    case "contains":
      if (containsValue(actual, p.value)) return { ok: true };
      return fail(p, actual, `contains ${jsonish(p.value)}`);
    case "notContains":
      if (!containsValue(actual, p.value)) return { ok: true };
      return fail(p, actual, `notContains ${jsonish(p.value)}`);
    case "gt":
      if (numCompare(actual, p.value, (a, b) => a > b)) return { ok: true };
      return fail(p, actual, `gt ${jsonish(p.value)}`);
    case "lt":
      if (numCompare(actual, p.value, (a, b) => a < b)) return { ok: true };
      return fail(p, actual, `lt ${jsonish(p.value)}`);
    case "gte":
      if (numCompare(actual, p.value, (a, b) => a >= b)) return { ok: true };
      return fail(p, actual, `gte ${jsonish(p.value)}`);
    case "lte":
      if (numCompare(actual, p.value, (a, b) => a <= b)) return { ok: true };
      return fail(p, actual, `lte ${jsonish(p.value)}`);
    case "between":
      if (typeof p.lo !== "number" || typeof p.hi !== "number") {
        return { ok: false, kind: p.kind, key: p.key, expected: "between with numeric lo + hi", actual: `lo=${jsonish(p.lo)}, hi=${jsonish(p.hi)}` };
      }
      if (typeof actual === "number" && actual >= p.lo && actual <= p.hi) return { ok: true };
      return fail(p, actual, `between ${p.lo} and ${p.hi} (inclusive)`);
    case "matches": {
      if (typeof p.value !== "string") {
        return { ok: false, kind: p.kind, key: p.key, expected: "matches with a regex string", actual: `value=${jsonish(p.value)}` };
      }
      let re: RegExp;
      try { re = new RegExp(p.value); }
      catch (e) {
        return { ok: false, kind: p.kind, key: p.key, expected: `matches /${p.value}/`, actual: `invalid regex: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (typeof actual === "string" && re.test(actual)) return { ok: true };
      return fail(p, actual, `matches /${p.value}/`);
    }
    case "exists":
      if (actual !== undefined && actual !== null) return { ok: true };
      return fail(p, actual, "exists (non-null/undefined)");
  }
}

function fail(p: LeafPredicate, actual: unknown, expected: string): PredicateFail {
  return { ok: false, kind: p.kind, key: p.key, expected, actual };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // numbers, strings, booleans, null: strict equality covers the model-
  // supplied case. Don't deep-equal arrays/objects — keep semantics tight.
  return false;
}

function containsValue(haystack: unknown, needle: unknown): boolean {
  if (typeof needle !== "string" && typeof needle !== "number") return false;
  const n = String(needle);
  if (typeof haystack === "string") return haystack.includes(n);
  if (Array.isArray(haystack)) {
    return haystack.some((item) => item === needle || String(item) === n);
  }
  return false;
}

function numCompare(a: unknown, b: unknown, cmp: (x: number, y: number) => boolean): boolean {
  if (typeof a !== "number" || typeof b !== "number") return false;
  return cmp(a, b);
}

function jsonish(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Validate a predicate's structural shape (kind, key allow-list, required
 * fields per kind). Returns null when fine, else a string explaining the
 * problem. Use at registration / arg-parse time to fail fast with a clear
 * message; the evaluator itself also tolerates bad shapes (returns ok:false).
 */
export function validatePredicate(p: unknown, path = "predicate"): string | null {
  if (!p || typeof p !== "object") return `${path}: must be an object`;
  const obj = p as Record<string, unknown>;
  const kind = obj["kind"];
  if (typeof kind !== "string") return `${path}: missing "kind" string`;
  if (kind === "and" || kind === "or" || kind === "not") {
    const kids = obj["predicates"];
    if (!Array.isArray(kids) || kids.length === 0) {
      return `${path}: "${kind}" requires "predicates" array with ≥1 entries`;
    }
    if (kind === "not" && kids.length !== 1) {
      return `${path}: "not" takes exactly one child predicate`;
    }
    for (let i = 0; i < kids.length; i++) {
      const child = validatePredicate(kids[i], `${path}.predicates[${i}]`);
      if (child) return child;
    }
    return null;
  }
  const leafKinds: ReadonlySet<string> = new Set([
    "equals", "notEquals", "contains", "notContains",
    "gt", "lt", "gte", "lte", "between", "matches", "exists",
  ]);
  if (!leafKinds.has(kind)) {
    return `${path}: unknown kind "${kind}" (valid: ${[...leafKinds, "and", "or", "not"].join(", ")})`;
  }
  const key = obj["key"];
  if (typeof key !== "string" || key.length === 0) return `${path}: missing "key" string`;
  if (!isAllowedKey(key)) {
    return `${path}: key "${key}" not allowed (roots: ${allowedKeyRoots().join(", ")})`;
  }
  if (kind === "between") {
    if (typeof obj["lo"] !== "number" || typeof obj["hi"] !== "number") {
      return `${path}: "between" requires numeric "lo" and "hi"`;
    }
    return null;
  }
  if (kind === "exists") return null;
  // remaining kinds need `value`
  if (!("value" in obj)) return `${path}: "${kind}" requires "value"`;
  return null;
}
