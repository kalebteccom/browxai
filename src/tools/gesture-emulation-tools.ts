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
import { requirePage } from "../engine/index.js";

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
        "Throttle the session's network, or take it offline, through CDP `Network.emulateNetworkConditions`, for slow-link and offline repros against a real backend. It composes with `route_queue`: each route's `delayMs` adds to the emulated `latencyMs`. Per session; persists across navigation. Empty input (or `{offline:false}` alone) removes the throttle. On `attached` sessions the override stays on your Chrome after browxai detaches, until you reset DevTools or close the page (a `warning` says so).",
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
          requirePage(e.session),
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
        "Slow the renderer to mimic a low-end device through CDP `Emulation.setCPUThrottlingRate`. `throttleRate:1` is no throttle (the reset), `2` is 2x slower, `4` to `6` is mid to low-end mobile. Per session; persists across navigation. Empty input resets to `1`. Independent of `network_emulate`: use both for a full low-end repro. On `attached` sessions the throttle stays on your Chrome until reset or page close (a `warning` says so).",
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
          requirePage(e.session),
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
