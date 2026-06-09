// Virtual-time clock control — capability `action`.
//
// Wraps CDP `Emulation.setVirtualTimePolicy` so date-sensitive flows
// (renewal dates, "today" filters, scheduling, expiry edges) can be tested
// deterministically without touching the OS clock. Per-session.
//
// Three modes:
//   - freeze  → pause virtual time at `atIso` (or "now" if omitted). CDP
//     policy: `pauseIfNetworkFetchesPending` (network keeps moving so the
//     page can still load assets; the JS clock is held).
//   - advance → jump the virtual clock forward by `byMs`, or to absolute
//     `atIso`, then re-freeze. CDP policy: `advance` with a `budget` (ms),
//     then we re-issue a pause so subsequent JS time queries stay pinned.
//   - release → resume real time. CDP no-op-equivalent via `disabled`.
//
// CDP's `setVirtualTimePolicy` is per-target. A renderer swap or fresh page
// drops it — same shape as src/page/emulation.ts, so we cache the active
// state per session and re-apply on `framenavigated` (main frame only).
//
// BYOB note: when applied to an attached Chrome, the virtual-time policy
// stays in effect on the human's page until they release it, reload, or
// close the tab — a wall-clock-looking page that has actually frozen time
// is a debugging trap. Surfaced as a `warning` on the result.

import type { CDPSession, Page } from "playwright-core";

export type ClockMode = "freeze" | "advance" | "release";

export interface ClockInput {
  mode: ClockMode;
  /** Absolute ISO-8601 instant. `freeze` → pin time there. `advance` → jump to it. */
  atIso?: string;
  /** `advance` only — relative jump in ms (mutually exclusive with `atIso`). */
  byMs?: number;
}

/** Cached state used by the re-apply hook. `release` is represented by `undefined`. */
export interface ClockState {
  /** Effective virtual-time anchor, epoch ms. Mirrors what the page now sees. */
  nowMs: number;
  /** Whether the policy is currently a pause (true) or actively advancing (false). */
  paused: boolean;
}

const MAX_ADVANCE_MS = 365 * 24 * 60 * 60 * 1000; // one year — sanity ceiling

function parseIso(iso: string, field: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    throw new Error(
      `clock: ${field} is not a valid ISO-8601 timestamp (got ${JSON.stringify(iso)})`,
    );
  }
  return t;
}

function normalizeInput(
  input: ClockInput,
  currentMs: number,
): {
  mode: ClockMode;
  targetMs: number;
  advanceBudgetMs: number;
} {
  if (input.mode === "release") {
    return { mode: "release", targetMs: currentMs, advanceBudgetMs: 0 };
  }
  if (input.mode === "freeze") {
    if (input.byMs !== undefined) {
      throw new Error(`clock: byMs is only valid with mode:"advance" (got mode:"freeze")`);
    }
    const targetMs = input.atIso !== undefined ? parseIso(input.atIso, "atIso") : Date.now();
    return { mode: "freeze", targetMs, advanceBudgetMs: 0 };
  }
  // advance
  if (input.atIso !== undefined && input.byMs !== undefined) {
    throw new Error(`clock: advance requires exactly one of atIso or byMs, not both`);
  }
  if (input.atIso === undefined && input.byMs === undefined) {
    throw new Error(`clock: advance requires either atIso or byMs`);
  }
  let targetMs: number;
  if (input.atIso !== undefined) {
    targetMs = parseIso(input.atIso, "atIso");
  } else {
    if (!Number.isFinite(input.byMs!) || input.byMs! <= 0) {
      throw new Error(`clock: byMs must be a positive finite number (got ${input.byMs})`);
    }
    if (input.byMs! > MAX_ADVANCE_MS) {
      throw new Error(`clock: byMs ${input.byMs} exceeds max ${MAX_ADVANCE_MS} (1 year)`);
    }
    targetMs = currentMs + input.byMs!;
  }
  const advanceBudgetMs = Math.max(0, targetMs - currentMs);
  if (advanceBudgetMs > MAX_ADVANCE_MS) {
    throw new Error(
      `clock: advance distance ${advanceBudgetMs}ms exceeds max ${MAX_ADVANCE_MS}ms (1 year)`,
    );
  }
  return { mode: "advance", targetMs, advanceBudgetMs };
}

/** Per-session clock controller. One per SessionEntry. */
export class ClockRegistry {
  private state: ClockState | undefined;
  /** Re-apply hook installed once per page on first use. */
  private reattachInstalled = new WeakSet<object>();

  /** Apply the requested mode and remember it. Returns the normalized state. */
  async apply(
    cdp: CDPSession,
    page: Page,
    input: ClockInput,
  ): Promise<{ state: ClockState | undefined; mode: ClockMode; appliedAtIso: string | null }> {
    const currentMs = this.state?.nowMs ?? Date.now();
    const norm = normalizeInput(input, currentMs);

    if (norm.mode === "release") {
      await this.sendRelease(cdp);
      this.state = undefined;
      this.installReattach(page);
      return { state: undefined, mode: "release", appliedAtIso: null };
    }

    if (norm.mode === "freeze") {
      await this.sendPauseAt(cdp, norm.targetMs);
      this.state = { nowMs: norm.targetMs, paused: true };
      this.installReattach(page);
      return {
        state: this.state,
        mode: "freeze",
        appliedAtIso: new Date(norm.targetMs).toISOString(),
      };
    }

    // advance: start from currentMs (re-pin), then advance by budget, then re-pause
    await this.sendPauseAt(cdp, currentMs);
    if (norm.advanceBudgetMs > 0) {
      await this.sendAdvance(cdp, norm.advanceBudgetMs);
    }
    // After advance budget elapses CDP returns to whatever follow-up policy was
    // queued — we explicitly re-pause at the new target so subsequent JS time
    // queries see the pinned instant.
    await this.sendPauseAt(cdp, norm.targetMs);
    this.state = { nowMs: norm.targetMs, paused: true };
    this.installReattach(page);
    return {
      state: this.state,
      mode: "advance",
      appliedAtIso: new Date(norm.targetMs).toISOString(),
    };
  }

  /** Reset on close/teardown if a non-default policy is active. */
  async resetAll(cdp: CDPSession): Promise<void> {
    if (this.state) {
      await this.sendRelease(cdp).catch(() => undefined);
    }
    this.state = undefined;
  }

  /** Test introspection. */
  current(): ClockState | undefined {
    return this.state;
  }

  private installReattach(page: Page): void {
    if (this.reattachInstalled.has(page as unknown as object)) return;
    this.reattachInstalled.add(page as unknown as object);
    const onNav = async (frame: { parentFrame: () => unknown | null }): Promise<void> => {
      if (frame.parentFrame()) return; // main frame only
      try {
        const cdp = await page
          .context()
          .newCDPSession(page)
          .catch(() => null);
        if (!cdp) return;
        if (this.state) {
          await this.sendPauseAt(cdp, this.state.nowMs).catch(() => undefined);
        }
      } catch {
        // page may have closed mid-navigation; swallow
      }
    };
    page.on("framenavigated", onNav as (f: unknown) => void);
  }

  private async sendPauseAt(cdp: CDPSession, atMs: number): Promise<void> {
    await cdp.send("Emulation.setVirtualTimePolicy", {
      policy: "pauseIfNetworkFetchesPending",
      initialVirtualTime: atMs / 1000, // CDP expects seconds since epoch
    });
  }

  private async sendAdvance(cdp: CDPSession, budgetMs: number): Promise<void> {
    await cdp.send("Emulation.setVirtualTimePolicy", {
      policy: "advance",
      budget: budgetMs,
    });
  }

  private async sendRelease(cdp: CDPSession): Promise<void> {
    await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance" });
  }
}
