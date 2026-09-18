// The request-interception vocabulary the NetworkSubstrate port declares.
//
// Split out of `routes.ts` for the reason `actions-types.ts` was split out of
// `actions.ts` in RFC 0009 P1: `routes.ts` imports `Page` and `Route` and calls
// `page.route`, so it is the Playwright adapter body, and `NetworkSubstrate.route`
// names these shapes. They are plain data — two strings, four optional response
// fields, an array — so they live where the port can reach them without reaching
// playwright-core. `routes.ts` re-exports every name, so existing importers are
// unchanged. (RFC 0009 P3.)

export interface RouteResponse {
  status?: number;
  body?: string;
  contentType?: string;
  delayMs?: number;
}

export interface RouteSpec extends RouteResponse {
  urlPattern: string;
  method?: string;
}

export interface RouteQueueSpec {
  urlPattern: string;
  method?: string;
  responses: RouteResponse[];
}

/** What `unroute` selects. No `urlPattern` means every route this session
 *  registered. */
export interface RouteSelector {
  urlPattern?: string;
  method?: string;
}

/** A route is installed. `queued` is present only for the queue form, carrying
 *  how many canned responses were accepted. `active` is the session's full route
 *  list after the install — the same list the handler rendered off
 *  `e.routes.list()`. */
export interface RouteInstalled {
  kind: "installed";
  key: string;
  queued?: number;
  active: string[];
}

/** Routes were removed. `removed` is the keys that went, `active` what is left. */
export interface RouteRemoved {
  kind: "removed";
  removed: string[];
  active: string[];
}

/** This engine intercepts no requests. Carries the three fields the shared
 *  engine-refusal envelope renders, so "this engine cannot" is one shape however
 *  it was reached. */
export interface RouteRefusal {
  kind: "refusal";
  error: string;
  engine: string;
  hint: string;
}

export type RouteResult = RouteInstalled | RouteRefusal;
export type UnrouteResult = RouteRemoved | RouteRefusal;

/** The named refusal reason for interception on an engine with no route surface.
 *  Greppable, and the thing a test asserts on instead of prose. */
export const ROUTE_ENGINE_REFUSAL = "route-needs-interception";

/** Structured refusal for `route` / `route_queue` / `unroute` on an engine that
 *  cannot intercept. Reached only if the `network` sub-interface gate in the
 *  handler is ever removed — the gate refuses upstream, where it can say the
 *  check was never performed, and this is the layer beneath it that keeps the
 *  port from being present-but-throwing (the L5 violation). */
export function routeInterceptionUnsupported(tool: string, engine: string): RouteRefusal {
  return {
    kind: "refusal",
    error: `tool "${tool}" is not supported on the "${engine}" engine`,
    engine,
    hint:
      `${ROUTE_ENGINE_REFUSAL}: request interception needs a protocol-level route surface, and ` +
      `the "${engine}" engine has none — it declares no \`network\` sub-interface. Re-run on a ` +
      "chromium, firefox or webkit session, or check the per-engine capability matrix in " +
      "docs/ai-context/architecture/engine-adapters.md.",
  };
}
