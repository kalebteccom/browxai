// Deterministic Math.random — capability `action`.
//
// Wraps Playwright `context.addInitScript` to inject a Mulberry32 PRNG that
// replaces `Math.random` at every realm bootstrap. The seed is captured by
// closure inside the init script so each navigation (and every iframe /
// worker that uses an init-script-installed Math.random) gets a fresh
// deterministic stream starting from the same state. Per-session.
//
// Reset semantics:
//   - `seed_random({ seed })` with a finite, non-negative integer seed →
//     installs the override (or replaces the cached seed if already set).
//   - The init script is added ONCE per BrowserContext on first apply; the
//     cached seed lives on a `window.__browxSeed` writeable closure-set by
//     the init script. To re-seed we mutate that closure on the current page
//     AND swap the context's init-script seed for any future page bootstrap.
//
// Re-apply on navigation:
//   - Playwright `addInitScript` is a context-level primitive — it runs in
//     every new document. To stay future-proof against renderer-swap edge
//     cases (mirroring src/page/emulation.ts + src/page/clock.ts), we also
//     install a `framenavigated` hook that pushes the cached seed back into
//     the main-frame realm.
//
// MVP scope (not touched):
//   - `crypto.randomUUID` / `crypto.getRandomValues` — web-crypto is a much
//     bigger surface to deterministically stub; revisit later.
//   - Workers — `addInitScript` runs in every document realm but not inside
//     Web Workers / Service Workers. Out of scope for v1.
//
// BYOB note: the init script is installed on the attached Chrome's context
// for as long as the context lives. After our session detaches, any tab
// the human spawns from this context still hits the override on first load
// — surfaced as a `warning` on the result.

import type { BrowserContext, Page } from "playwright-core";

export interface SeedRandomInput {
  /** Non-negative finite integer seed. 0 is valid. */
  seed: number;
}

export interface SeedRandomState {
  seed: number;
}

const MAX_SEED = 0xffffffff; // 2^32 - 1, Mulberry32's state domain

/**
 * The page-side init script. Defined as a string so Playwright can serialise
 * it intact to every new document. Re-reads `window.__browxSeed` on every
 * call (set by the install-script closure) so a re-seed via the main-frame
 * hook below is picked up by the next `Math.random()` without re-injection.
 *
 * Mulberry32 — small, fast, statistically reasonable for testing flake-repros;
 * not cryptographic and explicitly NOT a `crypto` replacement.
 */
function buildInitScript(seed: number): string {
  return `(() => {
  // Idempotent: a refresh that re-runs the init script must not stack overrides.
  if (Object.prototype.hasOwnProperty.call(globalThis, "__browxSeed")) {
    globalThis.__browxSeed = ${seed} >>> 0;
    return;
  }
  let state = ${seed} >>> 0;
  Object.defineProperty(globalThis, "__browxSeed", {
    configurable: true,
    enumerable: false,
    get() { return state; },
    set(v) { state = (v | 0) >>> 0; },
  });
  const mulberry32 = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try {
    Object.defineProperty(Math, "random", {
      configurable: true,
      writable: true,
      value: mulberry32,
    });
  } catch {
    // Fallback if Math.random is non-configurable in some embedder; assign anyway.
    Math.random = mulberry32;
  }
})();`;
}

function normalize(input: SeedRandomInput): SeedRandomState {
  const s = input.seed;
  if (s === undefined || s === null || !Number.isFinite(s) || !Number.isInteger(s) || s < 0 || s > MAX_SEED) {
    throw new Error(
      `seed_random: seed must be a non-negative integer in [0, ${MAX_SEED}] (got ${JSON.stringify(s)})`,
    );
  }
  return { seed: s };
}

/** Per-session seeded-random controller. One per SessionEntry. */
export class SeededRandomRegistry {
  private state: SeedRandomState | undefined;
  /** Tracks whether we've installed a context-level init script yet. The
   *  reference is the BrowserContext so a session-shared context only gets
   *  one. */
  private contextInstalled = new WeakSet<object>();
  /** Tracks pages we've wired the re-apply hook on. */
  private reattachInstalled = new WeakSet<object>();

  /** Apply a seed override and remember it. */
  async apply(
    context: BrowserContext,
    page: Page,
    input: SeedRandomInput,
  ): Promise<{ state: SeedRandomState }> {
    const state = normalize(input);

    if (!this.contextInstalled.has(context as unknown as object)) {
      // First time: register the init script on the context so every new
      // document (including the current one's NEXT navigation) sees it.
      await context.addInitScript({ content: buildInitScript(state.seed) });
      this.contextInstalled.add(context as unknown as object);
    }
    // Re-seed the CURRENT page's main realm immediately so a caller doesn't
    // have to navigate to see the override take effect. This is best-effort —
    // a closed page or detached frame raises, swallowed.
    await page
      .evaluate(buildInitScript(state.seed))
      .catch(() => undefined);

    this.state = state;
    this.installReattach(page);
    return { state };
  }

  /** Test introspection. */
  current(): SeedRandomState | undefined { return this.state; }

  /** Defensive re-apply: `addInitScript` is per-document, but a renderer swap
   *  or main-frame nav still benefits from a re-push for symmetry with
   *  src/page/emulation.ts + src/page/clock.ts. We push the cached seed back
   *  into the main frame on every main-frame `framenavigated`. */
  private installReattach(page: Page): void {
    if (this.reattachInstalled.has(page as unknown as object)) return;
    this.reattachInstalled.add(page as unknown as object);
    const onNav = async (frame: { parentFrame: () => unknown | null }): Promise<void> => {
      if (frame.parentFrame()) return; // main frame only
      if (!this.state) return;
      try {
        await page.evaluate(buildInitScript(this.state.seed)).catch(() => undefined);
      } catch {
        // page may have closed mid-navigation; swallow
      }
    };
    page.on("framenavigated", onNav as (f: unknown) => void);
  }
}

/** Test-only: expose the script-builder so tests can assert determinism by
 *  evaluating the produced source in a sandbox without launching a browser. */
export const _internal = { buildInitScript };
