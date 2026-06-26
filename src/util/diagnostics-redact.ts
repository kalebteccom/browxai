// Diagnostics — pure redaction, shared record types, and eval/result
// taxonomy helpers.
//
// . Leaf module: NO recorder / IO / retention dependency. Holds the
// diagnostics record types (shared by the recorder, the redaction path, and
// the read-side report) plus the pure, side-effect-free helpers that classify
// args, eval expressions, and tool results. Both `diagnostics.ts` (recorder +
// IO) and `diagnostics-report.ts` (read-side aggregation) import FROM here;
// neither is imported back, so there is no cycle.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Categories a `diagnostics_note` insight can carry. Default `other`. */
export type NoteCategory =
  | "missing-primitive"
  | "workaround"
  | "perf-concern"
  | "ergonomic-friction"
  | "other";

/** Severity a `diagnostics_note` can carry. Default `info`. */
export type NoteSeverity = "info" | "warn" | "blocker";

/** Eval-expression taxonomy buckets — heuristic substring-match classifier. */
export type EvalTaxonomy =
  | "dom-query"
  | "storage-access"
  | "computed-style"
  | "callback-trigger"
  | "feature-detect"
  | "custom";

/** Structural redaction of a tool call's args. Keeps key names + types +
 *  sizes; drops raw values for known large / sensitive payload fields. */
export type RedactedArgs = Record<string, unknown>;

export interface CallRecord {
  kind: "call";
  ts: string;
  tool: string;
  sessionId: string;
  argsRedacted: RedactedArgs;
  resultMeta: {
    ok: boolean;
    sizeBytes: number;
    warningsCount: number;
    failureKind?: string;
  };
  durationMs: number;
  capabilityDenials: number;
  agentId?: string;
  evalJs?: {
    exprSha: string;
    exprHead: string;
    returnType: string;
    returnSizeBytes: number;
    taxonomy: EvalTaxonomy;
  };
}

export interface NoteRecord {
  kind: "note";
  ts: string;
  sessionId: string;
  insight: string;
  category: NoteCategory;
  severity: NoteSeverity;
  ref?: string;
  agentId?: string;
}

export type DiagnosticsRecord = CallRecord | NoteRecord;

// ---------------------------------------------------------------------------
// Args-redaction
// ---------------------------------------------------------------------------

/** Field names whose payload is opportunistically rewritten to sha256 +
 *  byteLength when the string is large (above the inline threshold). Small
 *  strings — a `fill({value:"hi"})` or a typed `<NAME>` alias — pass through
 *  the standard string-truncation path so the JSONL stays human-debuggable
 *  for the common short-value case. The threshold mirrors the structural
 *  intent: redact for content blobs (caches_put body, idb_put value,
 *  eval_js expr fragments), not for typed UI strings. */
const BIG_BLOB_FIELDS = new Set([
  "body",
  "contentBase64",
  "value",
  "expr",
  "expression",
  "data",
  "contents",
  "html",
  "source",
]);
/** Threshold (bytes) above which a `BIG_BLOB_FIELDS` field is rewritten to
 *  sha256 + byteLength. Below this, the standard truncation path applies. */
const BIG_BLOB_REDACT_BYTES = 512;

/** Structural redaction — keep keys + types + sizes, drop raw values for
 *  known large / sensitive fields. Bounded depth. The output is small,
 *  diff-friendly, and never includes a registered secret value (the
 *  recorder applies the secrets mask on top of this before writing). */
export function redactArgs(args: unknown, depth = 0): RedactedArgs {
  if (depth > 6) return { __truncated: true };
  if (args == null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    return { __scalar: typeof args, __value: args };
  }
  const out: RedactedArgs = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (BIG_BLOB_FIELDS.has(k) && typeof v === "string") {
      const byteLen = Buffer.byteLength(v, "utf8");
      // Only redact when the payload is genuinely large — small strings
      // (typed `<NAME>` aliases, single-line CSS values, short URLs) stay
      // readable so the JSONL keeps its diff-friendly debuggability.
      if (byteLen >= BIG_BLOB_REDACT_BYTES) {
        out[k] = {
          __redacted: true,
          sha256: createHash("sha256").update(v, "utf8").digest("hex"),
          byteLength: byteLen,
        };
        continue;
      }
    }
    if (typeof v === "string") {
      out[k] = v.length > 256 ? `${v.slice(0, 256)}…[+${v.length - 256}]` : v;
      continue;
    }
    if (typeof v === "number" || typeof v === "boolean" || v === null) {
      out[k] = v;
      continue;
    }
    if (Array.isArray(v)) {
      out[k] = { __array: true, length: v.length };
      continue;
    }
    if (typeof v === "object") {
      out[k] = redactArgs(v, depth + 1);
      continue;
    }
    out[k] = { __type: typeof v };
  }
  return out;
}

// ---------------------------------------------------------------------------
// eval_js taxonomy classifier
// ---------------------------------------------------------------------------

/** Heuristic substring classifier over the first 80 chars of an `eval_js`
 *  expression. Drives the "what curated primitive is missing?" inference
 *  downstream (high-count non-custom buckets → propose a primitive). */
export function classifyEvalExpr(exprHead: string): EvalTaxonomy {
  const s = exprHead;
  // dom-query — querySelector / getElementBy* / closest / matches
  if (/document\.querySelector|querySelectorAll|getElementBy|\.closest\(|\.matches\(/.test(s)) {
    return "dom-query";
  }
  // storage-access — localStorage / sessionStorage / indexedDB / caches / cookies
  if (/localStorage|sessionStorage|indexedDB|\bcaches\b|document\.cookie|\bcookies\b/.test(s)) {
    return "storage-access";
  }
  // computed-style + layout-box measures
  if (
    /getComputedStyle|getBoundingClientRect|offsetWidth|offsetHeight|clientWidth|clientHeight|scrollWidth|scrollHeight/.test(
      s,
    )
  ) {
    return "computed-style";
  }
  // callback-trigger — .click() / .focus() / .blur() / .dispatchEvent( / .submit()
  if (/\.click\(\)|\.focus\(\)|\.blur\(\)|\.dispatchEvent\(|\.submit\(\)/.test(s)) {
    return "callback-trigger";
  }
  // feature-detect — typeof window./navigator. / 'X' in window/navigator
  if (
    /typeof\s+window\.|typeof\s+navigator\.|['"][^'"]+['"]\s+in\s+(window|navigator)|window\.[A-Za-z_]+\s*!==\s*undefined/.test(
      s,
    )
  ) {
    return "feature-detect";
  }
  return "custom";
}

// ---------------------------------------------------------------------------
// Result classification — drives the resultMeta + failureKind fields.
// ---------------------------------------------------------------------------

export function failureKindOf(parsed: { ok: false; [k: string]: unknown }): string {
  if (Object.prototype.hasOwnProperty.call(parsed, "requiredCapability"))
    return "capability-denied";
  const err = typeof parsed.error === "string" ? parsed.error : "";
  if (/anti-wedge timeout/i.test(err)) return "timeout";
  if (/not found|no element matches|ref not found|locator did not resolve/i.test(err))
    return "target-not-found";
  if (/must |invalid |unknown |expected /i.test(err)) return "bad-arg";
  return "internal";
}

/** Build the `resultMeta` field for a recorded tool call. `firstJsonObj` is
 *  the parsed first text item (when applicable); `sizeBytes` is the
 *  JSON-string length of the entire content envelope; `warningsCount` is
 *  pulled from the parsed object's `warnings` field when it's an array. */
export function buildResultMeta(
  firstJsonObj: Record<string, unknown> | null,
  sizeBytes: number,
): CallRecord["resultMeta"] {
  if (!firstJsonObj) return { ok: true, sizeBytes, warningsCount: 0 };
  const ok = firstJsonObj.ok !== false;
  const warningsCount = Array.isArray(firstJsonObj.warnings) ? firstJsonObj.warnings.length : 0;
  if (ok) return { ok: true, sizeBytes, warningsCount };
  return {
    ok: false,
    sizeBytes,
    warningsCount,
    failureKind: failureKindOf(firstJsonObj as { ok: false }),
  };
}

// ---------------------------------------------------------------------------
// eval_js deep-capture helpers
// ---------------------------------------------------------------------------

const EVAL_HEAD_LEN = 80;

/** Build the eval_js-specific deep-capture envelope from a tool call's
 *  args + result. Returns undefined when the tool isn't eval_js. */
export function buildEvalJsCapture(
  toolName: string,
  args: unknown,
  firstJsonObj: Record<string, unknown> | null,
): CallRecord["evalJs"] | undefined {
  if (toolName !== "eval_js" && toolName !== "poll_eval") return undefined;
  const expr =
    args && typeof args === "object"
      ? ((args as Record<string, unknown>).expr ?? (args as Record<string, unknown>).expression)
      : undefined;
  if (typeof expr !== "string") return undefined;
  const exprHead = expr.slice(0, EVAL_HEAD_LEN);
  const exprSha = createHash("sha256").update(expr, "utf8").digest("hex");
  const taxonomy = classifyEvalExpr(exprHead);
  let returnType = "unknown";
  let returnSizeBytes = 0;
  if (firstJsonObj) {
    const v = firstJsonObj.value;
    returnType = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    try {
      returnSizeBytes = Buffer.byteLength(JSON.stringify(v ?? null), "utf8");
    } catch {
      returnSizeBytes = 0;
    }
  }
  return { exprSha, exprHead, returnType, returnSizeBytes, taxonomy };
}
