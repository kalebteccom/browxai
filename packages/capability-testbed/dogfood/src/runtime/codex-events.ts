export interface RpcFrame {
  readonly jsonrpc?: "2.0";
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

export interface CodexPlanItem {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export interface CodexTokenUsage {
  readonly input: number;
  readonly output: number;
  readonly total: number;
  readonly cached?: number;
  readonly contextWindow?: number;
}

export type CodexEvent =
  | {
      readonly kind: "tool_call";
      readonly phase: "started" | "completed";
      readonly itemId: string;
      readonly itemType: "mcpToolCall" | "commandExecution" | "fileChange" | "webSearch";
      readonly label: string;
      readonly server?: string;
      readonly tool: string;
      readonly args?: unknown;
      readonly result?: unknown;
      readonly rawItem: unknown;
      readonly atMs: number;
    }
  | { readonly kind: "reasoning"; readonly text: string; readonly atMs: number }
  | { readonly kind: "assistant_message"; readonly text: string; readonly atMs: number }
  | {
      readonly kind: "plan_update";
      readonly items: readonly CodexPlanItem[];
      readonly atMs: number;
    }
  | {
      readonly kind: "status";
      readonly state: "active" | "idle";
      readonly turnId?: string;
      readonly atMs: number;
    }
  | { readonly kind: "context_usage"; readonly usage: CodexTokenUsage; readonly atMs: number }
  | {
      readonly kind: "rpc_error";
      readonly requestId: string;
      readonly code?: number;
      readonly message: string;
      readonly atMs: number;
    };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function itemIdOf(item: Record<string, unknown>, params: Record<string, unknown>): string {
  const raw = item.id ?? params.itemId ?? params.id;
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (typeof raw === "number") return String(raw);
  const sequence = params.sequence;
  if (typeof sequence === "string" && sequence.length > 0) return `item-${sequence}`;
  if (typeof sequence === "number") return `item-${String(sequence)}`;
  return `item-${String(Date.now())}`;
}

function joinText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      if (part.trim().length > 0) parts.push(part);
      continue;
    }
    const obj = asRecord(part);
    if (!obj) continue;
    const text =
      (typeof obj.text === "string" && obj.text) ||
      (typeof obj.summary === "string" && obj.summary) ||
      (typeof obj.content === "string" && obj.content) ||
      "";
    if (text.trim().length > 0) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function extractCodexProse(
  itemType: "agentMessage" | "reasoning",
  raw: unknown,
): string | null {
  const item = asRecord(raw);
  if (!item) return null;
  const text =
    itemType === "reasoning"
      ? (joinText(item.summary) ?? joinText(item.content))
      : (joinText(item.text) ?? joinText(item.content));
  return text ?? null;
}

export function extractCodexPlanItems(raw: unknown): CodexPlanItem[] {
  const obj = asRecord(raw);
  if (!obj) return [];
  const list = Array.isArray(obj.plan) ? obj.plan : Array.isArray(obj.items) ? obj.items : [];
  const out: CodexPlanItem[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const row = asRecord(list[i]);
    if (!row) continue;
    const text =
      (typeof row.step === "string" && row.step) ||
      (typeof row.content === "string" && row.content) ||
      (typeof row.text === "string" && row.text) ||
      "";
    if (text.length === 0) continue;
    const status =
      row.status === "inProgress" || row.status === "in_progress"
        ? "in_progress"
        : row.status === "completed"
          ? "completed"
          : "pending";
    out.push({
      id: typeof row.id === "string" && row.id.length > 0 ? row.id : `plan-${String(i)}`,
      text,
      status,
    });
  }
  return out;
}

export function extractCodexUsage(params: unknown): CodexTokenUsage | null {
  const obj = asRecord(params);
  const usage = asRecord(obj?.usage);
  if (!usage) return null;
  const n = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const rawInput = n(usage.inputTokens) ?? 0;
  const cached = n(usage.cachedTokens) ?? 0;
  const input = rawInput + cached;
  const output = n(usage.outputTokens) ?? 0;
  const totalTokens = n(usage.totalTokens);
  const contextWindow = n(usage.contextWindow);
  const total = totalTokens ?? input + output;
  if (input === 0 && output === 0 && total === 0) return null;
  return {
    input,
    output,
    total,
    ...(cached > 0 ? { cached } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

function toolLabel(server: string | undefined, tool: string, itemType: string): string {
  if (itemType === "mcpToolCall") {
    return server ? `mcp ${server}:${tool}` : `mcp ${tool}`;
  }
  return itemType;
}

function mapToolItem(
  method: "item/started" | "item/completed",
  itemType: "mcpToolCall" | "commandExecution" | "fileChange" | "webSearch",
  item: Record<string, unknown>,
  params: Record<string, unknown>,
  atMs: number,
): CodexEvent {
  const server = stringField(item, ["server", "serverName", "mcpServer", "mcpServerName"]);
  const tool =
    stringField(item, ["tool", "name", "toolName"]) ??
    (itemType === "mcpToolCall" ? "unknown" : itemType);
  const args = item.arguments ?? item.args ?? item.input;
  const result = item.result ?? item.output ?? item.error;
  return {
    kind: "tool_call",
    phase: method === "item/started" ? "started" : "completed",
    itemId: itemIdOf(item, params),
    itemType,
    label: toolLabel(server, tool, itemType),
    ...(server !== undefined ? { server } : {}),
    tool,
    ...(args !== undefined ? { args } : {}),
    ...(result !== undefined ? { result } : {}),
    rawItem: item,
    atMs,
  };
}

export function mapCodexNotification(frame: RpcFrame, atMs: number): readonly CodexEvent[] {
  if (frame.error !== undefined && frame.id !== undefined) {
    return [
      {
        kind: "rpc_error",
        requestId: String(frame.id),
        ...(frame.error.code !== undefined ? { code: frame.error.code } : {}),
        message: frame.error.message ?? "(no message)",
        atMs,
      },
    ];
  }

  const method = frame.method;
  if (!method) return [];
  const params = asRecord(frame.params) ?? {};

  if (method === "turn/started") {
    const turn = asRecord(params.turn);
    return [
      {
        kind: "status",
        state: "active",
        ...(typeof turn?.id === "string" ? { turnId: turn.id } : {}),
        atMs,
      },
    ];
  }
  if (method === "turn/completed") {
    const events: CodexEvent[] = [{ kind: "status", state: "idle", atMs }];
    const usage = extractCodexUsage(params);
    if (usage) events.push({ kind: "context_usage", usage, atMs });
    return events;
  }
  if (method === "turn/plan/updated") {
    return [{ kind: "plan_update", items: extractCodexPlanItems(params), atMs }];
  }
  if (method !== "item/started" && method !== "item/completed") return [];

  const item = asRecord(params.item);
  if (!item) return [];
  const itemType = typeof item.type === "string" ? item.type : "";

  if (itemType === "agentMessage" && method === "item/completed") {
    const text = extractCodexProse("agentMessage", item);
    return text ? [{ kind: "assistant_message", text, atMs }] : [];
  }
  if (itemType === "reasoning" && method === "item/completed") {
    const text = extractCodexProse("reasoning", item);
    return text ? [{ kind: "reasoning", text, atMs }] : [];
  }
  if (itemType === "plan" && method === "item/completed") {
    return [{ kind: "plan_update", items: extractCodexPlanItems(item), atMs }];
  }
  if (
    itemType === "mcpToolCall" ||
    itemType === "commandExecution" ||
    itemType === "fileChange" ||
    itemType === "webSearch"
  ) {
    return [mapToolItem(method, itemType, item, params, atMs)];
  }
  return [];
}

export function buildCodexTurnInput(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
}
