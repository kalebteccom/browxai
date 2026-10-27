import { withDeadline } from "../util/deadline.js";
import { drag, doubleClick } from "../page/gestures.js";
import { SESSION_ARG } from "./schemas.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ActionHost,
  ElementHost,
  ServerServicesHost,
} from "./host.js";
import { requirePage } from "../engine/index.js";

/**
 * Gesture action tools: drag / double_click. Both take the coords-capable
 * `gestureTarget` shape and dispatch through the lower-half gesture helpers under
 * `withDeadline` + a structured try/catch — a shape distinct from the canonical
 * action pipeline, so they keep their own bodies. Split out of `action-tools` by
 * cohesive family (RFC 0004 P3 / D3 SRP); registered in the same source order.
 */
export function registerActionGestureTools(
  host: RegisterHost & GateHost & SessionHost & ActionHost & ElementHost & ServerServicesHost,
): void {
  const { z } = host;

  // A *factory* — each call returns a fresh schema instance. Reusing one
  // shared instance across `from`/`to`/`target` made zod-to-json-schema emit a
  // `$ref` for the repeats, which some MCP schema viewers render wrong (the
  // reported `drag.to.coords` showing as `string`). Distinct instances → no
  // `$ref` dedup → every field renders identically.
  const gestureTarget = () =>
    z.object({
      ref: z.string().optional().describe("Stable [eN] ref from snapshot() or find()."),
      selector: z.string().optional().describe("CSS selector or a `selectorHint` from find()."),
      coords: z
        .object({ x: z.number(), y: z.number() })
        .optional()
        .describe("Viewport point in CSS px."),
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
        "Drag from one target to another with the mouse: press at `from`, move to `to` over `steps` points, release. `from` and `to` are each `{ref}|{selector}|{coords}` (element targets press the box centre). Set `preflight:true` to probe the `from` point and return what is under it (top hit element, plus `resizeRisk` when a resize-handle cursor is present) without dragging; run it first so a narrow item's edge is not resized instead of moved. For timeline scrub and trim, drag-reorder, sliders and lasso. Touch handlers ignore mouse events: use `gesture_swipe` there.",
      inputSchema: {
        from: gestureTarget().describe("Drag start: one of ref, selector, coords."),
        to: gestureTarget()
          .optional()
          .describe("Drag end: one of ref, selector, coords. Required unless `preflight:true`."),
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
          drag(requirePage(e.session), host.elementFor(e), {
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
      description:
        "Double-click a target, given as `{ref}|{selector}|{coords}`. Use `click` for a single click.",
      inputSchema: {
        target: gestureTarget().describe(
          "Element or point to double-click: one of ref, selector, coords.",
        ),
        ...SESSION_ARG,
      },
    },
    async ({ target, session }) => {
      const g = host.gateCheck("double_click");
      if (g) return g;
      const e = await host.entryFor(session);
      try {
        const r = await withDeadline(
          doubleClick(requirePage(e.session), host.elementFor(e), toActionTarget(target) as never),
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
}
