// Zero-dependency HTTP + WebSocket server for the testbed. Serves registered
// page surfaces, their extra routes, and accepts WS upgrades on registered
// socket paths. Built on Node's `http` module only.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { surfaces, pageFor, routeFor, socketFor } from "./registry.js";
import { acceptUpgrade } from "./ws.js";
import { doc, esc } from "./html.js";
import "./pages/index.js"; // side-effect: registers every surface

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

function indexHtml(): string {
  const rows = surfaces()
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (s) =>
        `<li><a href="${esc(s.path)}" data-surface-link="${esc(s.id)}">${esc(s.title)}</a> — ${esc(s.blurb)}</li>`,
    )
    .join("\n");
  return doc(
    "browxai capability testbed",
    `<p data-testid="intro">Surfaces that exercise every browxai capability.</p>
<ul data-testid="surface-list">
${rows}
</ul>`,
    { surfaceId: "index" },
  );
}

async function readBody(req: IncomingMessage): Promise<string> {
  if (req.method === "GET" || req.method === "HEAD") return "";
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    // Permit COOP/COEP-sensitive features and let pages set their own headers.
    "cache-control": "no-store",
  });
  res.end(body);
}

export function startServer(port = Number(process.env.TESTBED_PORT ?? 5187)): Promise<RunningServer> {
  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const method = req.method ?? "GET";

      if (url.pathname === "/" || url.pathname === "/index.html") {
        send(res, 200, "text/html; charset=utf-8", indexHtml());
        return;
      }
      if (url.pathname === "/healthz") {
        send(res, 200, "application/json", JSON.stringify({ ok: true }));
        return;
      }

      const route = routeFor(method, url.pathname);
      if (route) {
        const body = await readBody(req);
        await route.handle({ url, method, req, res, body });
        if (!res.writableEnded) res.end();
        return;
      }

      const page = pageFor(url.pathname);
      if (page && (method === "GET" || method === "HEAD")) {
        send(res, 200, "text/html; charset=utf-8", page.html());
        return;
      }

      send(res, 404, "text/plain; charset=utf-8", `not found: ${url.pathname}`);
    } catch (err) {
      if (!res.headersSent) {
        send(res, 500, "text/plain; charset=utf-8", `error: ${(err as Error).message}`);
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  }

  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const sock = socketFor(url.pathname);
    if (!sock) {
      socket.destroy();
      return;
    }
    const ms = acceptUpgrade(req, socket);
    if (!ms) {
      socket.destroy();
      return;
    }
    sock.onConnect(ms, url);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const url = `http://localhost:${port}`;
      resolve({
        url,
        port,
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}
