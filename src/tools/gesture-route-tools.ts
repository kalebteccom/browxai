import { SESSION_ARG } from "./schemas.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ServerServicesHost,
  ToolResponse,
} from "./host.js";
import type { RouteResult, UnrouteResult } from "../page/network-substrate.js";

/**
 * Request route-mocking tools: route / route_queue / unroute. Per-session canned
 * responses for backend substitution + out-of-order arrival QA. Split out of
 * `gesture-network-tools` by cohesive family (RFC 0004 P3 / D3 SRP); registered
 * through the shared `ToolHost` seam in the same source order.
 *
 * All three go through `NetworkSubstrate` (RFC 0009 P3). They held a
 * `requirePage(e.session)` each, passed to a `RouteRegistry` on the session
 * entry; the registry moved INTO the substrate, because a route is a handler
 * installed on an engine handle and only the substrate holds one. They are also
 * gated on the `network` sub-interface now: interception is protocol-level
 * network work, and on an engine that declares none the old path surfaced
 * `requirePage`'s raw throw as `{ok:false, error}` — a shape indistinguishable
 * from "the route failed".
 */
export function registerGestureRouteTools(
  host: RegisterHost & GateHost & SessionHost & ServerServicesHost,
): void {
  const { z, register, gateCheck, subInterfaceGate, entryFor } = host;

  /** The one renderer for both outcomes. Success is the pre-seam body verbatim —
   *  `{ok:true, …, active}` — and a refusal is the shared engine-refusal envelope
   *  (`{ok, error, engine, hint}`), so a caller classifies "this engine cannot" by
   *  the same shape it does everywhere else. */
  const routeText = (r: RouteResult | UnrouteResult): ToolResponse => {
    const body =
      r.kind === "refusal"
        ? { ok: false, error: r.error, engine: r.engine, hint: r.hint }
        : r.kind === "installed"
          ? {
              ok: true,
              key: r.key,
              ...(r.queued !== undefined ? { queued: r.queued } : {}),
              active: r.active,
            }
          : { ok: true, removed: r.removed, active: r.active };
    return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
  };

  const errText = (err: unknown): ToolResponse => ({
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
  });

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
      capability: "action",
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
      const sg = subInterfaceGate("route", "network", e);
      if (sg) return sg;
      try {
        return routeText(
          await e.networkSubstrate.route({
            urlPattern,
            method,
            status,
            body,
            contentType,
            delayMs,
          }),
        );
      } catch (err) {
        return errText(err);
      }
    },
  );

  register(
    "route_queue",
    {
      capability: "action",
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
      const sg = subInterfaceGate("route_queue", "network", e);
      if (sg) return sg;
      try {
        return routeText(await e.networkSubstrate.route({ urlPattern, method, responses }));
      } catch (err) {
        return errText(err);
      }
    },
  );

  register(
    "unroute",
    {
      capability: "action",
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
      const sg = subInterfaceGate("unroute", "network", e);
      if (sg) return sg;
      try {
        return routeText(await e.networkSubstrate.unroute({ urlPattern, method }));
      } catch (err) {
        return errText(err);
      }
    },
  );
}
