// Turns the `inputSchema` a plugin declares into the zod raw shape the MCP SDK's
// `registerTool` needs. The SDK builds an object schema from that shape and
// drops every key the shape does not name, so a tool that registers `{}` never
// sees its arguments over MCP.
//
// Two declaration forms are accepted:
//   - a zod raw shape (`{ msg: z.string() }`), passed through untouched;
//   - a JSON Schema object (`{ type: "object", properties, required }`), so a
//     plugin does not have to depend on zod. The converter covers the
//     everyday subset (string, number, integer, boolean, array, object, string
//     enum, descriptions, length and range bounds). Anything else becomes
//     `z.unknown()`, which accepts the value and drops nothing.

import { z } from "zod";

import type { PluginInputSchema, PluginJsonSchemaObject } from "./types.js";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** zod 3 keeps `_def` on schema instances and zod 4 keeps `_zod`; the MCP SDK
 *  makes the same test. */
const isZodSchema = (v: unknown): v is z.ZodTypeAny => isRecord(v) && ("_zod" in v || "_def" in v);

const isJsonSchemaObject = (v: unknown): v is PluginJsonSchemaObject =>
  isRecord(v) && v.type === "object" && (v.properties === undefined || isRecord(v.properties));

function withDescription(schema: z.ZodTypeAny, fragment: Record<string, unknown>): z.ZodTypeAny {
  return typeof fragment.description === "string" ? schema.describe(fragment.description) : schema;
}

function shapeFromProperties(
  properties: Record<string, unknown> | undefined,
  required: ReadonlySet<string>,
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(properties ?? {})) {
    const converted = fragmentToZod(isRecord(prop) ? prop : {});
    shape[key] = required.has(key) ? converted : converted.optional();
  }
  return shape;
}

function requiredSet(v: unknown): ReadonlySet<string> {
  return new Set(Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : []);
}

function fragmentToZod(fragment: Record<string, unknown>): z.ZodTypeAny {
  const { enum: enumValues } = fragment;
  if (
    Array.isArray(enumValues) &&
    enumValues.length > 0 &&
    enumValues.every((v) => typeof v === "string")
  ) {
    return withDescription(z.enum(enumValues as [string, ...string[]]), fragment);
  }
  let schema: z.ZodTypeAny;
  switch (fragment.type) {
    case "string": {
      let s = z.string();
      if (typeof fragment.minLength === "number") s = s.min(fragment.minLength);
      if (typeof fragment.maxLength === "number") s = s.max(fragment.maxLength);
      schema = s;
      break;
    }
    case "number":
    case "integer": {
      let n = z.number();
      if (fragment.type === "integer") n = n.int();
      if (typeof fragment.minimum === "number") n = n.min(fragment.minimum);
      if (typeof fragment.maximum === "number") n = n.max(fragment.maximum);
      schema = n;
      break;
    }
    case "boolean":
      schema = z.boolean();
      break;
    case "array":
      schema = z.array(isRecord(fragment.items) ? fragmentToZod(fragment.items) : z.unknown());
      break;
    case "object":
      schema = isRecord(fragment.properties)
        ? z
            .object(shapeFromProperties(fragment.properties, requiredSet(fragment.required)))
            .passthrough()
        : z.record(z.string(), z.unknown());
      break;
    default:
      schema = z.unknown();
  }
  return withDescription(schema, fragment);
}

/** A plugin tool's input, ready for `registerTool`. `passthrough` is set when
 *  the declaration is a JSON Schema object with `additionalProperties: true`:
 *  a raw shape cannot say "keep the other keys", so the caller wraps the shape
 *  in a loose zod object. */
export interface ToolInput {
  readonly shape: z.ZodRawShape;
  readonly passthrough: boolean;
}

/**
 * The registration input for a plugin tool's declared `inputSchema`.
 * `undefined` stays `undefined` and `{}` becomes an empty shape (an argless
 * tool). Throws when a raw shape holds a value that is not a zod schema, so a
 * malformed declaration fails the plugin's load with a message that names the
 * field.
 */
export function toToolInput(
  toolName: string,
  schema: PluginInputSchema | undefined,
): ToolInput | undefined {
  if (schema === undefined) return undefined;
  if (isJsonSchemaObject(schema)) {
    return {
      shape: shapeFromProperties(schema.properties, requiredSet(schema.required)),
      passthrough: schema.additionalProperties === true,
    };
  }
  for (const [key, value] of Object.entries(schema)) {
    if (!isZodSchema(value)) {
      throw new Error(
        `plugin tool "${toolName}": inputSchema field "${key}" is not a zod schema. ` +
          `Declare fields with zod, or pass a JSON Schema object ({ type: "object", properties, required }).`,
      );
    }
  }
  return { shape: schema, passthrough: false };
}
