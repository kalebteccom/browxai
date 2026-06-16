import { createServer } from "node:net";
import { unlink } from "node:fs/promises";

export async function startMockMcpSocket(socketPath: string): Promise<{ close(): Promise<void> }> {
  await unlink(socketPath).catch(() => undefined);
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const frame = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: { name?: string; arguments?: unknown };
        };
        if (frame.id === undefined) continue;
        if (frame.method === "initialize") {
          socket.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: "mock" } })}\n`,
          );
        } else if (frame.method === "tools/list") {
          socket.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { tools: [] } })}\n`,
          );
        } else if (frame.method === "tools/call") {
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: frame.id,
              result: {
                content: [
                  { type: "text", text: JSON.stringify({ ok: true, tool: frame.params?.name }) },
                ],
              },
            })}\n`,
          );
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
    },
  };
}
