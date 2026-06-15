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

import type { Locator, Page } from "playwright-core";
import { type A11yNode } from "./a11y.js";
import type { RefRegistry } from "./refs.js";
import type { SnapshotSubstrate } from "./snapshot-substrate.js";
import { findByRef } from "./snapshot.js";
import { estimateTokens } from "../util/tokens.js";
import type {
  ExtractResult,
  ExtractOptions,
  ExtractSchema,
  ExtractFailure,
} from "./extract-types.js";
import { warnLlmAssistedRetired } from "./extract-warnings.js";
import { resolveAgainstTree, locatorForRef } from "./extract-resolve.js";
import {
  fail,
  dedupe,
  cloneSchema,
  applySchemaRelaxations,
  validateSchema,
  collectUnknownHintKeys,
} from "./extract-schema.js";

// Re-export the type vocabulary, the deprecation-warning reset hooks, the
// resolution-engine entry points, and the schema helpers through this barrel so
// callers + tests import from `./extract.js` unchanged after the split.
export type {
  ExtractSchema,
  ExtractSourceHint,
  ExtractEvidence,
  ExtractFailure,
  ExtractResult,
  ExtractOptions,
  ExtractMode,
} from "./extract-types.js";
export {
  __resetLlmAssistedWarnedForTests,
  __resetExplicitNlQueryWarnedForTests,
} from "./extract-warnings.js";
export { resolveAgainstTree, scanTreeForBestMatch, coerceLeaf } from "./extract-resolve.js";
export {
  applySchemaRelaxations,
  cloneSchema,
  validateSchema,
  collectUnknownHintKeys,
} from "./extract-schema.js";

/** Entry point — runs the composed snapshot, scopes it, walks the schema. */
/** Either a resolved value of `T`, or a structured failure to return verbatim. */
type Prepared<T> = { ok: true; value: T } | { ok: false; failure: ExtractResult };

/** Clone + relax the schema, then validate it (and, under strict mode, reject
 *  unknown `x-browx-source` keys). Returns the relaxed schema + the educational
 *  relaxation notes, or a structured `invalid-schema` failure. */
function prepareSchema(
  opts: ExtractOptions,
): Prepared<{ schema: ExtractSchema; relaxationNotes: string[] }> {
  // Clone first so we never mutate the caller-supplied object; relaxation notes
  // ride through to evidence.partialMisses on the successful path.
  const schema = cloneSchema(opts.schema);
  const relaxationNotes: string[] = [];
  applySchemaRelaxations(schema, "", relaxationNotes);

  const schemaError = validateSchema(schema, "");
  if (schemaError) {
    return failPrepared(
      "invalid-schema",
      "a JSON schema whose root is object or array",
      schemaError,
    );
  }
  // Strict mode: promote unknown-`x-browx-source`-key diagnostics from soft
  // `partialMisses` notes to a hard `invalid-schema` rejection. Default off;
  // opt-in via env or call-arg.
  const strict = opts.strictUnknownHintKeys ?? process.env.BROWX_EXTRACT_STRICT === "1";
  if (strict) {
    const unknown: string[] = [];
    collectUnknownHintKeys(schema, "", unknown);
    if (unknown.length > 0) {
      return failPrepared(
        "invalid-schema",
        "every `x-browx-source` key to be one of the known set (BROWX_EXTRACT_STRICT=1 is on)",
        unknown.join(" | "),
      );
    }
  }
  return { ok: true, value: { schema, relaxationNotes } };
}

function failPrepared<T>(
  kind: ExtractFailure["kind"],
  expected: string,
  actual: unknown,
): Prepared<T> {
  return { ok: false, failure: fail({ source: "browxai", kind, expected, actual }) };
}

/** Compose the snapshot and resolve the requested scope (whole tree, a ref
 *  subtree, or a CSS-selector scope), validating the empty-scope invariant. */
async function resolveScope(
  page: Page,
  substrate: SnapshotSubstrate,
  refs: RefRegistry,
  opts: ExtractOptions,
): Promise<Prepared<{ scopeTree: A11yNode; scopeLocator?: Locator }>> {
  if (opts.ref && opts.scope) {
    return failPrepared("invalid-schema", "exactly one of `ref` or `scope`", "both provided");
  }
  const tree = (await substrate.compose(refs, opts.testAttributes)).tree;
  if (!tree) {
    return {
      ok: false,
      failure: fail({
        source: "app",
        kind: "scope-not-found",
        expected: "a non-empty accessibility tree",
        actual: "empty",
      }),
    };
  }
  if (opts.ref) {
    const sub = findByRef(tree, opts.ref);
    if (!sub) {
      return failPrepared(
        "scope-not-found",
        `ref "${opts.ref}" to resolve in the current snapshot`,
        "no matching ref",
      );
    }
    return {
      ok: true,
      value: { scopeTree: sub, scopeLocator: locatorForRef(page, refs, opts.ref) },
    };
  }
  if (opts.scope) {
    const scopeLocator = page.locator(opts.scope).first();
    const count = await page
      .locator(opts.scope)
      .count()
      .catch(() => 0);
    if (count === 0) {
      return failPrepared(
        "scope-not-found",
        `scope selector "${opts.scope}" to match ≥1 element`,
        "0 matches",
      );
    }
    return { ok: true, value: { scopeTree: tree, scopeLocator } };
  }
  return { ok: true, value: { scopeTree: tree } };
}

export async function extract(
  page: Page,
  substrate: SnapshotSubstrate,
  refs: RefRegistry,
  opts: ExtractOptions,
): Promise<ExtractResult> {
  // The `mode` arg is RETIRED as of v0.3.2 — deterministic is the only supported
  // path. Tolerate `mode:"llm-assisted"` at runtime (graceful deprecation): emit
  // a one-shot console.warn and fall through to deterministic.
  if (opts.mode === "llm-assisted") warnLlmAssistedRetired();

  const prepared = prepareSchema(opts);
  if (!prepared.ok) return prepared.failure;
  const { schema: relaxedSchema, relaxationNotes } = prepared.value;

  const scoped = await resolveScope(page, substrate, refs, opts);
  if (!scoped.ok) return scoped.failure;
  const { scopeTree, scopeLocator } = scoped.value;

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
