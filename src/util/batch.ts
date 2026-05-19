// Batch dispatch loop — runs a sequence of tool calls through a handler map,
// records each result's ok-ness, and halts at the first failure unless the
// caller opts out. Kept dep-free so the unit tests can exercise it without
// spinning up the full MCP server.

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
 * Predicates that touch `element.*` paths assume the inner call returned an
 * ActionResult shape; against other shapes they treat missing paths as fails.
 *
 * Exported for unit tests.
 */
export function evaluateExpect(expect: BatchExpect, body: unknown): string | null {
  const elem = readElement(body);
  if (expect.valueEquals !== undefined) {
    if (elem?.value !== expect.valueEquals) {
      return `element.value !== ${JSON.stringify(expect.valueEquals)} (got ${JSON.stringify(elem?.value ?? null)})`;
    }
  }
  if (expect.displayTextIncludes !== undefined) {
    if (!(typeof elem?.displayText === "string" && elem.displayText.includes(expect.displayTextIncludes))) {
      return `element.displayText does not include ${JSON.stringify(expect.displayTextIncludes)} (got ${JSON.stringify(elem?.displayText ?? null)})`;
    }
  }
  if (expect.controlDisplayTextIncludes !== undefined) {
    const t = elem?.ownerControl?.displayTextAfter;
    if (!(typeof t === "string" && t.includes(expect.controlDisplayTextIncludes))) {
      return `element.ownerControl.displayTextAfter does not include ${JSON.stringify(expect.controlDisplayTextIncludes)} (got ${JSON.stringify(t ?? null)})`;
    }
  }
  if (expect.containerTextIncludes !== undefined) {
    const t = elem?.container?.rowText;
    if (!(typeof t === "string" && t.includes(expect.containerTextIncludes))) {
      return `element.container.rowText does not include ${JSON.stringify(expect.containerTextIncludes)} (got ${JSON.stringify(t ?? null)})`;
    }
  }
  if (expect.controlChanged !== undefined) {
    const c = elem?.ownerControl?.changed;
    if (c !== expect.controlChanged) {
      return `element.ownerControl.changed !== ${expect.controlChanged} (got ${JSON.stringify(c ?? null)})`;
    }
  }
  return null;
}

interface ProbeShape {
  value?: string | null;
  displayText?: string | null;
  ownerControl?: { displayTextAfter?: string; changed?: boolean };
  container?: { rowText?: string };
}

function readElement(body: unknown): ProbeShape | null {
  if (!body || typeof body !== "object") return null;
  const elem = (body as { element?: ProbeShape }).element;
  return elem ?? null;
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
