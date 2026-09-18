// Scoped network route mocking — capability `action`.
//
// Race-condition QA needs to make backend responses arrive in a controlled
// (often out-of-request) order, or substitute a canned response. Rather than
// app-specific `eval_js` monkey-patching, this drives Playwright's own
// `page.route` interception, per-session and torn down with the session.
//
// `route` fulfils every match with one canned response (optional delay).
// `route_queue` fulfils successive matches from a list — each entry with its
// own delay, so e.g. response #2 (delay 0) can land before response #1
// (delay 400) — the exact "responses out of request order" failure class.

import type { Page, Route } from "playwright-core";
import type {
  RouteInstalled,
  RouteQueueSpec,
  RouteResponse,
  RouteSelector,
  RouteSpec,
  UnrouteResult,
} from "./route-types.js";

// The spec/result vocabulary is plain data and lives above this module, in
// `route-types.ts`, so `NetworkSubstrate.route` can name it without reaching
// playwright-core. Re-exported here because this is where every existing importer
// looks for it. (RFC 0009 P3.)
export type {
  RouteResponse,
  RouteSpec,
  RouteQueueSpec,
  RouteSelector,
  RouteInstalled,
  RouteRemoved,
  RouteRefusal,
  RouteResult,
  UnrouteResult,
} from "./route-types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_DELAY_MS = 60_000;

function keyOf(urlPattern: string, method?: string): string {
  return `${(method ?? "*").toUpperCase()} ${urlPattern}`;
}

async function fulfil(route: Route, r: RouteResponse): Promise<void> {
  if (r.delayMs && r.delayMs > 0) await sleep(Math.min(r.delayMs, MAX_DELAY_MS));
  await route.fulfill({
    status: r.status ?? 200,
    contentType: r.contentType ?? "application/json",
    body: r.body ?? "",
  });
}

/** Per-session registry of active route interceptions. Routes are also
 *  discarded when the session's browser context closes; this exists for
 *  `unroute` (mid-session clearing) and audit. */
export class RouteRegistry {
  private routes = new Map<string, { url: string; handler: (route: Route) => Promise<void> }>();

  /** Single canned response for every matching request. */
  async add(page: Page, spec: RouteSpec): Promise<{ key: string }> {
    const key = keyOf(spec.urlPattern, spec.method);
    await this.removeByKey(page, key); // replace any prior route on the same key
    const handler = async (route: Route): Promise<void> => {
      if (spec.method && route.request().method().toUpperCase() !== spec.method.toUpperCase()) {
        return route.fallback();
      }
      await fulfil(route, spec);
    };
    await page.route(spec.urlPattern, handler);
    this.routes.set(key, { url: spec.urlPattern, handler });
    return { key };
  }

  /** Successive matches consume successive responses; once the list is
   *  exhausted, matches fall through to the real network. */
  async addQueue(page: Page, spec: RouteQueueSpec): Promise<{ key: string; queued: number }> {
    const key = keyOf(spec.urlPattern, spec.method);
    await this.removeByKey(page, key);
    let i = 0;
    const handler = async (route: Route): Promise<void> => {
      if (spec.method && route.request().method().toUpperCase() !== spec.method.toUpperCase()) {
        return route.fallback();
      }
      const r = spec.responses[i++];
      if (!r) return route.fallback();
      await fulfil(route, r);
    };
    await page.route(spec.urlPattern, handler);
    this.routes.set(key, { url: spec.urlPattern, handler });
    return { key, queued: spec.responses.length };
  }

  private async removeByKey(page: Page, key: string): Promise<boolean> {
    const e = this.routes.get(key);
    if (!e) return false;
    await page.unroute(e.url, e.handler).catch(() => undefined);
    this.routes.delete(key);
    return true;
  }

  /** Remove one route (by urlPattern[+method]) or, when no pattern is given,
   *  every route this session registered. Returns the removed keys. */
  async remove(page: Page, sel: { urlPattern?: string; method?: string }): Promise<string[]> {
    if (!sel.urlPattern) {
      const all = [...this.routes.keys()];
      for (const k of all) await this.removeByKey(page, k);
      return all;
    }
    const key = keyOf(sel.urlPattern, sel.method);
    return (await this.removeByKey(page, key)) ? [key] : [];
  }

  list(): string[] {
    return [...this.routes.keys()];
  }
}

/** Install one interception and report the session's route list after it. The
 *  two bodies the `route` / `route_queue` handlers ran inline, lifted here so
 *  BOTH Playwright network substrates delegate to one copy instead of carrying
 *  the same eight lines twice. (RFC 0009 P3.) */
export async function installRoute(
  routes: RouteRegistry,
  page: Page,
  spec: RouteSpec | RouteQueueSpec,
): Promise<RouteInstalled> {
  if ("responses" in spec) {
    const r = await routes.addQueue(page, spec);
    return { kind: "installed", key: r.key, queued: r.queued, active: routes.list() };
  }
  const r = await routes.add(page, spec);
  return { kind: "installed", key: r.key, active: routes.list() };
}

/** Remove one interception (or all of this session's) and report what is left. */
export async function removeRoute(
  routes: RouteRegistry,
  page: Page,
  sel: RouteSelector,
): Promise<UnrouteResult> {
  const removed = await routes.remove(page, sel);
  return { kind: "removed", removed, active: routes.list() };
}
