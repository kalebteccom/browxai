// Batch dispatch loop — runs a sequence of tool calls through a handler map,
// records each result's ok-ness, and halts at the first failure unless the
// caller opts out. Kept dep-free so the unit tests can exercise it without
// spinning up the full MCP server.
//
// `BatchExpect` exposes a small set of shorthand assertion fields tuned for
// the per-call post-condition pattern (`valueEquals`, `displayTextIncludes`,
// …). Their INPUT shape is frozen for back-compat, but their implementation
// lowers each shorthand into a `Predicate` and delegates to the shared
// vocabulary in `src/util/predicates.ts` — same engine that backs
// `verify_predicate`. One source of truth: if the predicate vocabulary's
// `contains` semantics ever change, both surfaces move together.

import {
  evaluatePredicate,
  type Predicate,
  type PredicateResult,
} from "./predicates.js";

export interface BatchCall {
  tool: string;
  args?: Record<string, unknown>;
  /** opaque label echoed verbatim in the result for cross-referencing in
   *  long batches ("set type", "set initiative", "save row"). Free-form. */
  label?: string;
  /** optional post-call assertions. Failing any assertion marks the call
   *  as `ok: false` with `error` set to the failed predicate, and respects
   *  `stopOnError`. Minimal predicate set — not a full assertion DSL. */
  expect?: BatchExpect;
}

export interface BatchExpect {
  /** Inner result's `element.value === <string>`. */
  valueEquals?: string;
  /** Inner result's `element.displayText` includes the substring. */
  displayTextIncludes?: string;
  /** Inner result's `element.ownerControl.displayTextAfter` includes the substring. */
  controlDisplayTextIncludes?: string;
  /** Inner result's `element.container.rowText` includes the substring. */
  containerTextIncludes?: string;
  /** Inner result's `element.ownerControl.changed === true`. */
  controlChanged?: boolean;
}

export interface BatchEntry {
  tool: string;
  /** Echo of the call's `label` when supplied. */
  label?: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BatchReport {
  completed: number;
  failedAt: number | null;
  results: BatchEntry[];
}

export type ToolContent = { type: "text"; text: string } | { type: string; [k: string]: unknown };
export interface ToolResponse {
  content: ToolContent[];
}
export type ToolHandler = (args: unknown) => Promise<ToolResponse>;

export interface BatchOptions {
  allowed: ReadonlySet<string>;
  handlers: Record<string, ToolHandler>;
  stopOnError?: boolean;
}

export async function runBatch(calls: BatchCall[], opts: BatchOptions): Promise<BatchReport> {
  const stop = opts.stopOnError !== false; // default true
  const results: BatchEntry[] = [];
  let failedAt: number | null = null;

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    if (!opts.allowed.has(call.tool)) {
      results.push({
        tool: call.tool,
        ok: false,
        error: `tool "${call.tool}" not allowed inside batch (whitelist: ${[...opts.allowed].sort().join(", ")})`,
      });
      failedAt = i;
      if (stop) break;
      continue;
    }
    const handler = opts.handlers[call.tool];
    if (!handler) {
      results.push({ tool: call.tool, ok: false, error: `unknown tool "${call.tool}"` });
      failedAt = i;
      if (stop) break;
      continue;
    }
    try {
      const resp = await handler(call.args ?? {});
      const parsed = parseInner(resp);
      let ok = parsed.ok;
      let error: string | undefined;
      if (ok && call.expect) {
        const violation = evaluateExpect(call.expect, parsed.body);
        if (violation) {
          ok = false;
          error = `expect failed: ${violation}`;
        }
      }
      const entry: BatchEntry = { tool: call.tool, ok, result: parsed.body };
      if (call.label !== undefined) entry.label = call.label;
      if (error !== undefined) entry.error = error;
      results.push(entry);
      if (!ok) {
        failedAt = i;
        if (stop) break;
      }
    } catch (e) {
      const entry: BatchEntry = { tool: call.tool, ok: false, error: e instanceof Error ? e.message : String(e) };
      if (call.label !== undefined) entry.label = call.label;
      results.push(entry);
      failedAt = i;
      if (stop) break;
    }
  }

  return { completed: results.length, failedAt, results };
}

/**
 * Evaluate a `BatchExpect` against the parsed inner-call result. Returns null
 * when all predicates pass, or a string describing the first failed predicate.
 *
 * Implementation: each shorthand field lowers into a `Predicate` and runs
 * through the shared `evaluatePredicate` engine — same vocabulary that backs
 * `verify_predicate`. The shorthand INPUT shape stays frozen; the engine
 * underneath is shared so semantic primitives (`contains`, `equals`) can
 * never drift between the two surfaces. The data bag is the inner-call body
 * itself (an ActionResult-shaped `{element: {...}}`); paths use the
 * `element.*` root, which is on the predicate engine's accessor allow-list.
 *
 * Exported for unit tests.
 */
export function evaluateExpect(expect: BatchExpect, body: unknown): string | null {
  for (const lowered of lowerExpect(expect)) {
    const r = evaluatePredicate(lowered.predicate, body);
    if (!r.ok) return formatExpectFailure(lowered, r);
  }
  return null;
}

interface LoweredShorthand {
  /** Source shorthand field name — used in the failure string so the
   *  user-facing message still names the shorthand they supplied. */
  field: keyof BatchExpect;
  /** Path label for the failure message (e.g. "element.value"). */
  path: string;
  /** The value the shorthand expected (echoed in the failure message). */
  expected: unknown;
  predicate: Predicate;
}

/** Pure; exported for tests + the equivalence-pinning regression. Each
 *  supplied shorthand field becomes one predicate over the inner body. */
export function lowerExpect(expect: BatchExpect): LoweredShorthand[] {
  const out: LoweredShorthand[] = [];
  if (expect.valueEquals !== undefined) {
    out.push({
      field: "valueEquals",
      path: "element.value",
      expected: expect.valueEquals,
      predicate: { kind: "equals", key: "element.value", value: expect.valueEquals },
    });
  }
  if (expect.displayTextIncludes !== undefined) {
    out.push({
      field: "displayTextIncludes",
      path: "element.displayText",
      expected: expect.displayTextIncludes,
      predicate: { kind: "contains", key: "element.displayText", value: expect.displayTextIncludes },
    });
  }
  if (expect.controlDisplayTextIncludes !== undefined) {
    out.push({
      field: "controlDisplayTextIncludes",
      path: "element.ownerControl.displayTextAfter",
      expected: expect.controlDisplayTextIncludes,
      predicate: { kind: "contains", key: "element.ownerControl.displayTextAfter", value: expect.controlDisplayTextIncludes },
    });
  }
  if (expect.containerTextIncludes !== undefined) {
    out.push({
      field: "containerTextIncludes",
      path: "element.container.rowText",
      expected: expect.containerTextIncludes,
      predicate: { kind: "contains", key: "element.container.rowText", value: expect.containerTextIncludes },
    });
  }
  if (expect.controlChanged !== undefined) {
    out.push({
      field: "controlChanged",
      path: "element.ownerControl.changed",
      expected: expect.controlChanged,
      predicate: { kind: "equals", key: "element.ownerControl.changed", value: expect.controlChanged },
    });
  }
  return out;
}

function formatExpectFailure(lowered: LoweredShorthand, fail: PredicateResult): string {
  // Keep the historical message shape so existing string-matching tests +
  // adopter logs read identically: "<path> <op> <expected> (got <actual>)".
  if (fail.ok) return ""; // unreachable; appeases the type-checker.
  const actualJson = JSON.stringify(fail.actual ?? null);
  const expectedJson = JSON.stringify(lowered.expected);
  if (lowered.predicate.kind === "equals") {
    return `${lowered.path} !== ${expectedJson} (got ${actualJson})`;
  }
  // contains shorthands
  return `${lowered.path} does not include ${expectedJson} (got ${actualJson})`;
}

function parseInner(resp: ToolResponse): { ok: boolean; body: unknown } {
  const first = resp.content[0];
  if (!first) return { ok: true, body: null };
  if (first.type !== "text") return { ok: true, body: first };
  const text = (first as { text: string }).text;
  try {
    const parsed = JSON.parse(text) as { ok?: boolean };
    const ok = parsed.ok === undefined ? true : parsed.ok === true;
    return { ok, body: parsed };
  } catch {
    return { ok: true, body: text };
  }
}
