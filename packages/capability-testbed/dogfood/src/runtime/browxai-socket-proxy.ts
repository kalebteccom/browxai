import { createConnection, type Socket } from "node:net";

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const value = args[i + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function connectWithRetry(socketPath: string, timeoutMs: number): Promise<Socket> {
  const started = Date.now();
  let lastError: Error | null = null;
  while (Date.now() - started < timeoutMs) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = createConnection(socketPath);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      await delay(100);
    }
  }
  throw new Error(
    `browxai socket proxy could not connect to ${socketPath}: ${lastError?.message ?? "timeout"}`,
  );
}

export async function runBrowxaiSocketProxy(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const socketPath = valueAfter(argv, "--socket");
  if (!socketPath) {
    process.stderr.write("usage: browxai-socket-proxy --socket <path>\n");
    return 2;
  }
  const socket = await connectWithRetry(socketPath, 30_000);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  socket.on("error", (err) => {
    process.stderr.write(`browxai socket proxy error: ${err.message}\n`);
  });
  return await new Promise<number>((resolve) => {
    socket.on("close", () => resolve(0));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBrowxaiSocketProxy().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
