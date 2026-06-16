import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join, resolve } from "node:path";
import type { DogfoodRunConfig } from "../config.js";

export interface ManagedProcess {
  readonly name: string;
  readonly child: ChildProcess;
  readonly stdout: string[];
  readonly stderr: string[];
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export interface TestbedServerProcess extends ManagedProcess {
  readonly port: number;
  readonly baseUrl: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function tail(lines: readonly string[], count = 20): string {
  return lines.slice(-count).join("");
}

function startManagedProcess(input: {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}): ManagedProcess {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  return {
    name: input.name,
    child,
    stdout,
    stderr,
    stop: async (signal: NodeJS.Signals = "SIGTERM") => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill(signal);
      });
    },
  };
}

async function newestMtime(root: string): Promise<number> {
  let newest = 0;
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const st = await stat(full);
      newest = Math.max(newest, st.mtimeMs);
    }
  }
  await walk(root);
  return newest;
}

export async function preflightLiveRun(config: DogfoodRunConfig): Promise<void> {
  const distCli = resolve(config.repoRoot, "dist/cli.js");
  await access(distCli, constants.R_OK).catch(() => {
    throw new Error(`missing ${distCli}; run pnpm build before live dogfood`);
  });
  const distStat = await stat(distCli);
  const newestSource = await newestMtime(resolve(config.repoRoot, "src"));
  if (distStat.mtimeMs < newestSource) {
    throw new Error(`${distCli} is older than src/*.ts; run pnpm build before live dogfood`);
  }
}

async function canListen(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolveCanListen) => {
    const server = createServer();
    server.once("error", () => resolveCanListen(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveCanListen(true));
    });
  });
}

export async function pickFreePort(start = 5187, end = 5587): Promise<number> {
  for (let port = start; port <= end; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`no free testbed port in range ${start}-${end}`);
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let lastError = "timeout";
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) {
        const body = (await res.json()) as { ok?: unknown };
        if (body.ok === true) return;
      }
    } catch (err) {
      lastError =
        err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
    }
    await delay(100);
  }
  throw new Error(`testbed did not become healthy at ${baseUrl}: ${lastError}`);
}

export async function startTestbedServer(config: DogfoodRunConfig): Promise<TestbedServerProcess> {
  const port = config.testbedPort === "auto" ? await pickFreePort() : config.testbedPort;
  const proc = startManagedProcess({
    name: "capability-testbed",
    command: "pnpm",
    args: ["--filter", "@browxai/capability-testbed", "serve"],
    cwd: config.repoRoot,
    env: { ...process.env, TESTBED_PORT: String(port) },
  });
  const baseUrl = `http://localhost:${String(port)}`;
  try {
    await waitForHealth(baseUrl, 30_000);
  } catch (err) {
    await proc.stop();
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n` +
        `testbed stdout:\n${tail(proc.stdout)}\n` +
        `testbed stderr:\n${tail(proc.stderr)}`,
    );
  }
  return { ...proc, port, baseUrl };
}

function readLineJson(
  socketPath: string,
  timeoutMs: number,
): Promise<{
  send(message: unknown): void;
  read(id: number): Promise<Record<string, unknown>>;
  close(): void;
}> {
  return new Promise((resolveClient, rejectClient) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const waiters = new Map<number, (value: Record<string, unknown>) => void>();
    const timer = setTimeout(() => {
      socket.destroy();
      rejectClient(new Error(`timeout connecting to ${socketPath}`));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolveClient({
        send(message: unknown): void {
          socket.write(`${JSON.stringify(message)}\n`);
        },
        read(id: number): Promise<Record<string, unknown>> {
          return new Promise((resolveRead, rejectRead) => {
            const readTimer = setTimeout(() => {
              waiters.delete(id);
              rejectRead(new Error(`timeout waiting for MCP response id ${String(id)}`));
            }, timeoutMs);
            waiters.set(id, (value) => {
              clearTimeout(readTimer);
              resolveRead(value);
            });
          });
        },
        close(): void {
          socket.end();
        },
      });
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      rejectClient(err);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        const id = typeof frame.id === "number" ? frame.id : undefined;
        if (id !== undefined) waiters.get(id)?.(frame);
      }
    });
  });
}

export async function probeBrowxaiSocket(socketPath: string, timeoutMs = 2_000): Promise<void> {
  const client = await readLineJson(socketPath, timeoutMs);
  try {
    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "browxai-dogfood-probe", version: "0.0.0" },
      },
    });
    const init = await client.read(1);
    if (init.error !== undefined)
      throw new Error(`MCP initialize failed: ${JSON.stringify(init.error)}`);
    client.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = await client.read(2);
    if (tools.error !== undefined)
      throw new Error(`MCP tools/list failed: ${JSON.stringify(tools.error)}`);
  } finally {
    client.close();
  }
}

export async function waitForBrowxaiSocket(socketPath: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  let lastError: Error | null = null;
  while (Date.now() - started < timeoutMs) {
    try {
      await probeBrowxaiSocket(socketPath, 2_000);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      await delay(150);
    }
  }
  throw new Error(`browxai socket not ready at ${socketPath}: ${lastError?.message ?? "timeout"}`);
}

export async function startBrowxaiServe(config: DogfoodRunConfig): Promise<ManagedProcess> {
  await mkdir(config.workspace, { recursive: true });
  const proc = startManagedProcess({
    name: "browxai-serve",
    command: "pnpm",
    args: ["exec", "browxai", "serve", "--socket", config.browxaiSocket],
    cwd: config.repoRoot,
    env: {
      ...process.env,
      BROWX_WORKSPACE: config.workspace,
      BROWX_CAPABILITIES: config.browxaiCapabilities.join(","),
      BROWX_HEADLESS: config.headless ? "1" : "0",
    },
  });
  try {
    await waitForBrowxaiSocket(config.browxaiSocket, 30_000);
  } catch (err) {
    await proc.stop();
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n` +
        `browxai stdout:\n${tail(proc.stdout)}\n` +
        `browxai stderr:\n${tail(proc.stderr)}`,
    );
  }
  return proc;
}
