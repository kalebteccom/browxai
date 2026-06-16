import { spawn as nodeSpawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  buildCodexTurnInput,
  mapCodexNotification,
  type CodexEvent,
  type RpcFrame,
} from "./codex-events.js";
import type { CodexApprovalPolicy, CodexEffort, CodexSandbox } from "../config.js";

export interface CodexChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "close" | "error", cb: (...args: never[]) => void): void;
}

export interface SpawnRequest {
  readonly cwd: string;
  readonly codexBin: string;
  readonly appServerArgs: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export type SpawnFn = (request: SpawnRequest) => CodexChild;

export interface CodexOwnOptions {
  readonly cwd: string;
  readonly codexBin: string;
  readonly appServerArgs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly model: string;
  readonly effort: CodexEffort;
  readonly sandbox: CodexSandbox;
  readonly approvalPolicy: CodexApprovalPolicy;
}

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "applyPatchApproval",
  "execCommandApproval",
]);

// MCP "elicitation" = a server asking the client for input/confirmation mid
// tool-call. An unattended dogfood turn has no one to answer, so we DECLINE
// rather than let the call block until the mission timeout (the failure mode
// the live run hit when the agent reached the attach-mode browxai server).
const ELICITATION_METHODS = new Set([
  "mcpServer/elicitation/request",
  "elicitation/create",
  "elicitation/request",
]);

const defaultSpawn: SpawnFn = (request) =>
  nodeSpawn(request.codexBin, ["app-server", ...request.appServerArgs], {
    cwd: request.cwd,
    env: request.env,
    stdio: ["pipe", "pipe", "inherit"],
  }) as unknown as CodexChild;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function threadIdFromResult(result: unknown): string | undefined {
  const obj = asRecord(result);
  const thread = asRecord(obj?.thread);
  const nested = thread?.id;
  if (typeof nested === "string" && nested.length > 0) return nested;
  const direct = obj?.threadId;
  return typeof direct === "string" && direct.length > 0 ? direct : undefined;
}

function threadIdFromNotification(params: unknown): string | undefined {
  const obj = asRecord(params);
  const thread = asRecord(obj?.thread);
  const nested = thread?.id;
  if (typeof nested === "string" && nested.length > 0) return nested;
  const direct = obj?.threadId;
  return typeof direct === "string" && direct.length > 0 ? direct : undefined;
}

export class InlineCodexAppServerOwn {
  private readonly child: CodexChild;
  private readonly opts: CodexOwnOptions;
  private buffer = "";
  private nextId = 1;
  private initializeId = 0;
  private ready = false;
  private closed = false;
  private threadId: string | null = null;
  private currentTurnId: string | null = null;
  private rawHandler?: (direction: "in" | "out", frame: RpcFrame) => void;
  private readonly rawBacklog: Array<{ direction: "in" | "out"; frame: RpcFrame }> = [];
  private readonly nativeIdListeners: Array<(nativeId: string) => void> = [];
  private readonly eventQueue: CodexEvent[] = [];
  private readonly waiters: Array<(event: CodexEvent | null) => void> = [];

  constructor(opts: CodexOwnOptions, spawn: SpawnFn = defaultSpawn) {
    this.opts = opts;
    this.child = spawn({
      cwd: opts.cwd,
      codexBin: opts.codexBin,
      appServerArgs: opts.appServerArgs ?? [],
      env: opts.env ?? process.env,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.on("error", (err: Error) => {
      this.flush({
        kind: "rpc_error",
        requestId: "spawn",
        message: err.message,
        atMs: Date.now(),
      });
    });
    this.child.on("close", () => {
      this.closed = true;
      this.flush(null);
    });
    this.initializeId = this.send("initialize", {
      clientInfo: { name: "browxai-dogfood", title: null, version: "0.0.0" },
      capabilities: null,
    });
  }

  onRaw(handler: (direction: "in" | "out", frame: RpcFrame) => void): void {
    this.rawHandler = handler;
    for (const entry of this.rawBacklog.splice(0)) handler(entry.direction, entry.frame);
  }

  nativeId(): string | null {
    return this.threadId;
  }

  onNativeId(handler: (nativeId: string) => void): void {
    this.nativeIdListeners.push(handler);
    if (this.threadId !== null) handler(this.threadId);
  }

  pid(): number | null {
    return this.closed ? null : (this.child.pid ?? null);
  }

  async *events(): AsyncIterable<CodexEvent> {
    while (!this.closed || this.eventQueue.length > 0) {
      const queued = this.eventQueue.shift();
      if (queued) {
        yield queued;
        continue;
      }
      const event = await new Promise<CodexEvent | null>((resolve) => {
        this.waiters.push(resolve);
      });
      if (event === null) return;
      yield event;
    }
  }

  async startTurn(text: string, timeoutMs = 30_000): Promise<void> {
    await this.waitForThreadId(timeoutMs);
    if (this.threadId === null) {
      throw new Error("codex app-server: thread/start did not return a thread id");
    }
    this.send("turn/start", {
      threadId: this.threadId,
      input: buildCodexTurnInput(text),
    });
  }

  interrupt(): Promise<void> {
    if (this.threadId === null || this.currentTurnId === null) return Promise.resolve();
    this.send("turn/interrupt", { threadId: this.threadId, turnId: this.currentTurnId });
    return Promise.resolve();
  }

  stop(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    try {
      this.child.kill("SIGTERM");
    } catch {
      /* child already exited */
    }
    this.flush(null);
    return Promise.resolve();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) return;
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim().length === 0) continue;
      let frame: RpcFrame;
      try {
        frame = JSON.parse(line) as RpcFrame;
      } catch {
        continue;
      }
      this.handle(frame);
    }
  }

  private send(method: string, params: unknown): number {
    const id = this.nextId;
    this.nextId += 1;
    const frame = { id, method, params };
    this.emitRaw("out", frame);
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    return id;
  }

  private notify(method: string, params: unknown): void {
    const frame = { method, params };
    this.emitRaw("out", frame);
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private reply(id: string | number, result: unknown): void {
    const frame = { id, result };
    this.emitRaw("out", frame);
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private handle(frame: RpcFrame): void {
    this.emitRaw("in", frame);
    const now = Date.now();

    if (frame.id === this.initializeId && !this.ready && frame.error === undefined) {
      this.ready = true;
      this.notify("initialized", {});
      this.send("thread/start", {
        model: this.opts.model,
        reasoningEffort: this.opts.effort,
        sandbox: this.opts.sandbox,
        approvalPolicy: this.opts.approvalPolicy,
      });
      return;
    }

    const resultThreadId = threadIdFromResult(frame.result);
    if (resultThreadId) this.setThreadId(resultThreadId);
    if (frame.method === "thread/started") {
      const notificationThreadId = threadIdFromNotification(frame.params);
      if (notificationThreadId) this.setThreadId(notificationThreadId);
    }
    if (
      frame.method !== undefined &&
      APPROVAL_METHODS.has(frame.method) &&
      frame.id !== undefined
    ) {
      // APPROVE the agent's actions. The dogfood agent's whole job is to drive
      // browxai MCP tools; DECLINING approval requests made every browxai call
      // come back as "user rejected MCP tool call". The proven codex reply shape
      // is `{decision:"accept"}` (remotxai adapter). The read-only sandbox +
      // the mission prompt (no shell / no local browser) are the real guardrails.
      this.reply(frame.id, { decision: "accept" });
      return;
    }
    if (
      frame.method !== undefined &&
      ELICITATION_METHODS.has(frame.method) &&
      frame.id !== undefined
    ) {
      // codex-cli 0.140.0 gates EACH MCP tool call behind an elicitation the
      // client must ALLOW. Declining here surfaces as "user rejected MCP tool
      // call" and blocks the whole mission, so accept. (Unvalidated against a
      // live run — the exact accept shape/content for 0.140.0 still needs one
      // host-side confirmation; marking the browxai server trusted in the codex
      // config so it is not elicit-gated at all is the alternative.)
      this.reply(frame.id, { action: "accept", content: {} });
      return;
    }

    for (const event of mapCodexNotification(frame, now)) {
      if (event.kind === "status") {
        this.currentTurnId = event.state === "active" ? (event.turnId ?? null) : null;
      }
      this.flush(event);
    }
  }

  private setThreadId(threadId: string): void {
    if (this.threadId !== null) return;
    this.threadId = threadId;
    for (const handler of this.nativeIdListeners) handler(threadId);
  }

  private emitRaw(direction: "in" | "out", frame: RpcFrame): void {
    const handler = this.rawHandler;
    if (handler) {
      handler(direction, frame);
      return;
    }
    this.rawBacklog.push({ direction, frame });
  }

  private waitForThreadId(timeoutMs: number): Promise<void> {
    if (this.threadId !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this.nativeIdListeners.push(() => done());
      setTimeout(done, timeoutMs);
    });
  }

  private flush(event: CodexEvent | null): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    if (event !== null) this.eventQueue.push(event);
  }
}

/** Default browxai-named MCP servers a driving Codex may already have in its
 *  `~/.codex/config.toml`. The dogfood session must point ALL of them at the
 *  harness's host-side socket proxy — otherwise the agent can pick the user's
 *  real `browxai-attached` server, which tries to attach to a non-existent
 *  Chrome and then HANGS the tool call on an elicitation request. Override via
 *  DOGFOOD_BROWXAI_SERVER_NAMES (comma-separated). */
export const DEFAULT_BROWXAI_SERVER_NAMES = ["browxai", "browxai-attached"] as const;

export function codexMcpConfigArgs(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly startupTimeoutSec?: number;
  readonly toolTimeoutSec?: number;
  readonly serverNames?: readonly string[];
}): string[] {
  const quote = (value: string): string => JSON.stringify(value);
  const names = input.serverNames ?? DEFAULT_BROWXAI_SERVER_NAMES;
  const argsLiteral = `[${input.args.map((arg) => quote(arg)).join(",")}]`;
  const out: string[] = [];
  for (const name of names) {
    out.push(
      "-c",
      `mcp_servers.${name}.command=${quote(input.command)}`,
      "-c",
      `mcp_servers.${name}.args=${argsLiteral}`,
      "-c",
      `mcp_servers.${name}.startup_timeout_sec=${String(input.startupTimeoutSec ?? 30)}`,
      "-c",
      `mcp_servers.${name}.tool_timeout_sec=${String(input.toolTimeoutSec ?? 180)}`,
    );
  }
  return out;
}
