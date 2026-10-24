import { confirmByobAction } from "../policy/confirm.js";
import { REF_OR_SELECTOR, ACTION_OPTS } from "./schemas.js";
import { actionTool, type ActionToolHost } from "./action-tool.js";
import type { ServerServicesHost } from "./host.js";

/**
 * Form/element action verbs: hover / select / wait_for / scroll / choose_option.
 * Split out of `action-tools` by cohesive family (RFC 0004 P3 / D3 SRP);
 * registered in the same source order. `hover` and `select` are canonical
 * confirm-gated target-resolving handlers, so they ride the `actionTool` wrapper
 * (RFC 0004 P3 / D4) — byte-identical to the prior hand-written body. wait_for
 * (text-vs-target branch), scroll (optional target + to/by), and choose_option
 * (coords-rejection branch) keep their own bodies.
 */
export function registerActionFormTools(host: ActionToolHost & ServerServicesHost): void {
  const { z } = host;

  actionTool(
    host,
    "hover",
    {
      capability: "action",
      batchable: true,
      description:
        "Move the pointer over an element, targeted by `ref`, `selector`, `named` or `coords`, to open menus, tooltips and hover states. Returns an ActionResult; an opened region shows in `structure.appeared`.",
      inputSchema: { ...REF_OR_SELECTOR, ...ACTION_OPTS },
    },
    ({ args, e, target, recordingHint, td }) =>
      host.actionsFor(e).hover({
        target,
        mode: args.mode,
        maxResultTokens: args.maxResultTokens,
        recordingHint,
        deadlineMs: td.ms,
        deadlineWarning: td.warning,
      }),
  );

  actionTool(
    host,
    "select",
    {
      capability: "action",
      batchable: true,
      description:
        "Choose option(s) of a native `<select>`, targeted by `ref`, `selector` or `named`. For a custom combobox, listbox or menu that is not a `<select>`, use `choose_option`. Returns an ActionResult.",
      inputSchema: {
        ...REF_OR_SELECTOR,
        values: z
          .array(z.string())
          .describe(
            "Option values or visible labels to select. Pass several only for a `multiple` select.",
          ),
        ...ACTION_OPTS,
      },
    },
    ({ args, e, target, recordingHint, td }) =>
      host.actionsFor(e).select({
        target,
        values: args.values,
        mode: args.mode,
        maxResultTokens: args.maxResultTokens,
        recordingHint,
        deadlineMs: td.ms,
        deadlineWarning: td.warning,
      }),
  );

  host.register(
    "wait_for",
    {
      capability: "action",
      batchable: true,
      description:
        "Wait until an element is visible (`ref`, `selector`, `named` or `coords`), or until visible `text` appears anywhere on the page, for SPA readiness after a reload or navigation. Pass exactly one of a target or `text`. Use `verify_visible` or `verify_text` when a miss should fail the step, `act_and_wait_for_network` to wait on a response, and `poll_eval` for a JS condition. `timeoutMs` is both the max wait and the anti-wedge deadline (default 5000, hard cap 3600000). `ok:false` means the wait expired: on a healthy page the element or text never appeared. If snapshot or navigate also time out, the session is wedged: call `close_session`, then `open_session` a fresh one. Returns an ActionResult.",
      inputSchema: {
        ...REF_OR_SELECTOR,
        text: z
          .string()
          .optional()
          .describe(
            "Visible text to wait for (substring match, anywhere on the page). Mutually exclusive with a target.",
          ),
        // wait_for's `timeoutMs` (from ACTION_OPTS) is *both* the max wait and
        // the anti-wedge deadline — a wait is meant to wait, so its ceiling is
        // the explicit knob (default 5000, hard max 1h, deterred).
        ...ACTION_OPTS,
      },
    },
    async (args) => {
      const g = host.gateCheck("wait_for");
      if (g) return g;
      const e = await host.entryFor(args.session);
      const td = host.actionTimeout(args);
      if (args.text !== undefined) {
        return host.asActionResultText(
          host.actionsFor(e).waitFor({
            text: args.text,
            timeoutMs: td.ms,
            deadlineMs: td.ms,
            deadlineWarning: td.warning,
            mode: args.mode,
            maxResultTokens: args.maxResultTokens,
          }),
        );
      }
      const target = host.asTarget(args, "wait_for", e.refs);
      return host.asActionResultText(
        host.actionsFor(e).waitFor({
          target,
          timeoutMs: td.ms,
          deadlineMs: td.ms,
          deadlineWarning: td.warning,
          mode: args.mode,
          maxResultTokens: args.maxResultTokens,
          recordingHint: host.hintFromTarget(e, target),
        }),
      );
    },
  );

  host.register(
    "scroll",
    {
      capability: "navigation",
      batchable: true,
      description:
        "Scroll the window, a scroll container, or an element into view. Targets:\n" +
        "  - No target → scroll the window. Pass `to: top|bottom|left|right` or `by: {x,y}` (CSS px; +y = down).\n" +
        "  - `ref`/`selector`/`named` target, no `to`/`by` → scroll that element *into view* (lazy-load / virtualised lists).\n" +
        "  - element target + `to`/`by` → scroll *within* that container (`intoView:false` is implied).\n" +
        "  - `coords` target → wheel-scroll at that point (canvas / map / WebGL panning).\n" +
        "Returns an ActionResult. Scrolling often triggers infinite-scroll requests, so read `network`, `structure` and `snapshotDelta` to see what loaded.",
      inputSchema: {
        ...REF_OR_SELECTOR,
        to: z
          .enum(["top", "bottom", "left", "right"])
          .optional()
          .describe("Scroll to an edge of the page (or targeted container)."),
        by: z
          .object({ x: z.number().optional(), y: z.number().optional() })
          .optional()
          .describe("Wheel-style delta in CSS px. +y scrolls down, +x scrolls right."),
        intoView: z
          .boolean()
          .optional()
          .describe(
            "When a target element is given: scroll it into view. Default true unless `to`/`by` is set.",
          ),
        ...ACTION_OPTS,
      },
    },
    async (args) => {
      const g = host.gateCheck("scroll");
      if (g) return g;
      const e = await host.entryFor(args.session);
      const c = await confirmByobAction("scroll", host.confirmCtxFor(e));
      if (!c.ok) return host.denyContent("scroll", c);
      const hasTarget = !!(args.ref || args.selector || args.named || args.coords);
      const target = hasTarget ? host.asTarget(args, "scroll", e.refs) : undefined;
      const td = host.actionTimeout(args);
      return host.asActionResultText(
        host.actionsFor(e).scroll({
          target,
          to: args.to,
          by: args.by,
          intoView: args.intoView,
          mode: args.mode,
          maxResultTokens: args.maxResultTokens,
          recordingHint: target ? host.hintFromTarget(e, target) : undefined,
          deadlineMs: td.ms,
          deadlineWarning: td.warning,
        }),
      );
    },
  );

  host.register(
    "choose_option",
    {
      capability: "action",
      batchable: true,
      description:
        "Pick an option in a custom combobox, listbox or menu by visible text. Use `select` for a native `<select>`. Target the trigger control (the combobox itself) with `ref`, `selector` or `named`; `coords` is refused. `option` is the visible text to commit. Opens the control if it is closed, waits for the listbox or menu, and clicks the matching option. Returns an ActionResult; `ownerControl.displayTextAfter` shows the committed selection.",
      inputSchema: {
        ...REF_OR_SELECTOR,
        option: z.string().describe("Visible text of the option to commit."),
        exact: z
          .boolean()
          .optional()
          .describe(
            "Exact-text match (default true). When false, the option is matched as a substring.",
          ),
        ...ACTION_OPTS,
      },
    },
    async (args) => {
      const g = host.gateCheck("choose_option");
      if (g) return g;
      const e = await host.entryFor(args.session);
      const c = await confirmByobAction("choose_option", host.confirmCtxFor(e));
      if (!c.ok) return host.denyContent("choose_option", c);
      const target = host.asTarget(args, "choose_option", e.refs);
      if ("coords" in target) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error:
                    "choose_option requires a ref/selector/named target (the combobox/menu trigger), not coords",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const td = host.actionTimeout(args);
      return host.asActionResultText(
        host.actionsFor(e).chooseOption({
          target,
          option: args.option,
          exact: args.exact,
          mode: args.mode,
          maxResultTokens: args.maxResultTokens,
          recordingHint: host.hintFromTarget(e, target),
          deadlineMs: td.ms,
          deadlineWarning: td.warning,
        }),
      );
    },
  );
}
