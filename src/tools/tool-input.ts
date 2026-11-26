// A tool's arguments, checked against its declared input schema on every
// transport. The MCP SDK parses a `tools/call` payload before dispatch, but
// `batch`, the composing tools (`act_and_*`, `flake_check`), the in-process SDK
// and the socket server call the registered handler directly. Parsing here gives
// those callers the same contract: a wrong-typed or out-of-range argument is
// refused before the handler runs, and keys the schema does not name are
// dropped, as the SDK drops them.

import { z } from "zod";
import { errorResult, type TextResponse } from "./json-result.js";

const EMPTY_SHAPE: z.ZodRawShape = {};

/** One compiled object schema per declared shape. */
const compiled = new WeakMap<z.ZodRawShape, z.ZodObject<z.ZodRawShape>>();

function objectSchemaFor(shape: z.ZodRawShape): z.ZodObject<z.ZodRawShape> {
  const hit = compiled.get(shape);
  if (hit) return hit;
  const schema = z.object(shape);
  compiled.set(shape, schema);
  return schema;
}

/** The parsed arguments, or the `{ok:false, error}` result naming each argument
 *  that does not match. A call with no arguments is checked as `{}`. */
export function parseToolArgs(
  tool: string,
  shape: z.ZodRawShape | undefined,
  raw: unknown,
): { ok: true; args: unknown } | { ok: false; response: TextResponse } {
  const parsed = objectSchemaFor(shape ?? EMPTY_SHAPE).safeParse(raw ?? {});
  if (parsed.success) return { ok: true, args: parsed.data };
  return {
    ok: false,
    response: errorResult(
      `${tool}: the arguments do not match the tool's input schema.\n${z.prettifyError(parsed.error)}`,
    ),
  };
}
