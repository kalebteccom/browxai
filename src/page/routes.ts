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
//
// Both answer data and static requests only (`fulfil-policy.ts`). A matching
// document, script or worker request goes to the real network and is counted
// per route, unless the spec carries `allowExecutable`.

import type { Page, Route } from "playwright-core";
import { isDataResourceType } from "./fulfil-policy.js";
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

interface ActiveRoute {
  url: string;
  handler: (route: Route) => Promise<void>;
  /** Matches this route left to the real network because their resource type
   *  is one the page runs and the spec did not carry `allowExecutable`. */
  skippedExecutable: number;
}

/** What `add` / `addQueue` report. `replacedSkipped` is the skip count of a
 *  route this install replaced on the same key, when it had any. */
interface AddResult {
  key: string;
  replacedSkipped: number;
}

/** Per-session registry of active route interceptions. Routes are also
 *  discarded when the session's browser context closes; this exists for
 *  `unroute` (mid-session clearing) and audit. */
export class RouteRegistry {
  private routes = new Map<string, ActiveRoute>();

  /** Install `respond` behind the two checks every route shares: the optional
   *  method filter, then the resource-type rule. `respond` runs only for a
   *  request the route may answer, so a queue consumes no entry on a skip. */
  private async install(
    page: Page,
    spec: RouteSpec | RouteQueueSpec,
    respond: (route: Route) => Promise<void>,
  ): Promise<AddResult> {
    const key = keyOf(spec.urlPattern, spec.method);
    // Replace any prior route on the same key.
    const replacedSkipped = await this.removeByKey(page, key);
    const entry: ActiveRoute = {
      url: spec.urlPattern,
      skippedExecutable: 0,
      handler: async (route: Route): Promise<void> => {
        const request = route.request();
        if (spec.method && request.method().toUpperCase() !== spec.method.toUpperCase()) {
          return route.fallback();
        }
        if (!spec.allowExecutable && !isDataResourceType(request.resourceType())) {
          entry.skippedExecutable++;
          return route.fallback();
        }
        await respond(route);
      },
    };
    await page.route(spec.urlPattern, entry.handler);
    this.routes.set(key, entry);
    return { key, replacedSkipped: replacedSkipped ?? 0 };
  }

  /** Single canned response for every matching request. */
  async add(page: Page, spec: RouteSpec): Promise<AddResult> {
    return this.install(page, spec, (route) => fulfil(route, spec));
  }

  /** Successive matches consume successive responses; once the list is
   *  exhausted, matches fall through to the real network. */
  async addQueue(page: Page, spec: RouteQueueSpec): Promise<AddResult & { queued: number }> {
    let i = 0;
    const r = await this.install(page, spec, async (route) => {
      const next = spec.responses[i++];
      if (!next) return route.fallback();
      await fulfil(route, next);
    });
    return { ...r, queued: spec.responses.length };
  }

  /** Remove the route on `key`. Returns its skip count, or undefined when no
   *  route was registered there. */
  private async removeByKey(page: Page, key: string): Promise<number | undefined> {
    const e = this.routes.get(key);
    if (!e) return undefined;
    await page.unroute(e.url, e.handler).catch(() => undefined);
    this.routes.delete(key);
    return e.skippedExecutable;
  }

  /** Remove one route (by urlPattern[+method]) or, when no pattern is given,
   *  every route this session registered. Returns the removed keys and the
   *  skip count summed over them. */
  async remove(
    page: Page,
    sel: { urlPattern?: string; method?: string },
  ): Promise<{ removed: string[]; skippedExecutable: number }> {
    const keys = sel.urlPattern ? [keyOf(sel.urlPattern, sel.method)] : [...this.routes.keys()];
    const removed: string[] = [];
    let skippedExecutable = 0;
    for (const k of keys) {
      const skipped = await this.removeByKey(page, k);
      if (skipped === undefined) continue;
      removed.push(k);
      skippedExecutable += skipped;
    }
    return { removed, skippedExecutable };
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
    return installed(routes, spec, await routes.addQueue(page, spec));
  }
  return installed(routes, spec, await routes.add(page, spec));
}

function installed(
  routes: RouteRegistry,
  spec: RouteSpec | RouteQueueSpec,
  r: AddResult & { queued?: number },
): RouteInstalled {
  return {
    kind: "installed",
    key: r.key,
    ...(r.queued !== undefined ? { queued: r.queued } : {}),
    fulfils: spec.allowExecutable ? "all" : "data",
    ...(r.replacedSkipped > 0 ? { skippedExecutable: r.replacedSkipped } : {}),
    active: routes.list(),
  };
}

/** Remove one interception (or all of this session's) and report what is left. */
export async function removeRoute(
  routes: RouteRegistry,
  page: Page,
  sel: RouteSelector,
): Promise<UnrouteResult> {
  const r = await routes.remove(page, sel);
  return {
    kind: "removed",
    removed: r.removed,
    ...(r.skippedExecutable > 0 ? { skippedExecutable: r.skippedExecutable } : {}),
    active: routes.list(),
  };
}
