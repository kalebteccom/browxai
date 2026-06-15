import { confirmNavigation, confirmByobAction } from "../policy/confirm.js";
import { withDeadline } from "../util/deadline.js";
import { runShortcut } from "../page/shortcut.js";
import { ACTION_OPTS, REF_OR_SELECTOR, SESSION_ARG, TIMEOUT_ARG } from "./schemas.js";
import { actionTool, type ActionToolHost } from "./action-tool.js";
import type { ConfigHost, ServerServicesHost } from "./host.js";

/**
 * Core action verbs: navigate / click / fill / press / shortcut. Split out of
 * `action-tools` by cohesive family (RFC 0004 P3 / D3 SRP); registered through
 * the shared `ToolHost` seam in the same source order. `click` and `fill` are the
 * canonical confirm-gated target-resolving handlers, so they ride the `actionTool`
 * wrapper (RFC 0004 P3 / D4) — byte-identical to the prior hand-written body.
 * navigate (confirmNavigation), press (optional target), and shortcut (try/catch
 * over runShortcut) keep their own bodies — their shapes differ from the canonical
 * pipeline.
 */
export function registerActionCoreTools(
  host: ActionToolHost & ConfigHost & ServerServicesHost,
): void {
  const { z } = host;

  host.register(
    "navigate",
    {
      capability: "navigation",
      batchable: true,
      description:
        "Navigate the page to a URL. Returns an ActionResult: navigation + structure changes + console/network slice + post-snapshot.",
      inputSchema: { url: z.string().describe("Absolute URL"), ...ACTION_OPTS },
    },
    async ({ url, mode, maxResultTokens, timeoutMs, session }) => {
      const g = host.gateCheck("navigate");
      if (g) return g;
      const e = await host.entryFor(session);
      const decision = await confirmNavigation(url, host.confirmCtxFor(e));
      if (!decision.ok) return host.denyContent("navigate", decision);
      const td = host.actionTimeout({ timeoutMs });
      return host.asActionResultText(
        host.actionsFor(e).navigate({
          url,
          mode,
          maxResultTokens,
          deadlineMs: td.ms,
          deadlineWarning: td.warning,
        }),
      );
    },
  );

  actionTool(
    host,
    "click",
    {
      capability: "action",
      batchable: true,
      description:
        "Click an element by `ref` (preferred — from snapshot/find), `selector`, `named`, or page `coords` ({x,y} viewport pixels — escape hatch for canvas / custom-painted UIs). `force:true` skips Playwright's actionability checks (visibility / stability / receives-events / hit-test) — escape hatch for perpetually-busy SPAs where rAF loops + frequent re-renders make the stability check thrash forever; use only on targets you've verified clickable via snapshot/find first. Returns an ActionResult.",
      inputSchema: {
        ...REF_OR_SELECTOR,
        button: z
          .enum(["left", "right", "middle"])
          .optional()
          .describe("Mouse button (default: left)"),
        force: z
          .boolean()
          .optional()
          .describe(
            "Skip actionability checks (visibility/stability/receives-events). Use sparingly — only for known-clickable targets on perpetually-busy SPAs where Playwright's stability check thrashes forever.",
          ),
        ...ACTION_OPTS,
      },
    },
    ({ args, e, target, recordingHint, td }) =>
      host.actionsFor(e).click({
        target,
        button: args.button,
        force: args.force,
        mode: args.mode,
        maxResultTokens: args.maxResultTokens,
        recordingHint,
        deadlineMs: td.ms,
        deadlineWarning: td.warning,
      }),
  );

  actionTool(
    host,
    "fill",
    {
      capability: "action",
      batchable: true,
      description: "Type into an input by `ref` or `selector`. Returns an ActionResult.",
      inputSchema: { ...REF_OR_SELECTOR, value: z.string(), ...ACTION_OPTS },
    },
    ({ args, e, target, recordingHint, td }) =>
      host.actionsFor(e).fill({
        target,
        value: args.value,
        mode: args.mode,
        maxResultTokens: args.maxResultTokens,
        recordingHint,
        deadlineMs: td.ms,
        deadlineWarning: td.warning,
      }),
  );

  host.register(
    "press",
    {
      capability: "action",
      batchable: true,
      description:
        "Press a key. If a `ref`/`selector` is given, presses on that element; else on the page.",
      inputSchema: {
        ...REF_OR_SELECTOR,
        key: z.string().describe('Playwright key syntax, e.g. "Enter", "Control+A"'),
        ...ACTION_OPTS,
      },
    },
    async (args) => {
      const g = host.gateCheck("press");
      if (g) return g;
      const e = await host.entryFor(args.session);
      const conf = await confirmByobAction("press", host.confirmCtxFor(e));
      if (!conf.ok) return host.denyContent("press", conf);
      const hasTarget = !!(args.ref || args.selector || args.named);
      const target = hasTarget ? host.asTarget(args, "press", e.refs) : undefined;
      const td = host.actionTimeout(args);
      return host.asActionResultText(
        host.actionsFor(e).press({
          target,
          key: args.key,
          mode: args.mode,
          maxResultTokens: args.maxResultTokens,
          deadlineMs: td.ms,
          deadlineWarning: td.warning,
        }),
      );
    },
  );

  host.register(
    "shortcut",
    {
      capability: "action",
      description:
        'Dispatch a keyboard chord ("Control+C") or an ordered sequence (["Control+A","Control+C"]) and return handled-observability: the active element, which keydown/copy/cut/paste listeners fired, and whether the app called preventDefault — so you can prove the app actually handled the shortcut, not just that keys were sent. Optional `ref`/`selector` is focused first; else page-level. Copy/cut/paste integrate the per-session clipboard ONLY when the off-by-default `clipboard` capability is enabled: each session has its own clipboard buffer, and the shared OS clipboard is written only transactionally at the copy/cut (capture selection) or paste (inject this session\'s buffer) moment — never ambiently, never read into a session (no cross-session/human clipboard bleed). Observability works without the capability.',
      inputSchema: {
        keys: z
          .union([z.string(), z.array(z.string()).min(1)])
          .describe('A chord ("Control+C") or ordered sequence of chords. Playwright key syntax.'),
        ...REF_OR_SELECTOR,
        ...TIMEOUT_ARG,
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = host.gateCheck("shortcut");
      if (g) return g;
      const e = await host.entryFor(args.session);
      const conf = await confirmByobAction("shortcut", host.confirmCtxFor(e));
      if (!conf.ok) return host.denyContent("shortcut", conf);
      const hasTarget = !!(args.ref || args.selector || args.named);
      const target = hasTarget ? host.asTarget(args, "shortcut", e.refs) : undefined;
      const td = host.actionTimeout(args);
      try {
        const result = await withDeadline(
          runShortcut(
            e.session.page(),
            e.refs,
            { keys: args.keys, target },
            {
              clipboardEnabled: host.caps.enabled.has("clipboard"),
              clipboard: e.clipboard,
            },
          ),
          td.ms,
          "shortcut",
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                td.warning ? { ...result, warning: td.warning } : result,
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}
