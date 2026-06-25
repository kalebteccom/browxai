// Shared shapes for the Workers façade and its two transport channels
// (`workers-page.ts` for Web Workers, `workers-sw.ts` for Service Workers).
// Engine-blind DOMAIN types only — no CDP/Playwright imports — so both
// channels and the `workers.ts` barrel can pull from here without an import
// cycle. The barrel re-exports the public members so importers keep reading
// them from `./workers.js`.

export type WorkerType = "web" | "service";
export type WorkerFilter = WorkerType | "all";

export interface WorkerListing {
  workerId: string;
  type: WorkerType;
  url: string;
  /** Best-effort state. Web workers: always `"running"` (browser doesn't
   *  expose lifecycle once they're constructed). Service workers: the CDP
   *  `running_status` (`stopped` / `starting` / `running` / `stopping`). */
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
