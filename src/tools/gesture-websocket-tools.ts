import { estimateTokens } from "../util/tokens.js";
import { SESSION_ARG } from "./schemas.js";
import type { RegisterHost, GateHost, SessionHost, ServerServicesHost } from "./host.js";

/**
 * Interactive WebSocket primitives: ws_send / ws_intercept / ws_unintercept — the
 * mutation half of the WS surface (the read-only view is `ws_read`). Split out of
 * `gesture-network-tools` by cohesive family (RFC 0004 P3 / D3 SRP); registered
 * through the shared `ToolHost` seam in the same source order.
 */
export function registerGestureWebsocketTools(
  host: RegisterHost & GateHost & SessionHost & ServerServicesHost,
): void {
  const { z, register, gateCheck, entryFor } = host;

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
      capability: "action",
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
      capability: "action",
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
      capability: "action",
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
}
