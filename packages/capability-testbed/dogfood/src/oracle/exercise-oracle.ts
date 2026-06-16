import { createConnection, type Socket } from "node:net";
import { MANIFEST } from "../../../src/harness/manifest.js";
import { buildContext, runExercise } from "../../../src/harness/driver.js";
import type { BrowxaiResult, Client, ManifestRow } from "../../../src/harness/types.js";
import type { DogfoodMission } from "../missions/schema.js";
import type { OracleToolOutcome } from "../report/schema.js";

interface RpcFrame {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: unknown;
}

class SocketMcpClient implements Client {
  private readonly socket: Socket;
  private buffer = "";
  private nextId = 1;
  private readonly waiters = new Map<
    number,
    { resolve: (value: RpcFrame) => void; reject: (err: Error) => void }
  >();

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (err) => {
      for (const waiter of this.waiters.values()) waiter.reject(err);
      this.waiters.clear();
    });
  }

  static async connect(socketPath: string): Promise<SocketMcpClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const sock = createConnection(socketPath);
      sock.once("connect", () => resolve(sock));
      sock.once("error", reject);
    });
    const client = new SocketMcpClient(socket);
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "browxai-dogfood-oracle", version: "0.0.0" },
    });
    client.notify("notifications/initialized", {});
    return client;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<BrowxaiResult> {
    const response = await this.request("tools/call", { name, arguments: args });
    if (response.error !== undefined) {
      return { content: [], data: response.error, isError: true };
    }
    const result = response.result as BrowxaiResult;
    return result;
  }

  open_session(args?: Record<string, unknown>): Promise<BrowxaiResult> {
    return this.callTool("open_session", args);
  }

  close_session(args?: Record<string, unknown>): Promise<BrowxaiResult> {
    return this.callTool("close_session", args);
  }

  close_sessions(args?: Record<string, unknown>): Promise<BrowxaiResult> {
    return this.callTool("close_sessions", args);
  }

  list_sessions(args?: Record<string, unknown>): Promise<BrowxaiResult> {
    return this.callTool("list_sessions", args);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.socket.end(() => resolve());
    });
  }

  private request(method: string, params: unknown): Promise<RpcFrame> {
    const id = this.nextId;
    this.nextId += 1;
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise<RpcFrame>((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
    });
  }

  private notify(method: string, params: unknown): void {
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      const frame = JSON.parse(line) as RpcFrame;
      if (typeof frame.id !== "number") continue;
      const waiter = this.waiters.get(frame.id);
      if (!waiter) continue;
      this.waiters.delete(frame.id);
      waiter.resolve(frame);
    }
  }
}

function manifestRow(tool: string): ManifestRow {
  const row = MANIFEST.find((entry) => entry.tool === tool);
  if (!row) throw new Error(`oracle requested unknown manifest tool: ${tool}`);
  return row;
}

export async function runMissionOracle(input: {
  readonly mission: DogfoodMission;
  readonly runIndex: number;
  readonly socketPath: string;
  readonly baseUrl: string;
  readonly workspace: string;
  readonly timeoutMs: number;
}): Promise<OracleToolOutcome[]> {
  const client = await SocketMcpClient.connect(input.socketPath);
  try {
    const results: OracleToolOutcome[] = [];
    for (const tool of input.mission.oracle.exerciseTools) {
      const session = `oracle-${input.mission.id}-r${String(input.runIndex)}-${tool}`;
      const ctx = await buildContext(client, session, input.baseUrl, input.workspace);
      const report = await runExercise(manifestRow(tool), ctx, input.timeoutMs);
      results.push({
        tool,
        outcome: report.outcome,
        ...(report.detail !== undefined ? { detail: report.detail } : {}),
      });
    }
    return results;
  } finally {
    await client.close();
  }
}
