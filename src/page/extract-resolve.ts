// Deterministic extraction resolution engine — resolves an `ExtractSchema`
// against a captured a11y subtree (+ optional backing Locators). Split out of
// extract.ts to keep that file under the size budget; behavior-identical, and
// the public entry points are re-exported through `./extract.js`.

import type { Locator, Page } from "playwright-core";
import { walk, type A11yNode } from "./a11y.js";
import type { RefRegistry } from "./refs.js";
import type {
  ExtractSchema,
  ExtractEvidence,
  ExtractSourceHint,
  HintWithMarker,
} from "./extract-types.js";
import { IMPLICIT_QUERY } from "./extract-types.js";
import { warnExplicitNlQueryRetired } from "./extract-warnings.js";
import { collectUnknownHintKeys } from "./extract-schema.js";

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
    if (
      !childSchema["x-browx-source"]?.query &&
      !childSchema["x-browx-source"]?.selector &&
      !childSchema["x-browx-source"]?.collection
    ) {
      const hint: HintWithMarker = { ...(childSchema["x-browx-source"] ?? {}), query: name };
      // Mark the implicit-lowering case so resolveLeaf knows this query
      // came from the property name (not a user-authored prose query) and
      // skips the RETIRED-query warning. The marker is a module-private
      // Symbol — won't leak into serialised schemas.
      hint[IMPLICIT_QUERY] = true;
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
    ctx.evidence.partialMisses.push(
      `${ctx.path}: collection "${hint.collection}" matched 0 elements`,
    );
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

interface CollectionEntry {
  loc?: Locator;
  subTree?: A11yNode;
}

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

/** Shared a11y-tree search combinator (RFC 0004 P3 / D4). Folds `visit` over
 *  every node `walk` yields, threading an accumulator — the one traversal both
 *  `scanTreeForCollection` (accumulate all matches) and `scanTreeForBestMatch`
 *  (score and keep the best) drive, instead of two hand-rolled `for … of walk`
 *  loops. `walk` is already the shared depth-first generator; this names the fold
 *  on top of it so a third tree query reuses the same shape. */
function treeSearch<TAcc>(
  tree: A11yNode,
  initial: TAcc,
  visit: (acc: TAcc, node: A11yNode) => TAcc,
): TAcc {
  let acc = initial;
  for (const { node } of walk(tree)) acc = visit(acc, node);
  return acc;
}

function scanTreeForCollection(tree: A11yNode, query: string): A11yNode[] {
  const lower = query.toLowerCase();
  return treeSearch<A11yNode[]>(tree, [], (out, node) => {
    const hay = `${node.role}|${node.name ?? ""}|${node.testId ?? ""}`.toLowerCase();
    if (hay.includes(lower)) out.push(node);
    return out;
  });
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
  // Collection-item leaf with no selector/query (e.g. `{text:true}` / `{attr}`):
  // read directly from the per-item Locator that `resolveCollection` scoped onto
  // this item, instead of treating "no selector" as a definitive miss. Without
  // this, an array whose items are `{type:string, x-browx-source:{text:true}}`
  // resolves every element to a partialMiss even though the collection matched.
  if (!query && ctx.scopeLocator) {
    return readLeafFromLocator(ctx, ctx.scopeLocator, hint);
  }
  if (!query) return missLeaf(ctx);
  // R-5 (v0.3.3): explicit per-field `query` is RETIRED. The implicit
  // name-as-query lowering still flows through here (marked via
  // IMPLICIT_QUERY) and works fine on testid-rich pages; the prose-style
  // explicit query path is the unreliable one we're deprecating. Emit a
  // one-shot warn + a per-call partialMisses entry that names the field,
  // so the caller / authoring LLM gets a concrete signal — then fall
  // through to the existing tree-scan resolution (graceful deprecation,
  // never hard-break adopters).
  const isImplicit = (hint as HintWithMarker)[IMPLICIT_QUERY] === true;
  if (!isImplicit) {
    warnExplicitNlQueryRetired();
    ctx.evidence.partialMisses.push(
      `${ctx.path}: \`x-browx-source.query\` is RETIRED (v0.3.3) — ` +
        "the NL tree-scan ranker is unreliable for explicit per-field " +
        "queries. Use `x-browx-source.selector` (raw CSS) instead.",
    );
  }
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
/** Relevance score of one node for a lowercased query — exact name/testId wins,
 *  then testId/name substring, role-equals, then per-token substring. */
function scoreMatch(node: A11yNode, q: string): number {
  const name = (node.name ?? "").toLowerCase();
  const tid = (node.testId ?? "").toLowerCase();
  const role = node.role.toLowerCase();
  let s = 0;
  if (name === q || tid === q) s += 100;
  if (tid && tid.includes(q)) s += 30;
  if (name && name.includes(q)) s += 20;
  if (role === q) s += 5;
  for (const t of q.split(/\s+/).filter((x) => x.length >= 2)) {
    if (tid.includes(t)) s += 5;
    if (name.includes(t)) s += 3;
  }
  return s;
}

export function scanTreeForBestMatch(tree: A11yNode, query: string): A11yNode | undefined {
  const q = query.toLowerCase();
  const best = treeSearch<{ node: A11yNode; score: number } | undefined>(
    tree,
    undefined,
    (acc, node) => {
      const s = scoreMatch(node, q);
      if (s > 0 && (!acc || s > acc.score)) return { node, score: s };
      return acc;
    },
  );
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
      const v = await loc.evaluate(
        (el, p) => (el as unknown as Record<string, unknown>)[p],
        propName,
      );
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

function readLeafFromNode(ctx: ResolveCtx, node: A11yNode, hint: ExtractSourceHint): unknown {
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

const TRUTHY_TOKENS = new Set<unknown>(["true", 1, "1", "yes", "on"]);
const FALSY_TOKENS = new Set<unknown>(["false", 0, "0", "no", "off"]);

function coerceNumber(raw: unknown): number | null {
  if (typeof raw === "number") return raw;
  const n = Number(String(raw).replace(/[^0-9.\-eE]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function coerceBoolean(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (TRUTHY_TOKENS.has(raw)) return true;
  if (FALSY_TOKENS.has(raw)) return false;
  return Boolean(raw);
}

export function coerceLeaf(raw: unknown, type: ExtractSchema["type"]): unknown {
  switch (type) {
    case "string":
      return typeof raw === "string" ? raw : String(raw);
    case "number":
      return coerceNumber(raw);
    case "boolean":
      return coerceBoolean(raw);
    case "object":
    case "array":
      return raw;
  }
}

/** Best-effort Locator for a ref — mirrors the lighter case in locator.ts
 *  without hard-coupling here; we don't need full provenance routing for
 *  extraction (the tree-walk does most of the work). */
export function locatorForRef(page: Page, refs: RefRegistry, ref: string): Locator | undefined {
  const inputs = refs.locatorOf(ref);
  if (!inputs) return undefined;
  if (inputs.testId) {
    const attr = inputs.testIdAttr ?? "data-testid";
    return page.locator(`[${attr}=${JSON.stringify(inputs.testId)}]`).first();
  }
  if (inputs.cssPath) return page.locator(inputs.cssPath).first();
  if (inputs.name)
    return page
      .getByRole(inputs.role as Parameters<Page["getByRole"]>[0], { name: inputs.name })
      .first();
  return page.getByRole(inputs.role as Parameters<Page["getByRole"]>[0]).first();
}
