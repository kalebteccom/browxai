// Server contracts. A "surface" is one capability-exercising page: it owns its
// HTML and any extra HTTP routes / WebSocket endpoints it needs. The registry
// (registry.ts) collects surfaces; the HTTP server (http.ts) serves them.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { MinimalSocket } from "./ws.js";

export interface RouteCtx {
  readonly url: URL;
  readonly method: string;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  /** Raw request body (only read for non-GET; empty string otherwise). */
  readonly body: string;
}

export interface Route {
  /** HTTP method this route matches, e.g. "GET" / "POST". */
  readonly method: string;
  /** Exact pathname this route matches, e.g. "/api/echo". */
  readonly path: string;
  handle(ctx: RouteCtx): void | Promise<void>;
}

export interface SocketRoute {
  /** Pathname the WebSocket upgrade is accepted on, e.g. "/ws/echo". */
  readonly path: string;
  /** Called once per accepted connection with a minimal text-frame socket. */
  onConnect(socket: MinimalSocket, url: URL): void;
}

export interface Surface {
  /** Stable id, e.g. "forms". */
  readonly id: string;
  /** Pathname the page is served at, e.g. "/forms". */
  readonly path: string;
  /** <title> + nav label. */
  readonly title: string;
  /** One-line description shown on the index page. */
  readonly blurb: string;
  /** Full HTML document for the page. */
  html(): string;
  /** Extra HTTP routes (APIs, assets) this surface needs. */
  readonly routes?: ReadonlyArray<Route>;
  /** WebSocket endpoints this surface needs. */
  readonly sockets?: ReadonlyArray<SocketRoute>;
}
