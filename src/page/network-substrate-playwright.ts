// PlaywrightNetworkSubstrate — the firefox / webkit NetworkSubstrate: the
// Playwright context-event network path. No CDP. The session-wide rings are
// `PlaywrightNetworkBuffer` / `PlaywrightWsBuffer` (the same ring shapes, fed by
// `context.on('request'|'response'|'requestfailed')` and `page.on('websocket')`).
// The per-action tap is the Playwright-event `PlaywrightNetworkTap`, and
// `fetchBody` reads from the body cache the buffer captured at response time
// (unlike CDP `Network.getResponseBody`, there is no after-the-fact body fetch
// off Chromium).
//
// Documented degradation off Chromium (honest, not a regression):
//   - resourceType nuance: Playwright `request.resourceType()` is lowercase and a
//     slightly coarser taxonomy than CDP's; mapped to the CDP-capitalised bucket
//     names so the noise-folding + `byType` summary stay identical in shape.
//   - timing precision: `ms` is wall-clock (request-seen → response-seen), the
//     same approximation the CDP tap uses — no high-resolution `timing()` deltas.
//   - body availability: bodies are captured at response time into a bounded LRU
//     keyed by a synthetic request id; a body for a request that predates the
//     capture window (or was evicted) is reported "not available", same best-
//     effort contract as the CDP renderer-discard behaviour.
//
// Dependency direction (architecture doctrine §1): tools / action-window →
// NetworkSubstrate (the port in `network-substrate-types.ts`) → this
// implementation → Playwright events. This file never imports back from the
// `network-substrate.js` barrel.

import type { BrowserContext, Page } from "playwright-core";
import type { SecretRegistry } from "../util/secrets.js";
// RFC 0004 P4 / D10 — the off-Chromium Playwright network classes are imported
// DIRECTLY from their defining module, not re-exported through the `network.js`
// barrel. The barrel re-export was a genuine RUNTIME cycle
// (`network.ts` -> `network-playwright.ts` -> `network.ts`); routing this sole
// runtime consumer to the source module breaks it so the no-circular rule is
// clean at `error`.
import {
  PlaywrightNetworkBuffer,
  PlaywrightWsBuffer,
  PlaywrightNetworkTap,
} from "./network-playwright.js";
import { RouteRegistry, installRoute, removeRoute } from "./routes.js";
import type {
  ActionNetworkTap,
  FetchBodyResult,
  NetworkSubstrate,
} from "./network-substrate-types.js";
import type {
  RouteQueueSpec,
  RouteResult,
  RouteSelector,
  RouteSpec,
  UnrouteResult,
} from "./route-types.js";

/** Firefox / WebKit substrate — the Playwright context-event network path. No
 *  CDP. The session-wide rings are `PlaywrightNetworkBuffer` / `PlaywrightWsBuffer`
 *  (the same ring shapes, fed by `context.on('request'|'response'|'requestfailed')`
 *  and `page.on('websocket')`). The per-action tap is the Playwright-event
 *  `PlaywrightNetworkTap`, and `fetchBody` reads from the body cache the buffer
 *  captured at response time. */
export class PlaywrightNetworkSubstrate implements NetworkSubstrate {
  readonly engine: string;
  readonly http: PlaywrightNetworkBuffer;
  readonly ws: PlaywrightWsBuffer;
  private secrets: SecretRegistry | null = null;
  /** The session's live interceptions — owned here for the reason the CDP
   *  sibling owns its own: a route is a handler installed on this substrate's
   *  engine handle. */
  private readonly routes = new RouteRegistry();
  private readonly page: Page;

  constructor(
    private readonly context: BrowserContext,
    page: Page,
    engine = "firefox",
  ) {
    this.engine = engine;
    this.page = page;
    this.http = new PlaywrightNetworkBuffer(context);
    this.ws = new PlaywrightWsBuffer(page);
  }

  async attach(): Promise<void> {
    await this.http.attach();
    await this.ws.attach();
  }

  setSecrets(secrets: SecretRegistry): void {
    this.secrets = secrets;
    this.http.setSecrets(secrets);
    this.ws.setSecrets(secrets);
  }

  openActionTap(): ActionNetworkTap {
    return new PlaywrightNetworkTap(this.context, this.secrets);
  }

  async fetchBody(requestId: string, secrets: SecretRegistry | null): Promise<FetchBodyResult> {
    return this.http.fetchBody(requestId, secrets);
  }

  /** `page.route` — the verbatim body the `route` / `route_queue` handlers ran,
   *  and the same one the CDP sibling delegates to. Interception is Playwright's
   *  cross-engine primitive, so firefox and webkit have always had it. */
  async route(spec: RouteSpec | RouteQueueSpec): Promise<RouteResult> {
    return installRoute(this.routes, this.page, spec);
  }

  async unroute(sel: RouteSelector): Promise<UnrouteResult> {
    return removeRoute(this.routes, this.page, sel);
  }
}
