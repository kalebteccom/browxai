import { estimateTokens } from "../util/tokens.js";

/** A response with one text item, which is what every JSON-returning tool sends. */
export interface TextResponse {
  content: Array<{ type: "text"; text: string }>;
}

/**
 * The two JSON envelopes the tool families put on the wire, and the one place
 * that builds either. Which of the two a tool uses is part of its documented
 * output, so a handler picks by name and never spells the envelope out.
 *
 *   - BARE (`jsonResult`): the body, pretty-printed with two spaces.
 *   - ESTIMATED (`jsonResultWithEstimate`): the body, then `tokensEstimate`
 *     computed over the body's compact JSON, pretty-printed the same way.
 *
 * `src/tools/tool-result-envelope.test.ts` pins the text per tool.
 */
export function jsonResult(body: unknown): TextResponse {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
}

export function jsonResultWithEstimate(body: object): TextResponse {
  return jsonResult({ ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) });
}

/** The `{ok: false, error}` body a handler renders from its own `catch`. */
export function errorBody(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/** A caught error in the BARE envelope. */
export function errorResult(err: unknown): TextResponse {
  return jsonResult(errorBody(err));
}

/** A caught error in the ESTIMATED envelope. */
export function errorResultWithEstimate(err: unknown): TextResponse {
  return jsonResultWithEstimate(errorBody(err));
}

/**
 * Run `fn` and render what it returns in the ESTIMATED envelope; a throw, sync
 * or async, becomes `{ok: false, error}` in the same envelope. For the handler
 * whose whole body after the gates is "compute a result, send it". A handler
 * that returns early with a ready response, or whose error envelope is BARE,
 * keeps its own `try` and calls the builders above.
 */
export async function jsonToolResult(fn: () => object | Promise<object>): Promise<TextResponse> {
  try {
    return jsonResultWithEstimate(await fn());
  } catch (err) {
    return errorResultWithEstimate(err);
  }
}
