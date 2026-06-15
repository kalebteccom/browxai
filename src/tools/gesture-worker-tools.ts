import { estimateTokens } from "../util/tokens.js";
import { requireCdp } from "../engine/session-cdp.js";
import { SESSION_ARG } from "./schemas.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ActionHost,
  ServerServicesHost,
} from "./host.js";

/**
 * Worker-visibility tools: workers_list / worker_message_send /
 * worker_messages_read / sw_intercept_fetch / sw_unintercept_fetch — make Web +
 * Service Workers (otherwise off-grid) observable and drivable. Split out of
 * `gesture-network-tools` by cohesive family (RFC 0004 P3 / D3 SRP); registered
 * through the shared `ToolHost` seam in the same source order.
 */
export function registerGestureWorkerTools(
  host: RegisterHost & GateHost & SessionHost & ActionHost & ServerServicesHost,
): void {
  const { z, register, gateCheck, engineGate, entryFor } = host;

  // ---- Workers visibility -----------------------------------------
  // Web Workers + Service Workers are invisible to the rest of the surface —
  // `network_read` shows page fetches; an SW that responds from its cache is
  // a silent participant. The Worker IPC channel (postMessage) is similarly
  // off-grid. This family makes both visible:
  //   • `workers_list`             — enumerate live workers (Web + SW)
  //   • `worker_message_send`      — postMessage to a worker (action)
  //   • `worker_messages_read`     — drain FROM-worker messages (read)
  //   • `sw_intercept_fetch`       — fulfil SW-handled requests (action)
  // Web Worker discovery uses a page-side `Worker` constructor wrapper (same
  // shape as the WS family); SW discovery uses CDP `Target.setAutoAttach` +
  // `ServiceWorker.enable` on the session's top-level CDP. See
  // src/page/workers.ts for the full design.

  register(
    "workers_list",
    {
      capability: "read",
      description:
        'Enumerate live workers in this session. Returns `[{workerId, type, url, state?}]` where `workerId` is a stable per-session id (`ww-N` for Web Workers, `sw-N` for Service Workers) the agent passes back to `worker_message_send` / `worker_messages_read`. `type` filters the list (`"web"`, `"service"`, or `"all"` — the default). Web Worker discovery requires the page-side wrapper to have been installed BEFORE the worker was constructed (eagerly done at session creation when `read` is on). Service Worker `state` is one of `stopped`/`starting`/`running`/`stopping`. Capability: `read`.',
      inputSchema: {
        type: z
          .enum(["web", "service", "all"])
          .optional()
          .describe('Filter by worker type. Default `"all"`.'),
        ...SESSION_ARG,
      },
    },
    async ({ type, session }) => {
      const g = gateCheck("workers_list");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const list = await e.workers.list(e.session.page(), requireCdp(e.session), type ?? "all");
        const body = { ok: true, workers: list, tokensEstimate: 0 };
        body.tokensEstimate = estimateTokens(JSON.stringify(body));
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        const body = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          tokensEstimate: 0,
        };
        body.tokensEstimate = estimateTokens(JSON.stringify(body));
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      }
    },
  );

  register(
    "worker_message_send",
    {
      capability: "action",
      description:
        "`postMessage` to a worker. `workerId` is the id from `workers_list` (`ww-N` for Web Workers, `sw-N` for Service Workers). For Web Workers, calls the real (unwrapped) `Worker.prototype.postMessage` so the worker's `onmessage` sees a real event — not a synthetic one. For Service Workers, dispatches a `MessageEvent` into the SW global via CDP `Runtime.evaluate` on the SW's attached session. Binary `MessagePort` transfer is not supported — `message` is a string. Capability: `action`.",
      inputSchema: {
        workerId: z.string().describe("Worker id from `workers_list`, e.g. `ww-1` or `sw-1`."),
        message: z
          .string()
          .describe(
            "Payload to send. Strings only — structured-clone / `MessagePort` transfer not supported in MVP.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ workerId, message, session }) => {
      const g = gateCheck("worker_message_send");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const r = await e.workers.sendMessage(e.session.page(), requireCdp(e.session), {
          workerId,
          message,
        });
        const body = { ...r, tokensEstimate: 0 };
        body.tokensEstimate = estimateTokens(JSON.stringify(body));
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        const body = {
          ok: false,
          workerId,
          error: err instanceof Error ? err.message : String(err),
          tokensEstimate: 0,
        };
        body.tokensEstimate = estimateTokens(JSON.stringify(body));
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      }
    },
  );

  register(
    "worker_messages_read",
    {
      capability: "read",
      description:
        "Drain buffered messages FROM workers since the last read. Returns `[{workerId, data, at}]`. `workerId` filters: omit to drain ALL workers; pass `ww-N` for one Web Worker, `sw-N` for one Service Worker. Each call drains (removes) the returned messages — re-reads return only what arrived since. The page-side ring is capped at 500 entries / 4 KiB per payload; entries past the cap are evicted oldest-first. Capability: `read`.",
      inputSchema: {
        workerId: z
          .string()
          .optional()
          .describe("Drain only this worker's messages. Omit to drain ALL workers."),
        ...SESSION_ARG,
      },
    },
    async ({ workerId, session }) => {
      const g = gateCheck("worker_messages_read");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const messages = await e.workers.readMessages(
          e.session.page(),
          workerId !== undefined ? { workerId } : {},
        );
        const body = { ok: true, messages, tokensEstimate: 0 };
        body.tokensEstimate = estimateTokens(JSON.stringify(body));
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        const body = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          tokensEstimate: 0,
        };
        body.tokensEstimate = estimateTokens(JSON.stringify(body));
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      }
    },
  );

  register(
    "sw_intercept_fetch",
    {
      capability: "action",
      deep: true,
      description:
        "Register a fetch interceptor for Service-Worker-handled requests. `pattern` is a glob matched against the intercepted request URL (`*` = single path segment, `**` = any — same shape as `route` / `ws_intercept`). `response` is the canned reply: `{status?, body?, contentType?, headers?}` (defaults: 200, empty body, `application/json`). Fires only when the SW's `fetch` handler actually runs — i.e. the SW chose to intercept the request — which separates SW-mediated traffic from page-direct traffic. Re-add of the same pattern replaces the prior entry. Per-session; lost on session close. Capability: `action`.",
      inputSchema: {
        pattern: z
          .string()
          .describe(
            "Glob matched against the intercepted request URL, e.g. `https://api.example/**`.",
          ),
        response: z
          .object({
            status: z.number().int().min(100).max(599).optional(),
            body: z.string().optional(),
            contentType: z.string().optional(),
            headers: z.record(z.string()).optional(),
          })
          .describe(
            'Canned response. Defaults: status 200, body "", contentType application/json.',
          ),
        ...SESSION_ARG,
      },
    },
    async ({ pattern, response, session }) => {
      const g = gateCheck("sw_intercept_fetch");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("sw_intercept_fetch", e);
      if (eg) return eg;
      try {
        const r = await e.workers.addFetchIntercept(requireCdp(e.session), { pattern, response });
        const body = { ok: true, ...r, tokensEstimate: 0 };
        body.tokensEstimate = estimateTokens(JSON.stringify(body));
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        const body = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          tokensEstimate: 0,
        };
        body.tokensEstimate = estimateTokens(JSON.stringify(body));
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      }
    },
  );

  register(
    "sw_unintercept_fetch",
    {
      capability: "action",
      deep: true,
      description:
        "Remove a `sw_intercept_fetch` interceptor (by exact `pattern`), or — with no `pattern` — every SW fetch interceptor this session installed. Capability: `action`.",
      inputSchema: {
        pattern: z
          .string()
          .optional()
          .describe("Omit to clear ALL of this session's SW fetch interceptors."),
        ...SESSION_ARG,
      },
    },
    async ({ pattern, session }) => {
      const g = gateCheck("sw_unintercept_fetch");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("sw_unintercept_fetch", e);
      if (eg) return eg;
      try {
        const r = await e.workers.removeFetchIntercept(
          requireCdp(e.session),
          pattern !== undefined ? { pattern } : {},
        );
        const body = { ok: true, ...r, tokensEstimate: 0 };
        body.tokensEstimate = estimateTokens(JSON.stringify(body));
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        const body = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          tokensEstimate: 0,
        };
        body.tokensEstimate = estimateTokens(JSON.stringify(body));
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      }
    },
  );
}
