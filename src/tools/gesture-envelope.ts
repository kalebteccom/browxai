import { estimateTokens } from "../util/tokens.js";
import type { GestureResult } from "../page/action-substrate.js";
import type { ToolResponse } from "./host.js";

/**
 * The one renderer for `ActionSubstrate.gesture`'s two outcomes, shared by
 * `input-tools` (touch_start / touch_move / touch_end) and `gesture-coord-tools`
 * (gesture_swipe / gesture_pinch).
 *
 * It exists because both halves of the JSON it produces are contracts that
 * predate it and must not move.
 *
 *   - A DISPATCHED gesture renders the substrate's evidence body followed by
 *     `tokensEstimate`, which is field-for-field what the five handlers emitted
 *     while they called `touchAction` / `gestureSwipe` / `gesturePinch` directly.
 *     The `report` is nested inside `GestureResult` precisely so the union's
 *     discriminant never reaches the wire.
 *   - A REFUSAL renders `{ok, error, engine, hint, tokensEstimate}` in that key
 *     order — the same envelope `engineRefusalText` (host-build.ts) builds for
 *     both engine-dimension gates, and the one
 *     `test/architecture/verify-engine-refusal.test.ts` pins. Until RFC 0009 P3
 *     these five tools WERE refused by that gate, on the `deep: true` flag; the
 *     flag retired so a native engine can reach the touch pipeline it needs, and
 *     an agent must not be able to tell the difference on the engines where the
 *     answer is unchanged.
 *
 * (RFC 0009 P3.)
 */
export function gestureResponse(r: GestureResult): ToolResponse {
  const body =
    r.kind === "refusal" ? { ok: false, error: r.error, engine: r.engine, hint: r.hint } : r.report;
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

/** The `{ok:false, error, tokensEstimate}` envelope the five gesture handlers
 *  render from their own `catch`. Shared for the same reason as the success
 *  path: five copies of it is five places for the shape to drift. */
export function gestureErrorResponse(err: unknown): ToolResponse {
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
