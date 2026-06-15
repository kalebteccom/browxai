// Extraction type vocabulary — the schema/hint/evidence/result types shared by
// the `extract` orchestrator and the resolution engine. Split out of extract.ts
// so neither file carries the other's bulk; re-exported through `./extract.js`.

/** Private marker stamped on a hint when the implicit name-as-query lowering ran
 *  (so the per-leaf resolver knows the query is internal, not user-supplied — and
 *  skips the retirement warning). Module-private symbol; never surfaces in
 *  serialised schemas. */
export const IMPLICIT_QUERY = Symbol.for("browxai.extract.implicitQuery");
export type HintWithMarker = ExtractSourceHint & { [IMPLICIT_QUERY]?: true };

/** Mode toggle. `"deterministic"` is the only supported value. The legacy
 *  `"llm-assisted"` literal is retained in the union so that runtime callers
 *  passing it (pre-v0.3.2 adopters) still type-check at the page-layer boundary;
 *  the SDK type no longer exposes it. At runtime it is tolerated with a
 *  `console.warn` and falls through to deterministic. */
export type ExtractMode = "deterministic" | "llm-assisted";

/** A JSON-Schema-flavoured shape. We accept the subset that has a clear
 *  selector-lowering: object, array, string, number, boolean. `properties`
 *  / `items` recurse; the `x-browx-source` extension is the explicit DSL. */
export interface ExtractSchema {
  type: "object" | "array" | "string" | "number" | "boolean";
  /** Property map for `type:"object"`. Keys are property names; the property
   *  name *is* the implicit query unless overridden via x-browx-source. */
  properties?: Record<string, ExtractSchema>;
  /** Item schema for `type:"array"`. Required when `type:"array"`. */
  items?: ExtractSchema;
  /** Per-property explicit source annotation. Overrides the implicit
   *  "property name = query" rule. All fields optional; the first present
   *  field wins in source-resolution order. */
  "x-browx-source"?: ExtractSourceHint;
  /** Optional fallback default when extraction misses. The result still
   *  records the miss in `evidence.partialMisses` — the default keeps the
   *  data shape sane without lying about ground truth. */
  default?: unknown;
  /** Whether the field is required. Default false. Required misses surface
   *  in `failure.partialMisses`; optional misses only emit `partialMiss`
   *  evidence. */
  required?: boolean;
}

export interface ExtractSourceHint {
  /** RETIRED in v0.3.3 — the NL tree-scan ranker is unreliable for
   *  explicit prose-style per-field queries (uniform null/0 across rows
   *  with no partialMiss surfaced; see R-5). The typed SDK no longer
   *  exposes this field; passing it at runtime emits a one-shot warn and
   *  records a partialMisses entry so the diagnostic surfaces. Use
   *  `selector` (raw CSS) instead — the implicit property-name lowering
   *  still works for testid-friendly pages. Retained on the page-layer
   *  type so the internal implicit-name path keeps compiling. */
  query?: string;
  /** Raw CSS / selectorHint, resolved against the current scope. */
  selector?: string;
  /** When set, read this HTML attribute (e.g. "href", "data-state") from
   *  the matched element. Mutually exclusive with `prop` / `text` / `value`. */
  attr?: string;
  /** When set, read this DOM property (e.g. "value", "checked") via the
   *  page-side. Mutually exclusive with `attr` / `text` / `value`. */
  prop?: string;
  /** When `true`, read the trimmed visible text. The default behaviour
   *  when no read-mode hint is set. */
  text?: boolean;
  /** When `true`, read the form-control value (alias for `prop:"value"`). */
  value?: boolean;
  /** For `type:"array"` only — the collection container selector OR query
   *  whose matches each get a per-row scope. */
  collection?: string;
}

export interface ExtractOptions {
  /** JSON-schema input. Must be a top-level object or array. Accepts an
   *  already-typed `ExtractSchema` (internal callers) or a raw wire object
   *  (the MCP `extract` tool passes the untrusted payload straight through);
   *  `extract()` validates it via `validateSchema` and returns a structured
   *  `invalid-schema` failure when it is malformed. */
  schema: ExtractSchema | Record<string, unknown>;
  /** Scope to a ref's subtree (from a prior snapshot/find). */
  ref?: string;
  /** Scope to a CSS selector match. Mutually exclusive with `ref`. */
  scope?: string;
  /** Default `"deterministic"` (the only supported path). RETIRED in
   *  v0.3.2 — `"llm-assisted"` is tolerated at runtime for back-compat
   *  (warn + treat as deterministic) but is no longer in the SDK type.
   *  Drop the arg from new code. */
  mode?: ExtractMode;
  testAttributes: string[];
  /** When true, v0.2.2's unknown-`x-browx-source`-key diagnostics are
   *  promoted from `evidence.partialMisses` entries to hard `ok:false`
   *  `invalid-schema` rejections — adopters who want first-class typo
   *  detection enable this. Defaults to `process.env.BROWX_EXTRACT_STRICT`
   *  being set when undefined. The integer→number coerce and the
   *  selector-as-collection alias are NOT promoted by this flag — those
   *  are educational signals, not typo-like errors. */
  strictUnknownHintKeys?: boolean;
}

export interface ExtractEvidence {
  /** Refs (stable `eN`) the extractor drew from, deduped. Lets the caller
   *  pin them via `name_ref` or cache the lookup. */
  refsUsed: string[];
  /** Selectors / queries the extractor actually resolved against — useful
   *  for adopters debugging "why did this property come back empty?". */
  selectorsUsed: string[];
  /** Property paths that had no match and (when required) caused the
   *  extraction to fail. Each entry is the dotted path through the schema
   *  ("rows[3].price"). */
  partialMisses: string[];
}

export interface ExtractFailure {
  /** `"app"` when the schema didn't fit the page (missing required fields);
   *  `"browxai"` when extract itself couldn't run (invalid scope, invalid
   *  schema). */
  source: "app" | "browxai";
  /** Stable kind label. `"llm-assisted-not-implemented"` is retained in the
   *  union as a RETIRED kind — v0.3.2 stopped emitting it (the `mode` arg
   *  is tolerated with a warn instead). New code should not narrow on it. */
  kind: "invalid-schema" | "scope-not-found" | "required-miss" | "llm-assisted-not-implemented";
  expected: string;
  actual: unknown;
  evidence?: Partial<ExtractEvidence> & Record<string, unknown>;
  /** When `required-miss`: the missing property paths. */
  partialMisses?: string[];
}

export type ExtractResult =
  | { ok: true; data: unknown; evidence: ExtractEvidence; tokensEstimate: number }
  | { ok: false; failure: ExtractFailure; tokensEstimate: number };
