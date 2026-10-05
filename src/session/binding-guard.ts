// Per-page call budget for the `__browx_*` page bindings (the permission,
// notification, fs-picker and device wrappers). Page content is untrusted and
// any script on the page can call a binding, bypassing the wrapper that was
// meant to. Every call costs a CDP event in, the handler, and a reply
// evaluated back into the page; Playwright sends that reply unconditionally,
// whatever the handler did. A page that calls in a tight loop therefore queues
// replies on its own session faster than the browser drains them, and the
// session's click and snapshot commands wait behind that queue.
//
// The guard sheds calls beyond a token-bucket budget, in two tiers:
//   1. A call that finds a token in the page's reply-shed bucket resolves at
//      once to the binding's deny-equivalent result. A page slightly over budget
//      still gets an answer and is never approved.
//   2. A call beyond that never settles. It sends no reply, so the flood adds no
//      reply traffic. The promise it returns is not referenced from here, so it
//      is collected; the only thing left behind is the caller's own pending
//      promise inside the flooding page.
// A shed call never reaches the handler, so it is not recorded, never asks a
// human, and never writes a file.
//
// Shedding is logged as a coalesced counter, never per call.

import { log } from "../util/logging.js";

/** What Playwright passes as the first argument of a binding callback. Only the
 *  page is read; the rest is whatever the engine supplies. */
export interface BindingSource {
  page?: object;
  context?: object;
}

export type BindingClass = "decision" | "write";

export interface BindingBudget {
  /** Tokens a quiet page can spend at once. */
  burst: number;
  /** Tokens added per second. */
  refillPerSec: number;
  /** Calls allowed in flight at once (a handler can wait on a human). */
  maxInFlight: number;
  /** Tier-1 bucket: deny-equivalent replies for calls over budget. 0 disables
   *  the tier, which a binding whose normal reply means success needs. */
  shedReplyBurst: number;
  shedReplyPerSec: number;
}

/** Decision bindings are consulted a handful of times per feature use, so the
 *  budget is generous. Writes carry file chunks from a granted handle, so they
 *  get a larger bucket and no deny reply: their normal reply means "written". */
export const DEFAULT_BUDGETS: Record<BindingClass, BindingBudget> = {
  decision: {
    burst: 100,
    refillPerSec: 25,
    maxInFlight: 32,
    shedReplyBurst: 10,
    shedReplyPerSec: 2,
  },
  write: {
    burst: 256,
    refillPerSec: 100,
    maxInFlight: 64,
    shedReplyBurst: 0,
    shedReplyPerSec: 0,
  },
};

/** Minimum gap between two shed-counter log lines. */
export const SHED_LOG_INTERVAL_MS = 5_000;

export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly burst: number,
    private readonly perSec: number,
    now: number,
  ) {
    this.tokens = burst;
    this.last = now;
  }
  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.perSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

interface ClassState {
  budget: TokenBucket;
  shedReply: TokenBucket;
  inFlight: number;
}

interface PageState {
  classes: Record<BindingClass, ClassState>;
}

export interface BindingGuardOptions {
  now?: () => number;
  budgets?: Record<BindingClass, BindingBudget>;
  /** Receives each coalesced shed counter. Defaults to a warn log. */
  report?: (fields: { shed: number; bindings: Record<string, number>; windowMs: number }) => void;
}

export class BindingGuard {
  private readonly now: () => number;
  private readonly budgets: Record<BindingClass, BindingBudget>;
  private readonly report: NonNullable<BindingGuardOptions["report"]>;
  private readonly pages = new WeakMap<object, PageState>();
  private readonly fallbackKey = {};
  private pendingShed: Record<string, number> = {};
  private pendingTotal = 0;
  private lastReport = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: BindingGuardOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.budgets = opts.budgets ?? DEFAULT_BUDGETS;
    this.report =
      opts.report ??
      ((f) => log.warn("browx-binding: binding calls shed over the per-page budget", f));
  }

  /** Wrap a binding callback. `denyResult` is the deny-equivalent a call over
   *  budget resolves to while the tier-1 bucket has tokens; omit it for a
   *  binding that has no safe reply. `onShed` runs for every shed call (tier 1
   *  and 2) so a binding can fail closed on its own state. */
  wrap<R>(
    name: string,
    cls: BindingClass,
    handler: (source: BindingSource, payload: string) => R | Promise<R>,
    opts: { denyResult?: () => R; onShed?: (payload: string) => void } = {},
  ): (source: BindingSource, payload: string) => R | Promise<R> {
    return (source, payload) => {
      const state = this.stateFor(source, cls);
      const t = this.now();
      if (state.inFlight >= this.budgets[cls].maxInFlight || !state.budget.take(t)) {
        this.shed(name);
        try {
          opts.onShed?.(payload);
        } catch {
          // A failing shed hook must not turn a shed call into a handled one.
        }
        if (opts.denyResult && state.shedReply.take(t)) return opts.denyResult();
        // A fresh promise per call: a shared one would collect every shed call
        // as a reaction and grow without bound.
        return new Promise<never>(() => undefined);
      }
      state.inFlight++;
      let result: R | Promise<R>;
      try {
        result = handler(source, payload);
      } catch (e) {
        state.inFlight--;
        throw e;
      }
      if (result instanceof Promise) {
        return result.finally(() => {
          state.inFlight--;
        });
      }
      state.inFlight--;
      return result;
    };
  }

  private stateFor(source: BindingSource | undefined, cls: BindingClass): ClassState {
    const key = source?.page ?? source?.context ?? this.fallbackKey;
    let page = this.pages.get(key);
    if (!page) {
      const t = this.now();
      const mk = (c: BindingClass): ClassState => {
        const b = this.budgets[c];
        return {
          budget: new TokenBucket(b.burst, b.refillPerSec, t),
          shedReply: new TokenBucket(b.shedReplyBurst, b.shedReplyPerSec, t),
          inFlight: 0,
        };
      };
      page = { classes: { decision: mk("decision"), write: mk("write") } };
      this.pages.set(key, page);
    }
    return page.classes[cls];
  }

  private shed(name: string): void {
    this.pendingShed[name] = (this.pendingShed[name] ?? 0) + 1;
    this.pendingTotal++;
    const sinceLast = this.now() - this.lastReport;
    if (sinceLast >= SHED_LOG_INTERVAL_MS) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), SHED_LOG_INTERVAL_MS - sinceLast);
      this.timer.unref?.();
    }
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pendingTotal === 0) return;
    const t = this.now();
    this.report({
      shed: this.pendingTotal,
      bindings: this.pendingShed,
      windowMs: Number.isFinite(this.lastReport) ? t - this.lastReport : 0,
    });
    this.pendingShed = {};
    this.pendingTotal = 0;
    this.lastReport = t;
  }
}

/** The guard every attach adapter shares, so one page's budget is the sum over
 *  all its bindings. */
export const bindingGuard = new BindingGuard();
