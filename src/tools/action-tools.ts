import { confirmNavigation, confirmByobAction } from "../policy/confirm.js";
import { withDeadline } from "../util/deadline.js";
import { runShortcut } from "../page/shortcut.js";
import { drag, doubleClick } from "../page/gestures.js";
import { ACTION_OPTS, REF_OR_SELECTOR, SESSION_ARG, TIMEOUT_ARG } from "./schemas.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ActionHost,
  ConfigHost,
  ServerServicesHost,
} from "./host.js";

/**
 * Navigation + core action tools — the verbs an agent drives a page with:
 * navigate / click / fill / press / shortcut / drag / double_click / hover /
 * select / wait_for / scroll / choose_option / go_back / go_forward /
 * set_viewport. Every block is registered through the shared `ToolHost` seam;
 * the host owns the closures (gate, confirm, ports), this module owns the
 * registrations.
 *
 * The parameter is narrowed to the sub-ports this family touches (RFC 0004 P3 /
 * D3 ISP) — the signature compiles a guarantee that the action family reaches
 * nothing outside gating, session resolution, action dispatch, and config.
 */
export function registerActionTools(
  host: RegisterHost & GateHost & SessionHost & ActionHost & ConfigHost & ServerServicesHost,
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

  host.register(
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
    async (args) => {
      const g = host.gateCheck("click");
      if (g) return g;
      const e = await host.entryFor(args.session);
      const c = await confirmByobAction("click", host.confirmCtxFor(e));
      if (!c.ok) return host.denyContent("click", c);
      const target = host.asTarget(args, "click", e.refs);
      const td = host.actionTimeout(args);
      return host.asActionResultText(
        host.actionsFor(e).click({
          target,
          button: args.button,
          force: args.force,
          mode: args.mode,
          maxResultTokens: args.maxResultTokens,
          recordingHint: host.hintFromTarget(e, target),
          deadlineMs: td.ms,
          deadlineWarning: td.warning,
        }),
      );
    },
  );

  host.register(
    "fill",
    {
      capability: "action",
      batchable: true,
      description: "Type into an input by `ref` or `selector`. Returns an ActionResult.",
      inputSchema: { ...REF_OR_SELECTOR, value: z.string(), ...ACTION_OPTS },
    },
    async (args) => {
      const g = host.gateCheck("fill");
      if (g) return g;
      const e = await host.entryFor(args.session);
      const c = await confirmByobAction("fill", host.confirmCtxFor(e));
      if (!c.ok) return host.denyContent("fill", c);
      const target = host.asTarget(args, "fill", e.refs);
      const td = host.actionTimeout(args);
      return host.asActionResultText(
        host.actionsFor(e).fill({
          target,
          value: args.value,
          mode: args.mode,
          maxResultTokens: args.maxResultTokens,
          recordingHint: host.hintFromTarget(e, target),
          deadlineMs: td.ms,
          deadlineWarning: td.warning,
        }),
      );
    },
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

  // A *factory* — each call returns a fresh schema instance. Reusing one
  // shared instance across `from`/`to`/`target` made zod-to-json-schema emit a
  // `$ref` for the repeats, which some MCP schema viewers render wrong (the
  // reported `drag.to.coords` showing as `string`). Distinct instances → no
  // `$ref` dedup → every field renders identically.
  const gestureTarget = () =>
    z.object({
      ref: z.string().optional().describe("Stable [eN] ref."),
      selector: z.string().optional().describe("CSS / selectorHint."),
      coords: z.object({ x: z.number(), y: z.number() }).optional().describe("Viewport CSS px."),
    });
  type GestureTargetArg = { ref?: string; selector?: string; coords?: { x: number; y: number } };
  const toActionTarget = (o: GestureTargetArg) => {
    if (o.coords) return { coords: o.coords };
    if (o.ref) return { ref: o.ref };
    if (o.selector) return { selector: o.selector };
    throw new Error("target requires one of ref / selector / coords");
  };

  host.register(
    "drag",
    {
      capability: "action",
      description:
        "Drag from one target to another: press at `from`, move to `to` over `steps` points, release. Each of `from`/`to` is `{ref}|{selector}|{coords}` (element targets press the box centre). `preflight:true` instead probes the `from` point and returns what's under it (top hit element + `resizeRisk` when a resize-handle cursor is present) WITHOUT dragging — check it first so a narrow item's edge doesn't get resized instead of moved. For timeline scrub/trim, drag-reorder, slider, lasso.",
      inputSchema: {
        from: gestureTarget().describe("Drag start: {ref}|{selector}|{coords}."),
        to: gestureTarget()
          .optional()
          .describe("Drag end: {ref}|{selector}|{coords}. Required unless `preflight:true`."),
        steps: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Intermediate mouse-move points (default 12); more = smoother/slower."),
        preflight: z
          .boolean()
          .optional()
          .describe(
            "When true, probe the `from` point and report what it hits (resize-handle risk) without dragging.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ from, to, steps, preflight, session }) => {
      const g = host.gateCheck("drag");
      if (g) return g;
      if (!preflight && !to) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: "drag: `to` is required unless `preflight:true`" },
                null,
                2,
              ),
            },
          ],
        };
      }
      const e = await host.entryFor(session);
      try {
        const r = await withDeadline(
          drag(e.session.page(), e.refs, {
            from: toActionTarget(from),
            to: to ? toActionTarget(to) : { coords: { x: 0, y: 0 } },
            steps,
            preflight,
          }),
          host.cfgActionTimeout(),
          "drag",
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
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

  host.register(
    "double_click",
    {
      capability: "action",
      description: "Double-click a target (`{ref}|{selector}|{coords}`).",
      inputSchema: {
        target: gestureTarget().describe("{ref}|{selector}|{coords}."),
        ...SESSION_ARG,
      },
    },
    async ({ target, session }) => {
      const g = host.gateCheck("double_click");
      if (g) return g;
      const e = await host.entryFor(session);
      try {
        const r = await withDeadline(
          doubleClick(e.session.page(), e.refs, toActionTarget(target) as never),
          host.cfgActionTimeout(),
          "double_click",
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
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

  host.register(
    "hover",
    {
      capability: "action",
      batchable: true,
      description: "Hover over an element by `ref` or `selector`. Returns an ActionResult.",
      inputSchema: { ...REF_OR_SELECTOR, ...ACTION_OPTS },
    },
    async (args) => {
      const g = host.gateCheck("hover");
      if (g) return g;
      const e = await host.entryFor(args.session);
      const c = await confirmByobAction("hover", host.confirmCtxFor(e));
      if (!c.ok) return host.denyContent("hover", c);
      const target = host.asTarget(args, "hover", e.refs);
      const td = host.actionTimeout(args);
      return host.asActionResultText(
        host.actionsFor(e).hover({
          target,
          mode: args.mode,
          maxResultTokens: args.maxResultTokens,
          recordingHint: host.hintFromTarget(e, target),
          deadlineMs: td.ms,
          deadlineWarning: td.warning,
        }),
      );
    },
  );

  host.register(
    "select",
    {
      capability: "action",
      batchable: true,
      description:
        "Select option(s) on a <select> by `ref` or `selector`. Returns an ActionResult.",
      inputSchema: { ...REF_OR_SELECTOR, values: z.array(z.string()), ...ACTION_OPTS },
    },
    async (args) => {
      const g = host.gateCheck("select");
      if (g) return g;
      const e = await host.entryFor(args.session);
      const c = await confirmByobAction("select", host.confirmCtxFor(e));
      if (!c.ok) return host.denyContent("select", c);
      const target = host.asTarget(args, "select", e.refs);
      const td = host.actionTimeout(args);
      return host.asActionResultText(
        host.actionsFor(e).select({
          target,
          values: args.values,
          mode: args.mode,
          maxResultTokens: args.maxResultTokens,
          recordingHint: host.hintFromTarget(e, target),
          deadlineMs: td.ms,
          deadlineWarning: td.warning,
        }),
      );
    },
  );

  host.register(
    "wait_for",
    {
      capability: "action",
      batchable: true,
      description:
        "Wait until an element is visible (`ref`/`selector`/`named`/`coords`), or until visible `text` appears anywhere on the page (SPA-readiness gating after a reload/nav). Pass exactly one of a target or `text`. Bounded by design — it CANNOT hang: `timeoutMs` is both the max wait and the anti-wedge deadline (default 5000, 1h hard cap). `ok:false` means the wait expired — on a healthy page that's a real negative (the element/text never appeared); if snapshot/navigate are also timing out it's a wedge symptom, so discard the session rather than re-issuing the wait. No arbitrary-JS predicate mode by design (that's `eval_js`, gated behind the `eval` capability). Returns an ActionResult.",
      inputSchema: {
        ...REF_OR_SELECTOR,
        text: z
          .string()
          .optional()
          .describe(
            "wait until this visible text appears (substring match). Mutually exclusive with a target.",
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
        "Scroll the page or a scroll container. One general primitive:\n" +
        "  - No target → scroll the window. Pass `to: top|bottom|left|right` or `by: {x,y}` (CSS px; +y = down).\n" +
        "  - `ref`/`selector`/`named` target, no `to`/`by` → scroll that element *into view* (lazy-load / virtualised lists).\n" +
        "  - element target + `to`/`by` → scroll *within* that container (set `intoView:false` is implied).\n" +
        "  - `coords` target → wheel-scroll at that point (canvas / map / WebGL panning).\n" +
        "Returns an ActionResult — scroll commonly triggers infinite-scroll XHRs and structure changes; read `network` / `structure` / `snapshotDelta` to see what loaded.",
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
        "Pick an option in a combobox / listbox / menu by visible text. Generic primitive for custom controls that aren't native `<select>` (so the `select` tool can't drive them). The `target` is the trigger control (the combobox itself); `option` is the visible text of the option to commit. Opens the control if not already expanded, waits for a visible listbox/menu/portal, clicks the resolved option element (no type-and-press-Enter), returns the probe on the trigger — `ownerControl.displayTextAfter` shows the committed selection.",
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
