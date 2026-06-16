// Surface registry. pages/index.ts calls `register()` for every surface; the
// HTTP server reads `surfaces()` / `routeFor()` / `socketFor()`.

import type { Surface, Route, SocketRoute } from "./types.js";

const SURFACES: Surface[] = [];

export function register(surface: Surface): void {
  if (SURFACES.some((s) => s.id === surface.id)) {
    throw new Error(`duplicate surface id: ${surface.id}`);
  }
  SURFACES.push(surface);
}

export function surfaces(): readonly Surface[] {
  return SURFACES;
}

export function pageFor(pathname: string): Surface | undefined {
  return SURFACES.find((s) => s.path === pathname);
}

export function routeFor(method: string, pathname: string): Route | undefined {
  for (const s of SURFACES) {
    for (const r of s.routes ?? []) {
      if (r.method === method && r.path === pathname) return r;
    }
  }
  return undefined;
}

export function socketFor(pathname: string): SocketRoute | undefined {
  for (const s of SURFACES) {
    for (const sock of s.sockets ?? []) {
      if (sock.path === pathname) return sock;
    }
  }
  return undefined;
}
