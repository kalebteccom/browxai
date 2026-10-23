// Shared shapes for the Workers façade and its two transport channels
// (`workers-page.ts` for Web Workers, `workers-sw.ts` for Service Workers).
// Engine-blind DOMAIN types only — no CDP/Playwright imports — so both
// channels and the `workers.ts` barrel can pull from here without an import
// cycle. The barrel re-exports the public members so importers keep reading
// them from `./workers.js`.

import type { OriginPolicy } from "../policy/origin.js";

export type WorkerType = "web" | "service";
export type WorkerFilter = WorkerType | "all";

/** Whether the session's engine can reach service workers. Playwright exposes
 *  them on Chromium-based engines only (`context.serviceWorkers()`), so the
 *  façade refuses the `sw-*` family by this declaration, naming the engine. */
export interface ServiceWorkerAccess {
  engine: string;
  supported: boolean;
  /** The server's origin allow/block policy. A service worker whose script URL
   *  it does not allow is left out of the listing and refused for a send, the
   *  same policy `navigate` checks. Unset means no restriction. */
  originPolicy?: OriginPolicy;
}

export interface WorkerListing {
  workerId: string;
  type: WorkerType;
  url: string;
  /** Best-effort state. Web workers and service workers: always `"running"`
   *  (the browser doesn't expose Web Worker lifecycle, and Playwright only holds
   *  a service worker while its target is alive). */
  state?: string;
}

export interface WorkerMessage {
  workerId: string;
  /** Always serialised to a string for the ring; structured-clone payloads
   *  are `JSON.stringify`d on the page side (and silently truncated to the
   *  payload cap). Binary `MessagePort`s are not transferred. */
  data: string;
  /** epoch ms — fixed on receipt. */
  at: number;
}

export interface SwFetchInterceptSpec {
  /** Glob matched against the intercepted request URL. Same shape as
   *  `route` / `ws_intercept`. `*` = single path segment, `**` = any. */
  pattern: string;
  /** Canned response. `body` defaults to `""`. `contentType` defaults
   *  to `application/json`. `status` defaults to `200`. */
  response: {
    status?: number;
    body?: string;
    contentType?: string;
    headers?: Record<string, string>;
  };
}
