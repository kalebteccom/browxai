import { ACTION_OPTS, SESSION_ARG, TIMEOUT_ARG } from "./schemas.js";
import type { RegisterHost, ServerServicesHost } from "./host.js";
import { checkLanding, type NavigationGateHost } from "./navigation-gate.js";

/**
 * History + viewport action verbs: go_back / go_forward / set_viewport. No
 * target resolution — a shape distinct from the canonical action pipeline, so
 * they keep their own bodies. A history move has no requested URL, so the two
 * history verbs check the URL they land on: scheme first, then the origin rules. Split out of `action-tools` by cohesive
 * family (RFC 0004 P3 / D3 SRP); registered in the same source order.
 */
export function registerActionHistoryTools(
  host: RegisterHost & NavigationGateHost & ServerServicesHost,
): void {
  const { z } = host;

  host.register(
    "go_back",
    {
      capability: "navigation",
      batchable: true,
      description:
        "Go back one entry in the session history. The scheme rules of `navigate` and the origin rules (`BROWX_ALLOWED_ORIGINS`, `BROWX_BLOCKED_ORIGINS`) apply to the page you land on: a held origin asks the human or returns a deny and the page stays there, and a scheme `navigate` would not open returns the refusal and resets the page to `about:blank`. Use `navigate` for a new URL. Returns an ActionResult.",
      inputSchema: { ...ACTION_OPTS },
    },
    async (args) => {
      const g = host.gateCheck("go_back");
      if (g) return g;
      const e = await host.entryFor(args.session);
      const td = host.actionTimeout(args);
      const result = await host.actionsFor(e).goBack({
        mode: args.mode,
        maxResultTokens: args.maxResultTokens,
        deadlineMs: td.ms,
        deadlineWarning: td.warning,
      });
      const held = await checkLanding(host, "go_back", e, "", result.navigation, td.ms);
      return held ?? host.asActionResultText(Promise.resolve(result));
    },
  );

  host.register(
    "go_forward",
    {
      capability: "navigation",
      batchable: true,
      description:
        "Go forward one entry in the session history, after a `go_back`. The scheme and origin rules apply to the page you land on, as for `go_back`. Returns an ActionResult.",
      inputSchema: { ...ACTION_OPTS },
    },
    async (args) => {
      const g = host.gateCheck("go_forward");
      if (g) return g;
      const e = await host.entryFor(args.session);
      const td = host.actionTimeout(args);
      const result = await host.actionsFor(e).goForward({
        mode: args.mode,
        maxResultTokens: args.maxResultTokens,
        deadlineMs: td.ms,
        deadlineWarning: td.warning,
      });
      const held = await checkLanding(host, "go_forward", e, "", result.navigation, td.ms);
      return held ?? host.asActionResultText(Promise.resolve(result));
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
