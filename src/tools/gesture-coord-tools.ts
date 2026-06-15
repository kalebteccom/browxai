import { withDeadline } from "../util/deadline.js";
import { estimateTokens } from "../util/tokens.js";
import { mouseWheel, gesturePinch, gestureSwipe } from "../page/gestures.js";
import { requireCdp } from "../engine/session-cdp.js";
import { SESSION_ARG } from "./schemas.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ActionHost,
  ServerServicesHost,
} from "./host.js";

/**
 * Coordinate-space gesture tools: mouse_wheel / gesture_pinch / gesture_swipe.
 * CDP-deep touch/wheel primitives dispatched at viewport coords. Split out of
 * `gesture-network-tools` by cohesive family (RFC 0004 P3 / D3 SRP); registered
 * through the shared `ToolHost` seam in the same source order.
 */
export function registerGestureCoordTools(
  host: RegisterHost & GateHost & SessionHost & ActionHost & ServerServicesHost,
): void {
  const { z, register, gateCheck, engineGate, entryFor, cfgActionTimeout } = host;

  register(
    "mouse_wheel",
    {
      capability: "action",
      deep: true,
      description:
        "Coordinate-space wheel event — dispatched via CDP at `coords` (viewport CSS px) regardless of the current pointer position. For canvas, virtualised lists, and map tiles that listen for `wheel` and ignore element-level scroll. `deltaX`/`deltaY` are CSS px (DOM `WheelEvent` convention: positive `deltaY` scrolls content up); at least one must be non-zero.",
      inputSchema: {
        coords: z
          .object({ x: z.number(), y: z.number() })
          .describe("Viewport CSS px — where the wheel event fires."),
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
      deep: true,
      description:
        "Two-finger pinch in/out centred on `coords`. Two touch points start at `coords ± startOffset` (default 40 CSS px) and converge or diverge linearly so the final separation = `startOffset × scale`. `scale < 1` is pinch-in (zoom out); `scale > 1` is pinch-out (zoom in). Linear interpolation across `steps` (default 12, clamped 1–100) — pinch handlers read inter-frame deltas; a velocity-detecting curve can misfire fling heuristics, linear is the safe default. Dispatches via CDP touch pipeline; touch does not fire mouse events automatically.",
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
      const eg = engineGate("gesture_pinch", e);
      if (eg) return eg;
      try {
        const r = await withDeadline(
          gesturePinch(requireCdp(e.session), { coords, scale, steps, startOffset }),
          cfgActionTimeout(),
          "gesture_pinch",
        );
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
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
    "gesture_swipe",
    {
      capability: "action",
      deep: true,
      description:
        "Single-finger swipe from `from` to `to` via the touch pipeline. Distinct from `drag` (mouse pipeline) — mobile carousels, pull-to-refresh, swipeable list items wire touch handlers that ignore mouse events. `durationMs` (default 200 — fast flick; 500+ reads as deliberate scroll) is split across `steps` (default 16, clamped 1–200) touchMove dispatches. Smoothed via an ease-out curve (`1 - (1 - t)²`) — matches the natural deceleration most fling-detect heuristics are tuned for (Hammer.js, native scroll inertia, react-spring physics).",
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
      const eg = engineGate("gesture_swipe", e);
      if (eg) return eg;
      try {
        const r = await withDeadline(
          gestureSwipe(requireCdp(e.session), { from, to, durationMs, steps, identifier }),
          cfgActionTimeout(),
          "gesture_swipe",
        );
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
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
