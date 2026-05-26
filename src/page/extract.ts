// Structured schema-driven extract primitive.
//
// The schema-as-contract primitive every browxai
// adopter currently rebuilds the same "parse this table into rows" loop on
// top of `snapshot()`. Stagehand `extract`, Skyvern, browser-use all ship
// this. browxai's version is **deterministic by default** (selector-only —
// schema fields lower to `find()` / selector queries scoped to a subtree),
// with an optional `mode: "llm-assisted"` callback seam reserved for v0.2.x.
//
// Default mode: `"deterministic"`. The model-agnostic principle — substrate
// doesn't tie itself to a reasoning loop. LLM-assisted is opt-in.
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

/** Mode toggle. Deterministic is the required-ship default; llm-assisted is a
 *  typed-but-unimplemented seam reserved for a v0.2.x follow-up. */
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
  /** Default `"deterministic"`. `"llm-assisted"` is a typed seam — not
   *  implemented in v0.2.0; returns a structured `{ok:false, failure}`
   *  with `kind:"llm-assisted-not-implemented"`. */
  mode?: ExtractMode;
  testAttributes: string[];
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
   *  schema, llm-assisted not implemented). */
  source: "app" | "browxai";
  /** Stable kind label. */
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
  const mode: ExtractMode = opts.mode ?? "deterministic";
  if (mode === "llm-assisted") {
    return fail({
      source: "browxai",
      kind: "llm-assisted-not-implemented",
      expected: "deterministic mode (the v0.2.0 default)",
      actual: 'mode:"llm-assisted"',
      evidence: {
        note:
          "the llm-assisted callback hook is a typed seam reserved for a " +
          "v0.2.x follow-up; the deterministic mode is the supported path " +
          "today. Drop the `mode` arg or set mode:\"deterministic\".",
      },
    });
  }
  const schemaError = validateSchema(opts.schema, "");
  if (schemaError) {
    return fail({
      source: "browxai",
      kind: "invalid-schema",
      expected: "a JSON schema whose root is object or array",
      actual: schemaError,
    });
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
    schema: opts.schema,
    page,
    scopeTree,
    scopeLocator,
  });

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

/** Pure-tree validation. Returns a description of the first invariant
 *  violation, or null when the schema is well-formed enough to attempt. */
export function validateSchema(schema: ExtractSchema | undefined, path: string): string | null {
  if (!schema || typeof schema !== "object") return `${path || "<root>"}: schema must be an object`;
  const t = schema.type;
  if (t !== "object" && t !== "array" && t !== "string" && t !== "number" && t !== "boolean") {
    return `${path || "<root>"}: unsupported \`type\` ${JSON.stringify(t)} (use one of object/array/string/number/boolean)`;
  }
  if (t === "object") {
    if (!schema.properties || typeof schema.properties !== "object") {
      return `${path || "<root>"}: object schema requires \`properties\``;
    }
    for (const [k, v] of Object.entries(schema.properties)) {
      const e = validateSchema(v, path ? `${path}.${k}` : k);
      if (e) return e;
    }
  } else if (t === "array") {
    if (!schema.items) return `${path || "<root>"}: array schema requires \`items\``;
    const e = validateSchema(schema.items, `${path}[]`);
    if (e) return e;
  }
  return null;
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
    ctx.evidence.partialMisses.push(`${ctx.path}: array needs \`x-browx-source.collection\``);
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
