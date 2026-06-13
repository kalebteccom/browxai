// timed observation window with no driving action.
//
// `ActionResult`'s structure diff is endpoint-only (pre vs post) — a *transient*
// element that appears AND disappears inside the window is invisible to it.
// `watch` samples the top-level regions across the window, so double-fire /
// missing-broadcast / flash-of-content classes are caught: each region gets
// `appearedAtMs` and `disappearedAtMs` (null = still present at the end).
//
// Console / network / WS are time-stamped buffers already — sliced over the
// same window.

import { walk } from "./a11y.js";
import { NetworkTap, type NetworkEntry, type NetworkSummary, type WsFrame } from "./network.js";
import type { ActionContext } from "./actionresult.js";

/** Roles that signal a page-level transient/notification surface. */
const WATCHED_ROLES = new Set([
  "dialog",
  "alertdialog",
  "alert",
  "status",
  "banner",
  "tooltip",
  "log",
  "marquee",
  "timer",
]);

export interface WatchedRegion {
  role: string;
  name?: string;
  ref: string;
  appearedAtMs: number;
  /** ms offset when it vanished, or null if still present at window end. */
  disappearedAtMs: number | null;
}

export interface WatchResult {
  durationMs: number;
  samples: number;
  regions: WatchedRegion[];
  console: { errors: string[]; warnings: number; pageErrors: string[] };
  network: { summary: NetworkSummary; requests: NetworkEntry[] };
  wsFrames: WsFrame[];
}

const MAX_DURATION_MS = 60_000;
const DEFAULT_SAMPLE_MS = 250;

export async function watchWindow(
  ctx: ActionContext,
  opts: { durationMs: number; sampleMs?: number },
): Promise<WatchResult> {
  const durationMs = Math.min(Math.max(opts.durationMs, 1), MAX_DURATION_MS);
  const sampleMs = Math.max(opts.sampleMs ?? DEFAULT_SAMPLE_MS, 50);
  const tStart = Date.now();

  // Thread the session's secrets registry (when capability `secrets` is
  // active and the registry exists on the action context) so the network
  // tap's literal-value sanitisation runs over URLs / mutation
  // responseShape keys during the watch window — same chokepoint the
  // action-window tap uses.
  // The CDP NetworkTap supplies the network slice on chromium; off Chromium it
  // is absent (the Playwright-event tap is P2b) and the network block is empty.
  const net = ctx.cdp ? new NetworkTap(ctx.cdp, ctx.secrets ?? null) : null;
  if (net) await net.open();

  // ref → tracking record across samples.
  const seen = new Map<string, { role: string; name?: string; firstMs: number; lastMs: number }>();
  let samples = 0;

  const sampleOnce = async (): Promise<void> => {
    const tree = await ctx.snapshot.a11yTree(ctx.refs, ctx.testAttributes).catch(() => null);
    if (!tree) return;
    const nowMs = Date.now() - tStart;
    samples++;
    for (const { node } of walk(tree)) {
      if (!WATCHED_ROLES.has(node.role)) continue;
      const rec = seen.get(node.ref);
      if (rec) {
        rec.lastMs = nowMs;
      } else {
        seen.set(node.ref, { role: node.role, name: node.name, firstMs: nowMs, lastMs: nowMs });
      }
    }
  };

  await sampleOnce();
  while (Date.now() - tStart < durationMs) {
    await new Promise((r) => setTimeout(r, sampleMs));
    await sampleOnce();
  }
  const endMs = Date.now() - tStart;

  const network: { summary: NetworkSummary; requests: NetworkEntry[] } = net
    ? await net.close()
    : { summary: { total: 0, byType: {}, failed: 0 }, requests: [] };
  const errors = ctx.console.errorsSince(tStart);
  const pageErrors = ctx.console.pageErrorsSince(tStart);
  const warnings = ctx.console.warningCountSince(tStart);
  const wsFrames = ctx.ws ? ctx.ws.since(tStart, 100) : [];

  // A region "disappeared" if its last sighting was more than ~1.5 sample
  // intervals before the final sample (i.e. it wasn't in the last sample).
  const staleCut = endMs - sampleMs * 1.5;
  const regions: WatchedRegion[] = [...seen.values()].map((r) => ({
    role: r.role,
    name: r.name,
    ref: "",
    appearedAtMs: r.firstMs,
    disappearedAtMs: r.lastMs < staleCut ? r.lastMs : null,
  }));
  // attach refs back (Map key is the ref)
  let i = 0;
  for (const ref of seen.keys()) {
    regions[i]!.ref = ref;
    i++;
  }

  return {
    durationMs,
    samples,
    regions,
    console: { errors, warnings, pageErrors },
    network: { summary: network.summary, requests: network.requests },
    wsFrames,
  };
}
