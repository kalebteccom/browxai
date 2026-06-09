// Network + CPU emulation — capability `action`.
//
// Wraps two CDP primitives so flaky-mobile / offline / low-end-device repros
// stop requiring a real lab device:
//   - Network.emulateNetworkConditions  → `NetworkEmulation`
//   - Emulation.setCPUThrottlingRate    → `CpuEmulation`
//
// Both are per-target overrides; CDP keeps them applied for the lifetime of
// the *target*. But a renderer swap (cross-process navigation), a fresh page,
// or some incognito teardown corners can drop them — so we cache the active
// state per session and re-apply on `framenavigated` for the main frame.
// Plays cleanly with `route` / `route_queue`: the route handler's `delayMs`
// stacks ON TOP of the emulated latency, by design.
//
// Reset semantics:
//   - `network_emulate({})` / `{offline:false}` (with no latency/bps/loss) →
//     clears the override (offline=false, latency 0, bps -1, packetLoss 0).
//   - `cpu_emulate({})` / `{throttleRate:1}` → clears the override (rate 1).
//
// BYOB note: overrides apply to the attached Chrome's page for as long as
// CDP holds them. After our session detaches, the human's DevTools Network /
// Performance panels may still show the throttled state until they reset it
// or close the page — surfaced as a `warning` on the result.

import type { CDPSession, Page } from "playwright-core";

/** All fields optional. Empty object == reset. */
export interface NetworkEmulationInput {
  offline?: boolean;
  /** One-way latency in ms (CDP doubles it for round-trip). */
  latencyMs?: number;
  /** Max download throughput in bytes/sec. 0 / unset → unthrottled. */
  downloadBps?: number;
  /** Max upload throughput in bytes/sec. 0 / unset → unthrottled. */
  uploadBps?: number;
  /** 0..1 — passed straight through (CDP supports it; most chromium builds
   *  ignore it but it's documented as a hint). */
  packetLoss?: number;
}

export interface CpuEmulationInput {
  /** 1 = no throttle. 2 = 2× slowdown. 4–6 simulates a low-end device. */
  throttleRate?: number;
}

export interface NetworkEmulationState {
  offline: boolean;
  latencyMs: number;
  downloadBps: number;
  uploadBps: number;
  packetLoss?: number;
}

export interface CpuEmulationState {
  throttleRate: number;
}

/** The "no override" defaults — both tools' "reset" calls collapse to this. */
export const DEFAULT_NETWORK: NetworkEmulationState = {
  offline: false,
  latencyMs: 0,
  downloadBps: 0,
  uploadBps: 0,
};

export const DEFAULT_CPU: CpuEmulationState = { throttleRate: 1 };

const MAX_LATENCY_MS = 600_000;
const MAX_BPS = 10_000_000_000; // 10 GB/s — generous; really a sanity ceiling
const MAX_CPU_RATE = 100;

function clampNonNeg(n: number | undefined, max: number): number {
  if (n === undefined || n === null || !Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

function normalizeNetwork(input: NetworkEmulationInput): NetworkEmulationState {
  const state: NetworkEmulationState = {
    offline: input.offline === true,
    latencyMs: clampNonNeg(input.latencyMs, MAX_LATENCY_MS),
    downloadBps: clampNonNeg(input.downloadBps, MAX_BPS),
    uploadBps: clampNonNeg(input.uploadBps, MAX_BPS),
  };
  if (input.packetLoss !== undefined) {
    if (!Number.isFinite(input.packetLoss) || input.packetLoss < 0 || input.packetLoss > 1) {
      throw new Error(
        `network_emulate: packetLoss must be between 0 and 1 (got ${input.packetLoss})`,
      );
    }
    state.packetLoss = input.packetLoss;
  }
  return state;
}

function normalizeCpu(input: CpuEmulationInput): CpuEmulationState {
  const r = input.throttleRate;
  if (r === undefined || r === null) return { throttleRate: 1 };
  if (!Number.isFinite(r) || r < 1 || r > MAX_CPU_RATE) {
    throw new Error(`cpu_emulate: throttleRate must be between 1 and ${MAX_CPU_RATE} (got ${r})`);
  }
  return { throttleRate: r };
}

function isNetworkReset(s: NetworkEmulationState): boolean {
  return (
    !s.offline &&
    s.latencyMs === 0 &&
    s.downloadBps === 0 &&
    s.uploadBps === 0 &&
    (s.packetLoss === undefined || s.packetLoss === 0)
  );
}

function isCpuReset(s: CpuEmulationState): boolean {
  return s.throttleRate === 1;
}

/** Per-session emulation cache + re-applier. One per SessionEntry. */
export class EmulationRegistry {
  private network: NetworkEmulationState | undefined;
  private cpu: CpuEmulationState | undefined;
  /** Re-apply hook installed once per page on first use. */
  private reattachInstalled = new WeakSet<object>();

  /** Apply network conditions and remember them. Returns the normalized state
   *  that's now active. */
  async applyNetwork(
    cdp: CDPSession,
    page: Page,
    input: NetworkEmulationInput,
  ): Promise<{ state: NetworkEmulationState; reset: boolean }> {
    const state = normalizeNetwork(input);
    await this.sendNetwork(cdp, state);
    this.network = state;
    this.installReattach(page);
    return { state, reset: isNetworkReset(state) };
  }

  /** Apply CPU throttling and remember it. */
  async applyCpu(
    cdp: CDPSession,
    page: Page,
    input: CpuEmulationInput,
  ): Promise<{ state: CpuEmulationState; reset: boolean }> {
    const state = normalizeCpu(input);
    await this.sendCpu(cdp, state);
    this.cpu = state;
    this.installReattach(page);
    return { state, reset: isCpuReset(state) };
  }

  /** Reset both overrides — used by close/teardown paths if needed. */
  async resetAll(cdp: CDPSession): Promise<void> {
    if (this.network && !isNetworkReset(this.network)) {
      await this.sendNetwork(cdp, DEFAULT_NETWORK).catch(() => undefined);
    }
    if (this.cpu && !isCpuReset(this.cpu)) {
      await this.sendCpu(cdp, DEFAULT_CPU).catch(() => undefined);
    }
    this.network = undefined;
    this.cpu = undefined;
  }

  /** Test introspection: the currently-cached state, or undefined if not set. */
  currentNetwork(): NetworkEmulationState | undefined {
    return this.network;
  }
  currentCpu(): CpuEmulationState | undefined {
    return this.cpu;
  }

  /** Defensive re-apply: CDP overrides are *usually* per-target and survive
   *  navigation, but cross-process renderer swaps + incognito teardowns can
   *  drop them. Re-push the cached state on every main-frame navigation. */
  private installReattach(page: Page): void {
    if (this.reattachInstalled.has(page)) return;
    this.reattachInstalled.add(page);
    const onNav = async (frame: { parentFrame: () => unknown | null }): Promise<void> => {
      // main frame only
      if (frame.parentFrame()) return;
      try {
        // re-acquire the CDP session via the page's context — the original
        // session ref may be stale after a renderer swap.
        const cdp = await page
          .context()
          .newCDPSession(page)
          .catch(() => null);
        if (!cdp) return;
        if (this.network && !isNetworkReset(this.network)) {
          await this.sendNetwork(cdp, this.network).catch(() => undefined);
        }
        if (this.cpu && !isCpuReset(this.cpu)) {
          await this.sendCpu(cdp, this.cpu).catch(() => undefined);
        }
      } catch {
        // page may have closed mid-navigation; swallow
      }
    };
    // playwright's framenavigated fires for every frame; we filter inside.
    page.on("framenavigated", onNav as (f: unknown) => void);
  }

  private async sendNetwork(cdp: CDPSession, s: NetworkEmulationState): Promise<void> {
    // CDP wants -1 for "no throttle" on bps fields; map 0 → -1.
    await cdp.send("Network.emulateNetworkConditions", {
      offline: s.offline,
      latency: s.latencyMs,
      downloadThroughput: s.downloadBps > 0 ? s.downloadBps : -1,
      uploadThroughput: s.uploadBps > 0 ? s.uploadBps : -1,
      ...(s.packetLoss !== undefined ? { packetLoss: s.packetLoss } : {}),
    });
  }

  private async sendCpu(cdp: CDPSession, s: CpuEmulationState): Promise<void> {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: s.throttleRate });
  }
}
