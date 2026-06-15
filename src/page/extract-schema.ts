// Extract schema helpers — validation, dialect relaxations, unknown-key
// diagnostics, and the small result/dedup utilities. Pure functions over the
// schema tree; shared by the `extract` orchestrator and the resolution engine.
// Split out of extract.ts to keep it (and extract-resolve.ts) under the size
// budget, and to break the orchestrator↔resolver import cycle. Re-exported
// through `./extract.js` so callers + tests import unchanged.

import { estimateTokens } from "../util/tokens.js";
import type {
  ExtractSchema,
  ExtractSourceHint,
  ExtractFailure,
  ExtractResult,
} from "./extract-types.js";

export function fail(failure: ExtractFailure): ExtractResult {
  const body = { ok: false as const, failure };
  return { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) };
}

export function dedupe<T>(arr: T[]): T[] {
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
const KNOWN_HINT_KEYS = [
  "query",
  "selector",
  "attr",
  "prop",
  "text",
  "value",
  "collection",
] as const;

/** Closest known type for a rejected type — used to power "Did you mean?"
 *  hints in the validator error. Conservative: only suggests when there's
 *  a clear high-confidence alias (e.g. `integer`/`int` → `number`). */
function suggestType(t: unknown): string | null {
  const s = String(t).toLowerCase();
  if (s === "integer" || s === "int" || s === "float" || s === "double" || s === "long")
    return "number";
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
  if (s === "container" || s === "items_selector" || s === "rows" || s === "list")
    return "collection";
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
/** (B) On an array schema, alias `x-browx-source.selector` to `collection`
 *  (the canonical key) — `collection` wins if both are present; the redundant
 *  `selector` is dropped so the resolver never sees a stale key. */
function aliasArraySelectorToCollection(schema: ExtractSchema): void {
  const hint = schema["x-browx-source"];
  if (!hint || typeof hint !== "object") return;
  const h = hint as ExtractSourceHint & Record<string, unknown>;
  if (typeof h.selector !== "string") return;
  if (!h.collection) h.collection = h.selector;
  delete h.selector;
}

export function applySchemaRelaxations(schema: ExtractSchema, path: string, notes: string[]): void {
  // (A) integer → number — in place.
  if ((schema.type as unknown) === "integer") {
    schema.type = "number";
    notes.push(
      `${path || "<root>"}: schema 'integer' coerced to 'number' for forward-compat; use 'number' explicitly in future schemas`,
    );
  }
  // (B) array `selector` aliased to `collection` — in place.
  if (schema.type === "array") aliasArraySelectorToCollection(schema);
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
export function cloneSchema(schema: unknown): ExtractSchema {
  return JSON.parse(JSON.stringify(schema)) as ExtractSchema;
}

const VALID_TYPES = new Set(["object", "array", "string", "number", "boolean"]);

/** Validate the `type` field is one of the supported set, with a "did you mean?"
 *  hint for known aliases. Returns the violation message or null. */
function validateType(t: unknown, path: string): string | null {
  if (VALID_TYPES.has(t as string)) return null;
  const suggestion = suggestType(t);
  const hint = suggestion ? ` — did you mean "${suggestion}"?` : "";
  return `${path || "<root>"}: unsupported \`type\` ${JSON.stringify(t)} (supported: ${SUPPORTED_TYPES.join(", ")})${hint}`;
}

/** Validate an object schema's `properties` map and recurse into each. */
function validateObjectChildren(schema: ExtractSchema, path: string): string | null {
  if (!schema.properties || typeof schema.properties !== "object") {
    return `${path || "<root>"}: object schema requires \`properties\` (a map of property-name → sub-schema)`;
  }
  for (const [k, v] of Object.entries(schema.properties)) {
    const e = validateSchema(v, path ? `${path}.${k}` : k);
    if (e) return e;
  }
  return null;
}

/** Pure-tree validation. Returns a description of the first invariant
 *  violation, or null when the schema is well-formed enough to attempt. */
export function validateSchema(schema: ExtractSchema | undefined, path: string): string | null {
  if (!schema || typeof schema !== "object") return `${path || "<root>"}: schema must be an object`;
  const typeError = validateType(schema.type, path);
  if (typeError) return typeError;
  if (schema.type === "object") return validateObjectChildren(schema, path);
  if (schema.type === "array") {
    if (!schema.items) {
      return `${path || "<root>"}: array schema requires \`items\` (the per-row sub-schema)`;
    }
    return validateSchema(schema.items, `${path}[]`);
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
        const hintTxt = suggestion
          ? `; did you mean \`${suggestion}\`?`
          : ` (known: ${KNOWN_HINT_KEYS.join(", ")})`;
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
