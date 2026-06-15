import { ACTION_OPTS, SESSION_ARG, TIMEOUT_ARG } from "./schemas.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ActionHost,
  ServerServicesHost,
} from "./host.js";

/**
 * History + viewport action verbs: go_back / go_forward / set_viewport. No
 * confirm hook, no target resolution — a shape distinct from the canonical action
 * pipeline, so they keep their own bodies. Split out of `action-tools` by cohesive
 * family (RFC 0004 P3 / D3 SRP); registered in the same source order.
 */
export function registerActionHistoryTools(
  host: RegisterHost & GateHost & SessionHost & ActionHost & ServerServicesHost,
): void {
  const { z } = host;

  host.register(
    "go_back",
    {
      capability: "navigation",
      batchable: true,
      description: "Navigate back in history. Returns an ActionResult.",
      inputSchema: { ...ACTION_OPTS },
    },
    async (args) => {
      const g = host.gateCheck("go_back");
      if (g) return g;
      const td = host.actionTimeout(args);
      return host.asActionResultText(
        host.actionsFor(await host.entryFor(args.session)).goBack({
          mode: args.mode,
          maxResultTokens: args.maxResultTokens,
          deadlineMs: td.ms,
          deadlineWarning: td.warning,
        }),
      );
    },
  );

  host.register(
    "go_forward",
    {
      capability: "navigation",
      batchable: true,
      description: "Navigate forward in history. Returns an ActionResult.",
      inputSchema: { ...ACTION_OPTS },
    },
    async (args) => {
      const g = host.gateCheck("go_forward");
      if (g) return g;
      const td = host.actionTimeout(args);
      return host.asActionResultText(
        host.actionsFor(await host.entryFor(args.session)).goForward({
          mode: args.mode,
          maxResultTokens: args.maxResultTokens,
          deadlineMs: td.ms,
          deadlineWarning: td.warning,
        }),
      );
    },
  );

  host.register(
    "set_viewport",
    {
      capability: "navigation",
      batchable: true,
      description:
        "resize a session's viewport mid-flight (responsive-breakpoint testing). `page.setViewportSize` re-lays-out and commonly triggers responsive re-render / lazy-load — returns an ActionResult so `structure` / `snapshotDelta` / `network` show what changed. Only the *size* changes live; full device emulation (isMobile/touch/UA/DPR) is creation-time — set it via `open_session({ device })`.",
      inputSchema: {
        width: z.number().int().positive().describe("CSS px."),
        height: z.number().int().positive().describe("CSS px."),
        ...TIMEOUT_ARG,
        ...SESSION_ARG,
      },
    },
    async ({ width, height, timeoutMs, session }) => {
      const g = host.gateCheck("set_viewport");
      if (g) return g;
      const e = await host.entryFor(session);
      const td = host.actionTimeout({ timeoutMs });
      return host.asActionResultText(
        host.actionsFor(e).setViewport({
          width,
          height,
          deadlineMs: td.ms,
          deadlineWarning: td.warning,
        }),
      );
    },
  );
}
