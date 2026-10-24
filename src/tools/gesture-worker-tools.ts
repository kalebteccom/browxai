import { estimateTokens } from "../util/tokens.js";
import { requireCdp } from "../engine/session-cdp.js";
import { SESSION_ARG } from "./schemas.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ActionHost,
  ServerServicesHost,
  EgressHost,
} from "./host.js";
import { engineDeclaration, requirePage } from "../engine/index.js";
import type { ServiceWorkerAccess } from "../page/workers.js";
import type { SessionEntry } from "../session/registry.js";
import type { OriginPolicy } from "../policy/origin.js";

/** Whether this session's engine can reach service workers. Playwright exposes
 *  them (`context.serviceWorkers()`) on the engines that declare the raw-CDP
 *  `deep` capability, which is every Chromium-based one. Read from the engine's
 *  declaration, so a new Chromium-based engine needs no edit here. */
function swAccessFor(e: SessionEntry, originPolicy: OriginPolicy): ServiceWorkerAccess {
  return {
    engine: e.session.engine,
    supported: engineDeclaration(e.session.engine)?.deep === true,
    originPolicy,
  };
}

/**
 * Worker-visibility tools: workers_list / worker_message_send /
 * worker_messages_read / sw_intercept_fetch / sw_unintercept_fetch — make Web +
 * Service Workers (otherwise off-grid) observable and drivable. Split out of
 * `gesture-network-tools` by cohesive family (RFC 0004 P3 / D3 SRP); registered
 * through the shared `ToolHost` seam in the same source order.
 */
export function registerGestureWorkerTools(
  host: RegisterHost & GateHost & SessionHost & ActionHost & ServerServicesHost & EgressHost,
): void {
  const { z, register, gateCheck, engineGate, entryFor, egressFor } = host;

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
  // shape as the WS family); SW listing and messaging use Playwright's
  // `context.serviceWorkers()` and `Worker.evaluate` (Chromium-based engines
  // only), while SW fetch interception uses CDP `Target.setAutoAttach` +
  // `ServiceWorker.enable` on the session's top-level CDP. See
  // src/page/workers.ts for the full design.

  register(
    "workers_list",
    {
      capability: "read",
      description:
        'List the workers in this session: `[{workerId, type, url, state?}]`. `workerId` is stable per session (`ww-N` for Web Workers, `sw-N` for Service Workers) and goes to `worker_message_send` and `worker_messages_read`. `type` filters: `"web"`, `"service"` or `"all"` (default). Web Workers are found only if the page-side wrapper was installed before the worker was constructed (done at session creation when `read` is on). Service Workers come from `context.serviceWorkers()` (Chromium-based engines only; a live one has `state` `running`, and a Service Worker that has stopped keeps its id with `state` `stopped`); on another engine `type:"service"` returns an error naming the engine and `"all"` lists Web Workers only. A Service Worker on an origin the origin rules do not allow is left out.',
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
        const list = await e.workers.list(
          requirePage(e.session),
          swAccessFor(e, host.confirmCtxFor(e).policy),
          type ?? "all",
        );
        // Worker script URLs are page-controlled and can carry a registered value.
        const body = { ok: true, workers: egressFor(e).maskDeep(list), tokensEstimate: 0 };
        body.tokensEstimate = estimateTokens(JSON.stringify(body));
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        const body = {
          ok: false,
          error: egressFor(e).maskDeep(err instanceof Error ? err.message : String(err)),
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
        "`postMessage` to a worker. `workerId` comes from `workers_list` (`ww-N` Web Worker, `sw-N` Service Worker). For Web Workers it calls the real `Worker.prototype.postMessage`, so `onmessage` sees a real event. For Service Workers it dispatches a synthetic `MessageEvent` into the worker global with Playwright's `Worker.evaluate`, so `self.onmessage` and `message` listeners fire; the event has no `source`, so a worker that replies should use `clients.matchAll({includeUncontrolled:true})`, and the reply arrives through `worker_messages_read`. Service Workers need a Chromium-based engine (elsewhere the call returns an error naming the engine). A Service Worker on an origin the origin rules do not allow is refused with `origin-blocked`. `message` is a string; binary `MessagePort` transfer is not supported.",
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
        const r = await e.workers.sendMessage(
          requirePage(e.session),
          swAccessFor(e, host.confirmCtxFor(e).policy),
          {
            workerId,
            message,
          },
        );
        // A failed send echoes the page's error message.
        const body = { ...egressFor(e).maskDeep(r), tokensEstimate: 0 };
        body.tokensEstimate = estimateTokens(JSON.stringify(body));
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        const body = {
          ok: false,
          workerId,
          error: egressFor(e).maskDeep(err instanceof Error ? err.message : String(err)),
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
        "Drain the messages buffered from workers since the last read: `[{workerId, data, at}]`. `workerId` filters: omit it to drain every worker, `ww-N` for one Web Worker, `sw-N` for one Service Worker. A Service Worker's messages are the ones it posts to this page with `client.postMessage`, recorded from the page's `navigator.serviceWorker` `message` events under the `sw-N` id `workers_list` gives that script URL; they are seen only if the page had this tool's wrapper installed before the message arrived. Each call removes what it returns. Each ring holds 500 entries of up to 4 KiB; older entries are evicted first. Message data comes from the page and is untrusted, like page text.",
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
          requirePage(e.session),
          workerId !== undefined ? { workerId } : {},
          swAccessFor(e, host.confirmCtxFor(e).policy),
        );
        // Message data is whatever the worker posted, so it is masked like `ws_read` frames.
        const body = { ok: true, messages: egressFor(e).maskDeep(messages), tokensEstimate: 0 };
        body.tokensEstimate = estimateTokens(JSON.stringify(body));
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        const body = {
          ok: false,
          error: egressFor(e).maskDeep(err instanceof Error ? err.message : String(err)),
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
        "Register a fetch interceptor for requests a Service Worker handles. `pattern` is a glob against the request URL (`*` is one path segment, `**` is any, as in `route` and `ws_intercept`). `response` is the canned reply `{status?, body?, contentType?, headers?}` (defaults: 200, empty body, `application/json`). It fires only when the worker's `fetch` handler runs, which separates worker-mediated traffic from page-direct traffic. Adding the same pattern again replaces the earlier entry. Per session; lost when the session closes.",
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
            headers: z.record(z.string(), z.string()).optional(),
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
        "Remove a `sw_intercept_fetch` interceptor by exact `pattern`, or every one this session installed when `pattern` is omitted.",
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
