import { withDeadline } from "../util/deadline.js";
import { estimateTokens } from "../util/tokens.js";
import { mouseWheel, gesturePinch, gestureSwipe } from "../page/gestures.js";
import { requireCdp } from "../engine/session-cdp.js";
import { SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

/**
 * Coordinate-space gestures (mouse_wheel / gesture_pinch / gesture_swipe),
 * route mocking (route / route_queue / unroute), interactive WebSocket
 * primitives (ws_send / ws_intercept / ws_unintercept), worker visibility
 * (workers_list / worker_message_send / worker_messages_read /
 * sw_intercept_fetch / sw_unintercept_fetch), and live network/CPU emulation
 * (network_emulate / cpu_emulate). Every block is registered through the shared
 * `ToolHost` seam; the host owns the closures (gate, engine-gate, entry), this
 * module owns the registrations.
 */
export function registerGestureNetworkTools(host: ToolHost): void {
  const { z, register, gateCheck, engineGate, entryFor, cfgActionTimeout } = host;

  register(
    "mouse_wheel",
    {
      description:
        "Coordinate-space wheel event — dispatched via CDP at `coords` (viewport CSS px) regardless of the current pointer position. For canvas, virtualised lists, and map tiles that listen for `wheel` and ignore element-level scroll. `deltaX`/`deltaY` are CSS px (DOM `WheelEvent` convention: positive `deltaY` scrolls content up); at least one must be non-zero.",
      inputSchema: {
        coords: z
          .object({ x: z.number(), y: z.number() })
          .describe("Viewport CSS px — where the wheel event fires."),
        deltaX: z.number().optional().describe("Horizontal wheel delta in CSS px (default 0)."),
        deltaY: z.number().optional().describe("Vertical wheel delta in CSS px (default 0)."),
        ...SESSION_ARG,
      },
    },
    async ({ coords, deltaX, deltaY, session }) => {
      const g = gateCheck("mouse_wheel");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("mouse_wheel", e);
      if (eg) return eg;
      try {
        const r = await withDeadline(
          mouseWheel(requireCdp(e.session), { coords, deltaX, deltaY }),
          cfgActionTimeout(),
          "mouse_wheel",
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  register(
    "gesture_pinch",
    {
      description:
        "Two-finger pinch in/out centred on `coords`. Two touch points start at `coords ± startOffset` (default 40 CSS px) and converge or diverge linearly so the final separation = `startOffset × scale`. `scale < 1` is pinch-in (zoom out); `scale > 1` is pinch-out (zoom in). Linear interpolation across `steps` (default 12, clamped 1–100) — pinch handlers read inter-frame deltas; a velocity-detecting curve can misfire fling heuristics, linear is the safe default. Dispatches via CDP touch pipeline; touch does not fire mouse events automatically.",
      inputSchema: {
        coords: z
          .object({ x: z.number(), y: z.number() })
          .describe("Pinch centre, viewport CSS px."),
        scale: z
          .number()
          .positive()
          .describe(
            "Final separation / initial separation. <1 = pinch-in (zoom out); >1 = pinch-out (zoom in).",
          ),
        steps: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Intermediate touchMove dispatches (default 12)."),
        startOffset: z
          .number()
          .positive()
          .optional()
          .describe("Initial half-separation in CSS px (default 40)."),
        ...SESSION_ARG,
      },
    },
    async ({ coords, scale, steps, startOffset, session }) => {
      const g = gateCheck("gesture_pinch");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("gesture_pinch", e);
      if (eg) return eg;
      try {
        const r = await withDeadline(
          gesturePinch(requireCdp(e.session), { coords, scale, steps, startOffset }),
          cfgActionTimeout(),
          "gesture_pinch",
        );
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  register(
    "gesture_swipe",
    {
      description:
        "Single-finger swipe from `from` to `to` via the touch pipeline. Distinct from `drag` (mouse pipeline) — mobile carousels, pull-to-refresh, swipeable list items wire touch handlers that ignore mouse events. `durationMs` (default 200 — fast flick; 500+ reads as deliberate scroll) is split across `steps` (default 16, clamped 1–200) touchMove dispatches. Smoothed via an ease-out curve (`1 - (1 - t)²`) — matches the natural deceleration most fling-detect heuristics are tuned for (Hammer.js, native scroll inertia, react-spring physics).",
      inputSchema: {
        from: z.object({ x: z.number(), y: z.number() }).describe("Swipe start, viewport CSS px."),
        to: z.object({ x: z.number(), y: z.number() }).describe("Swipe end, viewport CSS px."),
        durationMs: z
          .number()
          .int()
          .nonnegative()
          .max(60_000)
          .optional()
          .describe("Total swipe duration in ms (default 200)."),
        steps: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("Intermediate touchMove dispatches (default 16)."),
        identifier: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Touch identifier (default 1)."),
        ...SESSION_ARG,
      },
    },
    async ({ from, to, durationMs, steps, identifier, session }) => {
      const g = gateCheck("gesture_swipe");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("gesture_swipe", e);
      if (eg) return eg;
      try {
        const r = await withDeadline(
          gestureSwipe(requireCdp(e.session), { from, to, durationMs, steps, identifier }),
          cfgActionTimeout(),
          "gesture_swipe",
        );
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  const ROUTE_RESPONSE = {
    status: z.number().int().optional().describe("HTTP status (default 200)."),
    body: z.string().optional().describe("Response body (default empty)."),
    contentType: z.string().optional().describe("Content-Type (default application/json)."),
    delayMs: z
      .number()
      .int()
      .nonnegative()
      .max(60_000)
      .optional()
      .describe("Delay before fulfilling (ms). Use to control arrival order."),
  };

  register(
    "route",
    {
      description:
        "Intercept requests matching `urlPattern` (Playwright glob) and fulfil every match with one canned response. For substituting a backend response in QA. Per-session; discarded with the session or via `unroute`.",
      inputSchema: {
        urlPattern: z.string().describe("Playwright URL glob, e.g. `**/api/records*`."),
        method: z
          .string()
          .optional()
          .describe(
            "Restrict to this HTTP method; other methods fall through to the real network.",
          ),
        ...ROUTE_RESPONSE,
        ...SESSION_ARG,
      },
    },
    async ({ urlPattern, method, status, body, contentType, delayMs, session }) => {
      const g = gateCheck("route");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const r = await e.routes.add(e.session.page(), {
          urlPattern,
          method,
          status,
          body,
          contentType,
          delayMs,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: true, ...r, active: e.routes.list() }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  register(
    "route_queue",
    {
      description:
        "Intercept `urlPattern` and fulfil *successive* matches from `responses[]` (one per request, in order); once exhausted, matches fall through to the real network. Each response carries its own `delayMs` — give response #1 a long delay and #2 a short one to make backend responses **arrive out of request order** (the race-condition QA case). Per-session.",
      inputSchema: {
        urlPattern: z.string().describe("Playwright URL glob."),
        method: z.string().optional(),
        responses: z
          .array(z.object(ROUTE_RESPONSE))
          .min(1)
          .describe("Consumed one per matching request, in order."),
        ...SESSION_ARG,
      },
    },
    async ({ urlPattern, method, responses, session }) => {
      const g = gateCheck("route_queue");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const r = await e.routes.addQueue(e.session.page(), { urlPattern, method, responses });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: true, ...r, active: e.routes.list() }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  register(
    "unroute",
    {
      description:
        "Remove a route registered by `route`/`route_queue` (by `urlPattern`[+`method`]), or — with no `urlPattern` — every route this session registered.",
      inputSchema: {
        urlPattern: z.string().optional().describe("Omit to clear ALL of this session's routes."),
        method: z.string().optional(),
        ...SESSION_ARG,
      },
    },
    async ({ urlPattern, method, session }) => {
      const g = gateCheck("unroute");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const removed = await e.routes.remove(e.session.page(), { urlPattern, method });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: true, removed, active: e.routes.list() }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // ---- Interactive WebSocket primitives (capability `action`) ----------------
  // The read-only WS view is `ws_read` / `ActionResult.network.wsFrames`; this
  // family is the mutation half — `ws_send` pushes a frame on a live page-side
  // socket, `ws_intercept` rewrites/drops inbound frames before app handlers
  // see them. Both engage by lazily installing a page-side `WebSocket` wrapper
  // on first call (`addInitScript` for future docs + `evaluate` for the live
  // doc). Active interceptors mirror onto a per-session registry; `unintercept`
  // can target one pattern or clear them all. See src/page/ws-interactive.ts.

  register(
    "ws_send",
    {
      description:
        "Send a payload on a live page-side WebSocket. `wsId` is the id surfaced by the page-side `__browxWs.list()` registry (the wrapper assigns `ws-1`, `ws-2`, … as the page opens sockets) — call `ws_read` first to identify the endpoint URL, then `eval_js` `JSON.stringify(window.__browxWs.list())` to map URL → wsId, OR drive a deterministic test where the order of socket creation is known. Calls the real (unwrapped) `WebSocket.prototype.send`, so app-level message listeners do NOT observe a fake event — only the server sees the outbound frame. Returns `{ok:true, wsId, url, bytes}` on success, or `{ok:false, error}` if the id is unknown or the socket isn't OPEN. Capability: `action`.",
      inputSchema: {
        wsId: z.string().describe("Page-side socket id, e.g. `ws-1`. See `__browxWs.list()`."),
        message: z
          .string()
          .describe("Payload to send. Binary frames are not supported in MVP — send as text."),
        ...SESSION_ARG,
      },
    },
    async ({ wsId, message, session }) => {
      const g = gateCheck("ws_send");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const r = await e.wsInteractive.send(e.session.page(), { wsId, message });
        const body = { ...r, tokensEstimate: 0 };
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
    "ws_intercept",
    {
      description:
        'Install a route-style interceptor for INBOUND WebSocket frames. `pattern` is a glob matched against `socket.url` (the route family\'s intent: `*` = single segment, `**` = any). `response` controls what the page sees: `"drop"` — silently discard the frame (app handlers don\'t run); `"echo"` — mirror the inbound payload back to the server (the app still receives it locally); `{data:"<string>"}` — replace the inbound payload with `data` (app handlers see the replacement). The interceptor evaluates on every matching frame until removed via `ws_unintercept`; re-adding the same pattern replaces the prior entry. Per-session; lost on session close or session rebuild. Capability: `action`.',
      inputSchema: {
        pattern: z
          .string()
          .describe("Glob matched against `socket.url`, e.g. `wss://chat.example/**`."),
        response: z
          .union([
            z.literal("drop"),
            z.literal("echo"),
            z.object({
              data: z
                .string()
                .describe(
                  "Replacement payload delivered to app handlers in place of the original.",
                ),
            }),
          ])
          .describe('`drop`, `echo`, or `{data: "…"}`.'),
        ...SESSION_ARG,
      },
    },
    async ({ pattern, response, session }) => {
      const g = gateCheck("ws_intercept");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const r = await e.wsInteractive.addInterceptor(e.session.page(), { pattern, response });
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
    "ws_unintercept",
    {
      description:
        "Remove a `ws_intercept` interceptor (by exact `pattern`), or — with no `pattern` — every interceptor this session installed. Capability: `action`.",
      inputSchema: {
        pattern: z
          .string()
          .optional()
          .describe("Omit to clear ALL of this session's WS interceptors."),
        ...SESSION_ARG,
      },
    },
    async ({ pattern, session }) => {
      const g = gateCheck("ws_unintercept");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const r = await e.wsInteractive.removeInterceptor(
          e.session.page(),
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

  register(
    "network_emulate",
    {
      description:
        "Throttle the session's network conditions (or simulate offline) via CDP `Network.emulateNetworkConditions`. For flaky-mobile / offline / slow-link repros on a real backend; **composes** with `route_queue` — each route's `delayMs` stacks ON TOP of the emulated `latencyMs`. Per-session; persists across navigation (re-applied on main-frame nav in case CDP drops it on a renderer swap). Empty input (or `{offline:false}` with no other fields) resets to no throttle. **BYOB:** the override applies to the attached Chrome and stays in effect even after browxai detaches, until the human resets DevTools or closes the page (a `warning` field surfaces this).",
      inputSchema: {
        offline: z
          .boolean()
          .optional()
          .describe(
            "If true, all network traffic from the page fails as offline. Wins over latency / bps.",
          ),
        latencyMs: z
          .number()
          .int()
          .nonnegative()
          .max(600_000)
          .optional()
          .describe(
            "One-way latency in ms. CDP doubles it for round-trip; route_queue delayMs stacks on top.",
          ),
        downloadBps: z
          .number()
          .nonnegative()
          .max(10_000_000_000)
          .optional()
          .describe("Max download throughput, bytes/sec. 0 / unset = unthrottled."),
        uploadBps: z
          .number()
          .nonnegative()
          .max(10_000_000_000)
          .optional()
          .describe("Max upload throughput, bytes/sec. 0 / unset = unthrottled."),
        packetLoss: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Hint, 0..1. Most Chromium builds ignore it; pass for documentation."),
        ...SESSION_ARG,
      },
    },
    async ({ offline, latencyMs, downloadBps, uploadBps, packetLoss, session }) => {
      const g = gateCheck("network_emulate");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("network_emulate", e);
      if (eg) return eg;
      try {
        const { state, reset } = await e.emulation.applyNetwork(
          requireCdp(e.session),
          e.session.page(),
          {
            offline,
            latencyMs,
            downloadBps,
            uploadBps,
            packetLoss,
          },
        );
        const body: Record<string, unknown> = { ok: true, applied: state, reset };
        if (e.mode === "attached") {
          body.warning =
            "BYOB / attached Chrome: this network override stays in effect on the attached browser even after browxai detaches — reset it (call again with empty args) or close the page when you're done.";
        }
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      }
    },
  );

  register(
    "cpu_emulate",
    {
      description:
        "Slow the renderer to simulate a low-end device via CDP `Emulation.setCPUThrottlingRate`. `throttleRate: 1` = no throttle (and is the reset path); `2` = 2× slowdown; `4`–`6` = mid-to-low-end mobile. Per-session; persists across navigation (re-applied on main-frame nav in case CDP drops it). Empty input resets to `1`. Independent of `network_emulate` — apply both for a full low-end-device repro. **BYOB:** the throttle stays in effect on the attached Chrome until reset or page close (`warning` surfaces this).",
      inputSchema: {
        throttleRate: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("CPU slowdown multiplier. 1 = none (reset). 2 = 2×. 4–6 = low-end mobile."),
        ...SESSION_ARG,
      },
    },
    async ({ throttleRate, session }) => {
      const g = gateCheck("cpu_emulate");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("cpu_emulate", e);
      if (eg) return eg;
      try {
        const { state, reset } = await e.emulation.applyCpu(
          requireCdp(e.session),
          e.session.page(),
          {
            throttleRate,
          },
        );
        const body: Record<string, unknown> = { ok: true, applied: state, reset };
        if (e.mode === "attached") {
          body.warning =
            "BYOB / attached Chrome: this CPU throttle stays in effect on the attached browser even after browxai detaches — reset it (call again with no args / throttleRate:1) or close the page when you're done.";
        }
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      }
    },
  );
}
