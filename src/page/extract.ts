// Structured schema-driven extract primitive.
//
// The schema-as-contract primitive every browxai
// adopter currently rebuilds the same "parse this table into rows" loop on
// top of `snapshot()`. Stagehand `extract`, Skyvern, browser-use all ship
// this. browxai's version is **deterministic only** (selector-only —
// schema fields lower to `find()` / selector queries scoped to a subtree).
//
// The `mode` arg is RETIRED as of v0.3.2 — deterministic is the supported
// path. `mode:"llm-assisted"` is tolerated for back-compat (warn + fall
// through to deterministic) but is no longer in the typed SDK surface.
//
// The schema is the contract: invalid input / partial matches surface in
// `failure.partialMisses`, never silently coerced into a malformed object.
//
// Schema-to-query lowering. Two paths, deliberately layered:
//
//   1. **Implicit (the simple rule):** the property *name* is the find()
//      query. `{type:"string"}` property `"price"` → look for a node
//      matching "price" within the current scope and read its visible
//      text. Works on testid-rich pages where the property names line up
//      with `data-testid` tokens / accessible names.
//
//   2. **Explicit (the escape hatch):** a property may carry an
//      `x-browx-source` annotation overriding any of {query, selector,
//      attr, prop, text, value}. This is the richer DSL the design
//      called out as a tension — we ship both rules and document the
//      simple one as the primary path. The escape hatch covers the cases
//      where the name doesn't carry enough signal (`"theFirstThing":
//      <selector>`) or where the value isn't innerText (an attribute,
//      a DOM property, a form-control value).
//
// Arrays lower to a collection probe: `{type:"array", items:<inner>,
// "x-browx-source":{collection:<selectorOrQuery>}}` finds the container
// elements and runs the inner schema scoped to each. Without an explicit
// collection, an array property is rejected as `partialMiss: "array needs
// x-browx-source.collection"` — there's no defensible implicit default
// (the empty list is a lie).
//
// Nested objects recurse — each sub-property resolves within the parent's
// scope, exactly the same lowering rule.
//
// Refs used during extraction land in `evidence.refsUsed` so the caller
// can audit / cache / pin (`name_ref`) the elements the result drew from.

import type { CDPSession, Locator, Page } from "playwright-core";
import { walk, type A11yNode } from "./a11y.js";
import type { RefRegistry } from "./refs.js";
import { composeSnapshot } from "./compose.js";
import { findByRef } from "./snapshot.js";
import { estimateTokens } from "../util/tokens.js";

/** One-shot warn for the RETIRED `mode:"llm-assisted"` arg (v0.3.2). Module
 *  state so adopters don't spam stderr on every extract call. Exposed
 *  internally as `__resetLlmAssistedWarnedForTests` for the regression
 *  test that asserts the warn fires. */
let __llmAssistedWarned = false;
function warnLlmAssistedRetired(): void {
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

/** Mode toggle. `"deterministic"` is the only supported value. The legacy
 *  `"llm-assisted"` literal is retained in the union so that runtime callers
 *  passing it (pre-v0.3.2 adopters) still type-check at the page-layer
 *  boundary; the SDK type no longer exposes it. At runtime it is tolerated
 *  with a `console.warn` and falls through to deterministic. */
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
  /** Natural-language query passed to the tree-scan ranker (find()-style). */
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
  /** JSON-schema input. Must be a top-level object or array. */
  schema: ExtractSchema;
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
  kind:
    | "invalid-schema"
    | "scope-not-found"
    | "required-miss"
    | "llm-assisted-not-implemented";
  expected: string;
  actual: unknown;
  evidence?: Partial<ExtractEvidence> & Record<string, unknown>;
  /** When `required-miss`: the missing property paths. */
  partialMisses?: string[];
}

export type ExtractResult =
  | { ok: true; data: unknown; evidence: ExtractEvidence; tokensEstimate: number }
  | { ok: false; failure: ExtractFailure; tokensEstimate: number };

/** Entry point — runs the composed snapshot, scopes it, walks the schema. */
export async function extract(
  page: Page,
  cdp: CDPSession,
  refs: RefRegistry,
  opts: ExtractOptions,
): Promise<ExtractResult> {
  // The `mode` arg is RETIRED as of v0.3.2 — deterministic is the only
  // supported path. Tolerate `mode:"llm-assisted"` at runtime (graceful
  // deprecation per the "never hard-break config-input APIs" policy):
  // emit a one-shot console.warn and fall through to deterministic. No
  // downstream code branches on the mode any more.
  if (opts.mode === "llm-assisted") {
    warnLlmAssistedRetired();
  }
  // Schema-dialect relaxations (v0.2.3 Proposals A + B). Clone first so we
  // never mutate the caller-supplied object. The relaxation notes ride
  // through to evidence.partialMisses on the successful path.
  const relaxedSchema = cloneSchema(opts.schema);
  const relaxationNotes: string[] = [];
  applySchemaRelaxations(relaxedSchema, "", relaxationNotes);

  const schemaError = validateSchema(relaxedSchema, "");
  if (schemaError) {
    return fail({
      source: "browxai",
      kind: "invalid-schema",
      expected: "a JSON schema whose root is object or array",
      actual: schemaError,
    });
  }
  // Proposal D (v0.2.3): when strict mode is on, promote v0.2.2's
  // unknown-`x-browx-source`-key diagnostics from soft `partialMisses`
  // entries to a hard `invalid-schema` rejection. The integer-coerce and
  // selector-alias notes are NOT promoted — they're educational signals,
  // not typo-like errors. Default off; opt-in via env or call-arg.
  const strict =
    opts.strictUnknownHintKeys ??
    process.env.BROWX_EXTRACT_STRICT === "1";
  if (strict) {
    const unknown: string[] = [];
    collectUnknownHintKeys(relaxedSchema, "", unknown);
    if (unknown.length > 0) {
      return fail({
        source: "browxai",
        kind: "invalid-schema",
        expected: "every `x-browx-source` key to be one of the known set (BROWX_EXTRACT_STRICT=1 is on)",
        actual: unknown.join(" | "),
      });
    }
  }
  if (opts.ref && opts.scope) {
    return fail({
      source: "browxai",
      kind: "invalid-schema",
      expected: "exactly one of `ref` or `scope`",
      actual: "both provided",
    });
  }
  const composed = await composeSnapshot(cdp, refs, opts.testAttributes);
  const tree = composed.tree;
  if (!tree) {
    return fail({
      source: "app",
      kind: "scope-not-found",
      expected: "a non-empty accessibility tree",
      actual: "empty",
    });
  }
  let scopeTree: A11yNode = tree;
  let scopeLocator: Locator | undefined;
  if (opts.ref) {
    const sub = findByRef(tree, opts.ref);
    if (!sub) {
      return fail({
        source: "browxai",
        kind: "scope-not-found",
        expected: `ref "${opts.ref}" to resolve in the current snapshot`,
        actual: "no matching ref",
      });
    }
    scopeTree = sub;
    scopeLocator = locatorForRef(page, refs, opts.ref);
  } else if (opts.scope) {
    scopeLocator = page.locator(opts.scope).first();
    // Verify the scope matches at least one node, else surface a structured
    // failure (empty-scope invariant).
    let count = 0;
    try {
      count = await page.locator(opts.scope).count();
    } catch {
      count = 0;
    }
    if (count === 0) {
      return fail({
        source: "browxai",
        kind: "scope-not-found",
        expected: `scope selector "${opts.scope}" to match ≥1 element`,
        actual: "0 matches",
      });
    }
  }

  const { data, evidence, requiredMisses } = await resolveAgainstTree({
    schema: relaxedSchema,
    page,
    scopeTree,
    scopeLocator,
  });
  // Educational A/B notes ride at the head of partialMisses so the agent
  // sees them on the same observation as the resolved data.
  if (relaxationNotes.length > 0) {
    evidence.partialMisses = [...relaxationNotes, ...evidence.partialMisses];
  }

  if (requiredMisses.length > 0) {
    return fail({
      source: "app",
      kind: "required-miss",
      expected: "all required schema properties to resolve",
      actual: `${requiredMisses.length} required field(s) missing`,
      evidence: {
        refsUsed: dedupe(evidence.refsUsed),
        selectorsUsed: dedupe(evidence.selectorsUsed),
        partialMisses: evidence.partialMisses,
      },
      partialMisses: requiredMisses,
    });
  }

  const out: ExtractResult = {
    ok: true,
    data,
    evidence: {
      refsUsed: dedupe(evidence.refsUsed),
      selectorsUsed: dedupe(evidence.selectorsUsed),
      partialMisses: evidence.partialMisses,
    },
    tokensEstimate: 0,
  };
  out.tokensEstimate = estimateTokens(JSON.stringify(out));
  return out;
}

function fail(failure: ExtractFailure): ExtractResult {
  const body = { ok: false as const, failure };
  return { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) };
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** Supported `type` values. The list is closed: JSON-Schema's `integer`,
 *  `null`, `any`, and union types are NOT supported and will be rejected
 *  with a "Did you mean...?" hint when the rejection corresponds to a
 *  known alias (e.g. `integer` → `number`). */
const SUPPORTED_TYPES = ["object", "array", "string", "number", "boolean"] as const;

/** Known `x-browx-source` keys — used for unknown-key diagnostics. The
 *  resolver only reads these; any other key is silently dropped today,
 *  which costs adopters debugging time when (say) `attribute` is used
 *  instead of `attr`. */
const KNOWN_HINT_KEYS = ["query", "selector", "attr", "prop", "text", "value", "collection"] as const;

/** Closest known type for a rejected type — used to power "Did you mean?"
 *  hints in the validator error. Conservative: only suggests when there's
 *  a clear high-confidence alias (e.g. `integer`/`int` → `number`). */
function suggestType(t: unknown): string | null {
  const s = String(t).toLowerCase();
  if (s === "integer" || s === "int" || s === "float" || s === "double" || s === "long") return "number";
  if (s === "bool") return "boolean";
  if (s === "str" || s === "text") return "string";
  if (s === "list" || s === "tuple") return "array";
  if (s === "dict" || s === "map" || s === "record") return "object";
  return null;
}

/** Closest known hint-key for a rejected key — symmetric to `suggestType`.
 *  Powers the unknown-hint-key diagnostic ("did you mean `attr`?"). */
function suggestHintKey(k: string): string | null {
  const s = k.toLowerCase();
  if (s === "attribute") return "attr";
  if (s === "property") return "prop";
  if (s === "css" || s === "cssselector" || s === "css_selector") return "selector";
  if (s === "label" || s === "name" || s === "search") return "query";
  if (s === "container" || s === "items_selector" || s === "rows" || s === "list") return "collection";
  // `transform`, `format`, `regex`, `parser` are NOT supported at all.
  return null;
}

/** Walk the schema tree and (1) coerce `type:"integer"` → `type:"number"`
 *  in place, recording an educational `partialMisses`-bound note per
 *  coercion site, and (2) promote `x-browx-source.selector` to
 *  `x-browx-source.collection` on array schemas that lack `collection`
 *  (the selector key on an array is meaningless today — no leaf-`selector`
 *  semantics applies — so the alias is a no-op-overlap promotion).
 *
 *  Proposal A (v0.2.3): `integer` is now accepted as a schema-dialect
 *  alias for `number`. The leaf coercer already returns JS numbers; a
 *  consumer wanting an enforced integer can `Math.trunc()` themselves.
 *  The educational note preserves the diagnostic trail for adopters
 *  still on the agent-learning curve.
 *
 *  Proposal B (v0.2.3): `selector` on an array is treated as an alias
 *  for `collection`. If both are present, `collection` wins (the
 *  canonical name) — `selector` is dropped from the merged hint so the
 *  resolver doesn't see a stale key. We deliberately do NOT emit a
 *  partialMisses note for this case: the alias is idiomatic and the
 *  resolver already explains `collection` semantics elsewhere, so the
 *  extra noise would dilute the diagnostic surface.
 *
 *  Pure-additive on the call's outcome — the v0.2.2 `collectUnknownHintKeys`
 *  diagnostics still fire (the strict-env opt-in is what changes those
 *  into hard rejections), and validateSchema runs AFTER this pass, so a
 *  schema that was previously rejected for `integer` now resolves. */
export function applySchemaRelaxations(
  schema: ExtractSchema,
  path: string,
  notes: string[],
): void {
  // (A) integer → number — in place.
  if ((schema.type as unknown) === "integer") {
    schema.type = "number";
    notes.push(
      `${path || "<root>"}: schema 'integer' coerced to 'number' for forward-compat; use 'number' explicitly in future schemas`,
    );
  }
  // (B) array `selector` aliased to `collection` — in place.
  if (schema.type === "array") {
    const hint = schema["x-browx-source"];
    if (hint && typeof hint === "object") {
      const h = hint as ExtractSourceHint & Record<string, unknown>;
      if (typeof h.selector === "string" && !h.collection) {
        h.collection = h.selector;
        delete h.selector;
      } else if (typeof h.selector === "string" && h.collection) {
        // Both present — `collection` wins; drop the redundant selector.
        delete h.selector;
      }
    }
  }
  // Recurse — into object properties and array items.
  if (schema.type === "object" && schema.properties) {
    for (const [k, v] of Object.entries(schema.properties)) {
      applySchemaRelaxations(v, path ? `${path}.${k}` : k, notes);
    }
  } else if (schema.type === "array" && schema.items) {
    applySchemaRelaxations(schema.items, `${path}[]`, notes);
  }
}

/** Deep clone the caller-supplied schema before in-place mutation, so we
 *  don't surprise an adopter holding a reference. Uses JSON for the
 *  round-trip — schemas are plain data (no functions, no Dates). */
export function cloneSchema(schema: ExtractSchema): ExtractSchema {
  return JSON.parse(JSON.stringify(schema)) as ExtractSchema;
}

/** Pure-tree validation. Returns a description of the first invariant
 *  violation, or null when the schema is well-formed enough to attempt. */
export function validateSchema(schema: ExtractSchema | undefined, path: string): string | null {
  if (!schema || typeof schema !== "object") return `${path || "<root>"}: schema must be an object`;
  const t = schema.type;
  if (t !== "object" && t !== "array" && t !== "string" && t !== "number" && t !== "boolean") {
    const suggestion = suggestType(t);
    const hint = suggestion ? ` — did you mean "${suggestion}"?` : "";
    return `${path || "<root>"}: unsupported \`type\` ${JSON.stringify(t)} (supported: ${SUPPORTED_TYPES.join(", ")})${hint}`;
  }
  if (t === "object") {
    if (!schema.properties || typeof schema.properties !== "object") {
      return `${path || "<root>"}: object schema requires \`properties\` (a map of property-name → sub-schema)`;
    }
    for (const [k, v] of Object.entries(schema.properties)) {
      const e = validateSchema(v, path ? `${path}.${k}` : k);
      if (e) return e;
    }
  } else if (t === "array") {
    if (!schema.items) return `${path || "<root>"}: array schema requires \`items\` (the per-row sub-schema)`;
    const e = validateSchema(schema.items, `${path}[]`);
    if (e) return e;
  }
  return null;
}

/** Walk the schema tree and emit one diagnostic per unknown
 *  `x-browx-source` key. Pure inspection — does not modify the schema.
 *  Adopters who use, e.g., `attribute` instead of `attr` today see the
 *  schema "succeed" with silently-wrong leaf values (wrightxai trial-1
 *  turn 6: `url` came back as the title text because `attribute:"href"`
 *  was silently dropped). The diagnostic surfaces the typo in
 *  `evidence.partialMisses` so the agent can self-correct on the next
 *  turn without a third "what shape does this take?" probe. */
export function collectUnknownHintKeys(schema: ExtractSchema, path: string, out: string[]): void {
  const hint = schema["x-browx-source"];
  if (hint && typeof hint === "object") {
    for (const k of Object.keys(hint)) {
      if (!(KNOWN_HINT_KEYS as readonly string[]).includes(k)) {
        const suggestion = suggestHintKey(k);
        const hintTxt = suggestion ? `; did you mean \`${suggestion}\`?` : ` (known: ${KNOWN_HINT_KEYS.join(", ")})`;
        out.push(`${path || "<root>"}: unknown \`x-browx-source\` key \`${k}\`${hintTxt}`);
      }
    }
  }
  if (schema.type === "object" && schema.properties) {
    for (const [k, v] of Object.entries(schema.properties)) {
      collectUnknownHintKeys(v, path ? `${path}.${k}` : k, out);
    }
  } else if (schema.type === "array" && schema.items) {
    collectUnknownHintKeys(schema.items, `${path}[]`, out);
  }
}

interface ResolveCtx {
  schema: ExtractSchema;
  path: string;
  page: Page;
  scopeTree: A11yNode;
  scopeLocator?: Locator;
  evidence: ExtractEvidence;
  requiredMisses: string[];
}

/** Pure-ish resolution entry point. Exported for unit testing — `extract()`
 *  composes the snapshot and resolves scope, then delegates here. */
export async function resolveAgainstTree(args: {
  schema: ExtractSchema;
  page: Page;
  scopeTree: A11yNode;
  scopeLocator?: Locator;
}): Promise<{ data: unknown; evidence: ExtractEvidence; requiredMisses: string[] }> {
  const evidence: ExtractEvidence = { refsUsed: [], selectorsUsed: [], partialMisses: [] };
  const requiredMisses: string[] = [];
  // Surface unknown `x-browx-source` keys up-front so the agent sees the
  // typo before deciding whether the silently-wrong leaf value is "good
  // enough". Pure additive diagnostic — does not change `ok` outcome.
  collectUnknownHintKeys(args.schema, "", evidence.partialMisses);
  const data = await resolveSchema({
    schema: args.schema,
    path: "",
    page: args.page,
    scopeTree: args.scopeTree,
    scopeLocator: args.scopeLocator,
    evidence,
    requiredMisses,
  });
  return { data, evidence, requiredMisses };
}

async function resolveSchema(ctx: ResolveCtx): Promise<unknown> {
  const { schema } = ctx;
  switch (schema.type) {
    case "object":
      return resolveObject(ctx);
    case "array":
      return resolveArray(ctx);
    case "string":
    case "number":
    case "boolean":
      return resolveLeaf(ctx);
  }
}

async function resolveObject(ctx: ResolveCtx): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const props = ctx.schema.properties ?? {};
  for (const [name, subSchema] of Object.entries(props)) {
    const subPath = ctx.path ? `${ctx.path}.${name}` : name;
    // implicit query = the property name; merged with explicit hint if any.
    const childSchema: ExtractSchema = { ...subSchema };
    if (!childSchema["x-browx-source"]?.query &&
        !childSchema["x-browx-source"]?.selector &&
        !childSchema["x-browx-source"]?.collection) {
      const hint = { ...(childSchema["x-browx-source"] ?? {}), query: name };
      childSchema["x-browx-source"] = hint;
    }
    const value = await resolveSchema({
      ...ctx,
      schema: childSchema,
      path: subPath,
    });
    if (value !== MISS) {
      out[name] = value;
    } else if (subSchema.default !== undefined) {
      out[name] = subSchema.default;
    }
  }
  return out;
}

const MISS = Symbol.for("browxai.extract.miss");

async function resolveArray(ctx: ResolveCtx): Promise<unknown[]> {
  const hint = ctx.schema["x-browx-source"];
  if (!hint?.collection) {
    ctx.evidence.partialMisses.push(
      `${ctx.path}: array needs \`x-browx-source.collection\` ` +
        `(a CSS selector or NL query for the row container; ` +
        `each match becomes a per-row scope for \`items\`)`,
    );
    if (ctx.schema.required) ctx.requiredMisses.push(ctx.path);
    return [];
  }
  const items = ctx.schema.items!;
  // Try CSS selector first; if it doesn't match, fall back to a tree-scan
  // by query (find()-style ranking restricted to repeated containers).
  const collectionLocators = await resolveCollection(
    ctx.page,
    ctx.scopeLocator,
    ctx.scopeTree,
    hint.collection,
  );
  ctx.evidence.selectorsUsed.push(hint.collection);
  if (collectionLocators.length === 0) {
    ctx.evidence.partialMisses.push(`${ctx.path}: collection "${hint.collection}" matched 0 elements`);
    if (ctx.schema.required) ctx.requiredMisses.push(ctx.path);
    return [];
  }
  const out: unknown[] = [];
  for (let i = 0; i < collectionLocators.length; i++) {
    const entry = collectionLocators[i]!;
    const itemValue = await resolveSchema({
      ...ctx,
      schema: items,
      path: `${ctx.path}[${i}]`,
      scopeTree: entry.subTree ?? ctx.scopeTree,
      scopeLocator: entry.loc,
    });
    if (itemValue !== MISS) out.push(itemValue);
  }
  return out;
}

interface CollectionEntry { loc?: Locator; subTree?: A11yNode; }

async function resolveCollection(
  page: Page,
  scope: Locator | undefined,
  scopeTree: A11yNode,
  collection: string,
): Promise<CollectionEntry[]> {
  // Try as a CSS selector first.
  const root = scope ?? page;
  try {
    const loc = root.locator(collection);
    const count = await loc.count();
    if (count > 0) {
      const out: CollectionEntry[] = [];
      for (let i = 0; i < count; i++) out.push({ loc: loc.nth(i) });
      return out;
    }
  } catch {
    /* fall through to tree-scan */
  }
  // Fallback: tree-scan for nodes matching the query (containers in repeated
  // structures pick up `context.collection`). No backing Locator — the
  // sub-schema resolves over the subtree alone. Adopters needing
  // attr/prop reads inside a list should use the CSS-selector form.
  const matches = scanTreeForCollection(scopeTree, collection);
  return matches.map((node) => ({ subTree: node }));
}

function scanTreeForCollection(tree: A11yNode, query: string): A11yNode[] {
  const lower = query.toLowerCase();
  const out: A11yNode[] = [];
  for (const { node } of walk(tree)) {
    const hay = `${node.role}|${node.name ?? ""}|${node.testId ?? ""}`.toLowerCase();
    if (hay.includes(lower)) out.push(node);
  }
  return out;
}

async function resolveLeaf(ctx: ResolveCtx): Promise<unknown> {
  const hint = ctx.schema["x-browx-source"] ?? {};
  // 1. selector path: resolve a Locator directly within scope.
  if (hint.selector) {
    ctx.evidence.selectorsUsed.push(hint.selector);
    const root = ctx.scopeLocator ?? ctx.page;
    let loc: Locator;
    try {
      loc = root.locator(hint.selector).first();
    } catch {
      return missLeaf(ctx);
    }
    return readLeafFromLocator(ctx, loc, hint);
  }
  // 2. query path: tree-scan within scopeTree.
  const query = hint.query ?? "";
  if (!query) return missLeaf(ctx);
  ctx.evidence.selectorsUsed.push(query);
  const node = scanTreeForBestMatch(ctx.scopeTree, query);
  if (!node) return missLeaf(ctx);
  ctx.evidence.refsUsed.push(node.ref);
  // Without a Locator we can only read the a11y-derived text/value. The
  // overwhelming majority of deterministic extract use-cases land here —
  // it's why the tree-walk is the primary path.
  return readLeafFromNode(ctx, node, hint);
}

function missLeaf(ctx: ResolveCtx): unknown {
  ctx.evidence.partialMisses.push(ctx.path);
  if (ctx.schema.required) ctx.requiredMisses.push(ctx.path);
  return MISS;
}

/** Pick the best node in the tree for a `query` — exact-name wins, else
 *  testId-equals, else substring on name/testId. */
export function scanTreeForBestMatch(tree: A11yNode, query: string): A11yNode | undefined {
  const q = query.toLowerCase();
  let best: { node: A11yNode; score: number } | undefined;
  for (const { node } of walk(tree)) {
    const name = (node.name ?? "").toLowerCase();
    const tid = (node.testId ?? "").toLowerCase();
    const role = node.role.toLowerCase();
    let s = 0;
    if (name === q || tid === q) s += 100;
    if (tid && tid.includes(q)) s += 30;
    if (name && name.includes(q)) s += 20;
    if (role === q) s += 5;
    // token-by-token substring on testId and name.
    for (const t of q.split(/\s+/).filter((x) => x.length >= 2)) {
      if (tid.includes(t)) s += 5;
      if (name.includes(t)) s += 3;
    }
    if (s > 0 && (!best || s > best.score)) best = { node, score: s };
  }
  return best?.node;
}

async function readLeafFromLocator(
  ctx: ResolveCtx,
  loc: Locator,
  hint: ExtractSourceHint,
): Promise<unknown> {
  try {
    const count = await loc.count();
    if (count === 0) return missLeaf(ctx);
    if (hint.attr) {
      const v = await loc.getAttribute(hint.attr);
      if (v === null) return missLeaf(ctx);
      return coerceLeaf(v, ctx.schema.type);
    }
    if (hint.prop || hint.value) {
      const propName = hint.prop ?? "value";
      const v = await loc.evaluate((el, p) => (el as unknown as Record<string, unknown>)[p], propName);
      if (v === undefined || v === null) return missLeaf(ctx);
      return coerceLeaf(v, ctx.schema.type);
    }
    // Default: visible text.
    const text = (await loc.innerText().catch(() => "")).trim();
    if (!text) return missLeaf(ctx);
    return coerceLeaf(text, ctx.schema.type);
  } catch {
    return missLeaf(ctx);
  }
}

function readLeafFromNode(
  ctx: ResolveCtx,
  node: A11yNode,
  hint: ExtractSourceHint,
): unknown {
  // No live Locator; the tree-only path covers what the snapshot carries.
  if (hint.attr || hint.prop) {
    // Annotation needs a page; record the miss so the caller knows the
    // tree-walk couldn't satisfy it. (The locator path would have, given
    // an explicit selector.)
    return missLeaf(ctx);
  }
  // value-bearing nodes carry CDP-side `value` on the a11y node.
  if (hint.value && node.value !== undefined) {
    return coerceLeaf(node.value, ctx.schema.type);
  }
  const txt = (node.name ?? node.value ?? node.text ?? "").toString().trim();
  if (!txt) return missLeaf(ctx);
  return coerceLeaf(txt, ctx.schema.type);
}

export function coerceLeaf(raw: unknown, type: ExtractSchema["type"]): unknown {
  switch (type) {
    case "string":
      return typeof raw === "string" ? raw : String(raw);
    case "number": {
      if (typeof raw === "number") return raw;
      const s = String(raw).replace(/[^0-9.\-eE]/g, "");
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === 1 || raw === "1" || raw === "yes" || raw === "on") return true;
      if (raw === "false" || raw === 0 || raw === "0" || raw === "no" || raw === "off") return false;
      return Boolean(raw);
    case "object":
    case "array":
      return raw;
  }
}

/** Best-effort Locator for a ref — mirrors the lighter case in locator.ts
 *  without hard-coupling here; we don't need full provenance routing for
 *  extraction (the tree-walk does most of the work). */
function locatorForRef(page: Page, refs: RefRegistry, ref: string): Locator | undefined {
  const inputs = refs.locatorOf(ref);
  if (!inputs) return undefined;
  if (inputs.testId) {
    const attr = inputs.testIdAttr ?? "data-testid";
    return page.locator(`[${attr}=${JSON.stringify(inputs.testId)}]`).first();
  }
  if (inputs.cssPath) return page.locator(inputs.cssPath).first();
  if (inputs.name) return page.getByRole(inputs.role as Parameters<Page["getByRole"]>[0], { name: inputs.name }).first();
  return page.getByRole(inputs.role as Parameters<Page["getByRole"]>[0]).first();
}
