import { confirmNavigation, confirmLanding, confirmByobAction } from "../policy/confirm.js";
import { withDeadline } from "../util/deadline.js";
import { runShortcut } from "../page/shortcut.js";
import { ACTION_OPTS, REF_OR_SELECTOR, SESSION_ARG, TIMEOUT_ARG } from "./schemas.js";
import { actionTool, type ActionToolHost } from "./action-tool.js";
import type { ConfigHost, ServerServicesHost } from "./host.js";
import { requirePage } from "../engine/index.js";

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
        "Load an absolute URL in the page. Origin rules (`BROWX_ALLOWED_ORIGINS`, `BROWX_BLOCKED_ORIGINS`) apply to the requested URL and to the page it lands on after redirects: a held origin asks the human or returns a deny, and the page stays on the landed URL. Returns an ActionResult (navigation, structure changes, console and network slice, post-snapshot). Use `go_back` and `go_forward` for history.",
      inputSchema: {
        url: z.string().describe("Absolute URL with scheme, e.g. https://app.example.com/login."),
        ...ACTION_OPTS,
      },
    },
    async ({ url, mode, maxResultTokens, timeoutMs, session }) => {
      const g = host.gateCheck("navigate");
      if (g) return g;
      const e = await host.entryFor(session);
      // Engine dimension BEFORE the confirm hook: on an engine that declares
      // `navigate` refused, there is nothing for a human to approve — the tool
      // will not run whatever they answer, and asking would read as a policy
      // block rather than an engine limit.
      const eg = host.engineGate("navigate", e);
      if (eg) return eg;
      const decision = await confirmNavigation(url, host.confirmCtxFor(e));
      if (!decision.ok) return host.denyContent("navigate", decision);
      const td = host.actionTimeout({ timeoutMs });
      const result = await host.actionsFor(e).navigate({
        url,
        mode,
        maxResultTokens,
        deadlineMs: td.ms,
        deadlineWarning: td.warning,
      });
      // A redirect can land on an origin the policy holds, so the final URL
      // goes through the same hook as the requested one.
      const landed = result.navigation?.changed ? result.navigation.to : undefined;
      if (landed) {
        const after = await confirmLanding(url, landed, host.confirmCtxFor(e));
        if (!after.ok) {
          return host.denyContent("navigate", {
            reason: `${after.reason} (redirected to ${landed}; the page stays there)`,
          });
        }
      }
      return host.asActionResultText(Promise.resolve(result));
    },
  );

  actionTool(
    host,
    "click",
    {
      capability: "action",
      batchable: true,
      description:
        'Click an element. Target it by `ref` (preferred, from snapshot or find), `selector`, `named`, or `coords` ({x,y} viewport px, for canvas and custom-painted UIs). Prefer this over `act_and_diff` unless the change you need to see is a class or attribute edit. A stale ref errors: call snapshot or find again. `force:true` skips Playwright\'s actionability checks (visibility, stability, receives-events, hit-test); use it only on targets you verified clickable, for busy SPAs where the stability check never settles. `dispatch:"direct"` also skips the locator engine (chromium only); try it only after the default path and `force:true` both failed. Returns an ActionResult.',
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
        dispatch: z
          .enum(["actionability", "direct"])
          .optional()
          .describe(
            'How the click reaches the element. Default "actionability" — Playwright\'s locator path, with the automatic `force:true` recovery. "direct" resolves the target ONCE, then dispatches pointerdown/mousedown/pointerup/mouseup/click through CDP at its box centre, skipping the locator engine\'s pre-dispatch path (actionability checks, scroll-into-view, hit-target interceptor, and its retry loop). Events are TRUSTED (isTrusted:true), so framework handlers fire. Chromium-family engines only — structured refusal elsewhere, never a silent downgrade. This is the LAST resort, after the default path and `force:true` have both failed on a view whose layout or DOM never settles: it makes no visibility / stability / enabled / receives-events guarantee, so verify the target with snapshot/find or point_probe first and read `element.hit` on the result to see what was actually under the coordinate. Ignored for `coords` targets — those already dispatch through the same raw input path.',
          ),
        ...ACTION_OPTS,
      },
    },
    ({ args, e, target, recordingHint, td }) =>
      host.actionsFor(e).click({
        target,
        button: args.button,
        force: args.force,
        dispatch: args.dispatch,
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
      description:
        "Replace the value of an input, textarea or contenteditable, targeted by `ref`, `selector` or `named`. Use `fill_form` to set two or more fields in one call, and `select` or `choose_option` for dropdowns. A `value` of `<NAME>` is replaced with the registered secret of that name at dispatch (registering one requires the `secrets` capability, off by default). Returns an ActionResult; `element.value` shows what landed.",
      inputSchema: {
        ...REF_OR_SELECTOR,
        value: z
          .string()
          .describe(
            "Text to enter. Replaces the current value. `<NAME>` substitutes a registered secret.",
          ),
        ...ACTION_OPTS,
      },
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
        "Press one key or chord on a target element, or on the page when no target is given. Use `shortcut` for a sequence of chords or when you need proof the app handled the keys. Returns an ActionResult.",
      inputSchema: {
        ...REF_OR_SELECTOR,
        key: z
          .string()
          .describe(
            'Playwright key syntax: a key name ("Enter", "Escape"), a character, or a chord ("Control+A").',
          ),
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
        'Send a keyboard chord ("Control+C") or an ordered list of chords (["Control+A","Control+C"]) and report whether the app handled it: the active element, which keydown/copy/cut/paste listeners fired, and whether the app called preventDefault. Use `press` for a single key when you do not need that report. An optional `ref`/`selector` is focused first, else the chord goes to the page. Copy, cut and paste use a per-session clipboard buffer only with the `clipboard` capability (off by default); the OS clipboard is written at the copy/cut or paste moment and never read back. The handled-report works without it.',
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
            requirePage(e.session),
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
