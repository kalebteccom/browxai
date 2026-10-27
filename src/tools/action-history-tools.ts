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
      description:
        "Go back one entry in the session history. The origin rules apply to the page you land on. Use `navigate` for a new URL. Returns an ActionResult.",
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
      description:
        "Go forward one entry in the session history, after a `go_back`. The origin rules apply to the page you land on. Returns an ActionResult.",
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
        "Resize the session's viewport mid-session, for responsive-breakpoint checks. A resize often triggers a responsive re-render or lazy-load, so the ActionResult's `structure`, `snapshotDelta` and `network` show what changed. Only the size changes live. Device emulation (mobile flag, touch, user agent, pixel ratio) is set at creation with `open_session({ device })`.",
      inputSchema: {
        width: z.number().int().positive().describe("Viewport width in CSS px."),
        height: z.number().int().positive().describe("Viewport height in CSS px."),
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
