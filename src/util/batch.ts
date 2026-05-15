// Batch dispatch loop — runs a sequence of tool calls through a handler map,
// records each result's ok-ness, and halts at the first failure unless the
// caller opts out. Kept dep-free so the unit tests can exercise it without
// spinning up the full MCP server.

export interface BatchCall {
  tool: string;
  args?: Record<string, unknown>;
}

export interface BatchEntry {
  tool: string;
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
      results.push({ tool: call.tool, ok: parsed.ok, result: parsed.body });
      if (!parsed.ok) {
        failedAt = i;
        if (stop) break;
      }
    } catch (e) {
      results.push({ tool: call.tool, ok: false, error: e instanceof Error ? e.message : String(e) });
      failedAt = i;
      if (stop) break;
    }
  }

  return { completed: results.length, failedAt, results };
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
