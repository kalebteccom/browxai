import { estimateTokens } from "../util/tokens.js";
import { SESSION_ARG } from "./schemas.js";
import type { RegisterHost, GateHost, SessionHost, ServerServicesHost } from "./host.js";
import { requirePage } from "../engine/index.js";

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
        "Send a payload on a live page WebSocket. `wsId` is the id from the page-side `__browxWs.list()` registry (the wrapper assigns `ws-1`, `ws-2`, and so on as the page opens sockets): call `ws_read` to find the endpoint URL, then `eval_js` (needs the `eval` capability) with `JSON.stringify(window.__browxWs.list())` to map URL to `wsId`; or rely on a known socket creation order. It calls the real `WebSocket.prototype.send`, so page listeners do not see a fake event and only the server sees the frame. Returns `{ok:true, wsId, url, bytes}`, or `{ok:false, error}` when the id is unknown or the socket is not OPEN.",
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
        const r = await e.wsInteractive.send(requirePage(e.session), { wsId, message });
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
        'Install a route-style interceptor for inbound WebSocket frames. `pattern` is a glob against `socket.url` (`*` is one segment, `**` is any). `response` sets what the page sees: `"drop"` discards the frame (page handlers do not run); `"echo"` mirrors the payload back to the server (the page still receives it); `{data:"<string>"}` replaces the payload. The interceptor runs on every matching frame until removed with `ws_unintercept`; adding the same pattern again replaces the earlier entry. Per session; lost when the session closes or is rebuilt.',
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
        const r = await e.wsInteractive.addInterceptor(requirePage(e.session), {
          pattern,
          response,
        });
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
        "Remove a `ws_intercept` interceptor by exact `pattern`, or every interceptor this session installed when `pattern` is omitted.",
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
          requirePage(e.session),
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
