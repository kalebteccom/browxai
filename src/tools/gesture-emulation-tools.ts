import { estimateTokens } from "../util/tokens.js";
import { requireCdp } from "../engine/session-cdp.js";
import { SESSION_ARG } from "./schemas.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ActionHost,
  ServerServicesHost,
} from "./host.js";

/**
 * Live network/CPU emulation tools: network_emulate / cpu_emulate — CDP-deep
 * throttle/offline + CPU slowdown for low-end-device repros. Split out of
 * `gesture-network-tools` by cohesive family (RFC 0004 P3 / D3 SRP); registered
 * through the shared `ToolHost` seam in the same source order.
 */
export function registerGestureEmulationTools(
  host: RegisterHost & GateHost & SessionHost & ActionHost & ServerServicesHost,
): void {
  const { z, register, gateCheck, engineGate, entryFor } = host;

  register(
    "network_emulate",
    {
      capability: "action",
      batchable: true,
      deep: true,
      description:
        "Throttle the session's network conditions (or simulate offline) via CDP `Network.emulateNetworkConditions`. For flaky-mobile / offline / slow-link repros on a real backend; **composes** with `route_queue` — each route's `delayMs` stacks ON TOP of the emulated `latencyMs`. Per-session; persists across navigation (re-applied on main-frame nav in case CDP drops it on a renderer swap). Empty input (or `{offline:false}` with no other fields) resets to no throttle. **BYOB:** the override applies to the attached Chrome and stays in effect even after browxai detaches, until the human resets DevTools or closes the page (a `warning` field surfaces this).",
      inputSchema: {
        offline: z
          .boolean()
          .optional()
          .describe(
            "If true, all network traffic from the page fails as offline. Wins over latency / bps.",
          ),
        latencyMs: z
          .number()
          .int()
          .nonnegative()
          .max(600_000)
          .optional()
          .describe(
            "One-way latency in ms. CDP doubles it for round-trip; route_queue delayMs stacks on top.",
          ),
        downloadBps: z
          .number()
          .nonnegative()
          .max(10_000_000_000)
          .optional()
          .describe("Max download throughput, bytes/sec. 0 / unset = unthrottled."),
        uploadBps: z
          .number()
          .nonnegative()
          .max(10_000_000_000)
          .optional()
          .describe("Max upload throughput, bytes/sec. 0 / unset = unthrottled."),
        packetLoss: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Hint, 0..1. Most Chromium builds ignore it; pass for documentation."),
        ...SESSION_ARG,
      },
    },
    async ({ offline, latencyMs, downloadBps, uploadBps, packetLoss, session }) => {
      const g = gateCheck("network_emulate");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("network_emulate", e);
      if (eg) return eg;
      try {
        const { state, reset } = await e.emulation.applyNetwork(
          requireCdp(e.session),
          e.session.page(),
          {
            offline,
            latencyMs,
            downloadBps,
            uploadBps,
            packetLoss,
          },
        );
        const body: Record<string, unknown> = { ok: true, applied: state, reset };
        if (e.mode === "attached") {
          body.warning =
            "BYOB / attached Chrome: this network override stays in effect on the attached browser even after browxai detaches — reset it (call again with empty args) or close the page when you're done.";
        }
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      }
    },
  );

  register(
    "cpu_emulate",
    {
      capability: "action",
      batchable: true,
      deep: true,
      description:
        "Slow the renderer to simulate a low-end device via CDP `Emulation.setCPUThrottlingRate`. `throttleRate: 1` = no throttle (and is the reset path); `2` = 2× slowdown; `4`–`6` = mid-to-low-end mobile. Per-session; persists across navigation (re-applied on main-frame nav in case CDP drops it). Empty input resets to `1`. Independent of `network_emulate` — apply both for a full low-end-device repro. **BYOB:** the throttle stays in effect on the attached Chrome until reset or page close (`warning` surfaces this).",
      inputSchema: {
        throttleRate: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("CPU slowdown multiplier. 1 = none (reset). 2 = 2×. 4–6 = low-end mobile."),
        ...SESSION_ARG,
      },
    },
    async ({ throttleRate, session }) => {
      const g = gateCheck("cpu_emulate");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("cpu_emulate", e);
      if (eg) return eg;
      try {
        const { state, reset } = await e.emulation.applyCpu(
          requireCdp(e.session),
          e.session.page(),
          {
            throttleRate,
          },
        );
        const body: Record<string, unknown> = { ok: true, applied: state, reset };
        if (e.mode === "attached") {
          body.warning =
            "BYOB / attached Chrome: this CPU throttle stays in effect on the attached browser even after browxai detaches — reset it (call again with no args / throttleRate:1) or close the page when you're done.";
        }
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      }
    },
  );
}
