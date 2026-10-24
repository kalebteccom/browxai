import { withDeadline } from "../util/deadline.js";
import { mouseWheel } from "../page/gestures.js";
import { requireCdp } from "../engine/session-cdp.js";
import { SESSION_ARG } from "./schemas.js";
import { gestureErrorResponse, gestureResponse } from "./gesture-envelope.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ActionHost,
  ServerServicesHost,
} from "./host.js";

/**
 * Coordinate-space gesture tools: mouse_wheel / gesture_pinch / gesture_swipe.
 * Touch and wheel primitives dispatched at viewport coords. Split out of
 * `gesture-network-tools` by cohesive family (RFC 0004 P3 / D3 SRP); registered
 * through the shared `ToolHost` seam in the same source order.
 *
 * The two families are gated differently on purpose, and RFC 0009 P3 is where
 * they parted. `gesture_pinch` / `gesture_swipe` go through
 * `ActionSubstrate.gesture`, so the "this engine cannot dispatch touch" refusal
 * is the substrate's and a native engine can answer it. `mouse_wheel` keeps
 * `deep: true`: it is a CDP `Input.dispatchMouseEvent` at a coordinate, no port
 * covers it, and a native target has no wheel to dispatch — widening the port for
 * it would be a member no second engine could implement.
 */
export function registerGestureCoordTools(
  host: RegisterHost & GateHost & SessionHost & ActionHost & ServerServicesHost,
): void {
  const { z, register, gateCheck, engineGate, entryFor, actionsFor, cfgActionTimeout } = host;

  register(
    "mouse_wheel",
    {
      capability: "action",
      deep: true,
      description:
        "Fire a wheel event at viewport `coords` (CSS px) through CDP, whatever the pointer position. Use `scroll` for ordinary page or container scrolling, and this for canvas, virtualised lists and map tiles that listen for `wheel` and ignore element scroll. `deltaX` and `deltaY` are CSS px (DOM `WheelEvent` convention: positive `deltaY` scrolls down); at least one must be non-zero.",
      inputSchema: {
        coords: z
          .object({ x: z.number(), y: z.number() })
          .describe("Viewport point in CSS px where the wheel event fires."),
        deltaX: z.number().optional().describe("Horizontal wheel delta in CSS px (default 0)."),
        deltaY: z.number().optional().describe("Vertical wheel delta in CSS px (default 0)."),
        ...SESSION_ARG,
      },
    },
    async ({ coords, deltaX, deltaY, session }) => {
      const g = gateCheck("mouse_wheel");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("mouse_wheel", e);
      if (eg) return eg;
      try {
        const r = await withDeadline(
          mouseWheel(requireCdp(e.session), { coords, deltaX, deltaY }),
          cfgActionTimeout(),
          "mouse_wheel",
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

  register(
    "gesture_pinch",
    {
      capability: "action",
      description:
        "Two-finger pinch centred on `coords`. Two touch points start at `coords ± startOffset` (default 40 CSS px) and move linearly so the final separation is `startOffset × scale`: `scale < 1` pinches in (zooms out), `scale > 1` pinches out (zooms in). `steps` (default 12, clamped 1-100) sets the intermediate touchMove count; linear motion is the safe default because velocity curves can trip fling heuristics. It uses the CDP touch pipeline, which does not fire mouse events. Use `gesture_swipe` for one finger.",
      inputSchema: {
        coords: z
          .object({ x: z.number(), y: z.number() })
          .describe("Pinch centre, viewport CSS px."),
        scale: z
          .number()
          .positive()
          .describe(
            "Final separation / initial separation. <1 = pinch-in (zoom out); >1 = pinch-out (zoom in).",
          ),
        steps: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Intermediate touchMove dispatches (default 12)."),
        startOffset: z
          .number()
          .positive()
          .optional()
          .describe("Initial half-separation in CSS px (default 40)."),
        ...SESSION_ARG,
      },
    },
    async ({ coords, scale, steps, startOffset, session }) => {
      const g = gateCheck("gesture_pinch");
      if (g) return g;
      const e = await entryFor(session);
      try {
        return gestureResponse(
          await withDeadline(
            actionsFor(e).gesture({ kind: "pinch", coords, scale, steps, startOffset }),
            cfgActionTimeout(),
            "gesture_pinch",
          ),
        );
      } catch (err) {
        return gestureErrorResponse(err);
      }
    },
  );

  register(
    "gesture_swipe",
    {
      capability: "action",
      description:
        "Single-finger swipe from `from` to `to` through the touch pipeline, for mobile carousels, pull-to-refresh and swipeable rows whose touch handlers ignore mouse events. Use `drag` for the mouse pipeline. `durationMs` (default 200, a fast flick; 500 or more reads as a deliberate scroll) is split across `steps` touchMove events (default 16, clamped 1-200) on an ease-out curve (`1 - (1 - t)²`) that matches the deceleration most fling detectors expect (Hammer.js, native inertia, react-spring).",
      inputSchema: {
        from: z.object({ x: z.number(), y: z.number() }).describe("Swipe start, viewport CSS px."),
        to: z.object({ x: z.number(), y: z.number() }).describe("Swipe end, viewport CSS px."),
        durationMs: z
          .number()
          .int()
          .nonnegative()
          .max(60_000)
          .optional()
          .describe("Total swipe duration in ms (default 200)."),
        steps: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("Intermediate touchMove dispatches (default 16)."),
        identifier: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Touch identifier (default 1)."),
        ...SESSION_ARG,
      },
    },
    async ({ from, to, durationMs, steps, identifier, session }) => {
      const g = gateCheck("gesture_swipe");
      if (g) return g;
      const e = await entryFor(session);
      try {
        return gestureResponse(
          await withDeadline(
            actionsFor(e).gesture({ kind: "swipe", from, to, durationMs, steps, identifier }),
            cfgActionTimeout(),
            "gesture_swipe",
          ),
        );
      } catch (err) {
        return gestureErrorResponse(err);
      }
    },
  );
}
