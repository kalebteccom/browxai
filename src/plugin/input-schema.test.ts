import { describe, expect, it } from "vitest";
import { z } from "zod";

import { toToolInput } from "./input-schema.js";
import type { PluginJsonSchemaObject } from "./types.js";

const shapeOf = (schema: PluginJsonSchemaObject): z.ZodRawShape => {
  const input = toToolInput("p.t", schema);
  if (!input) throw new Error("expected a converted input");
  return input.shape;
};

const parse = (shape: z.ZodRawShape, value: unknown) => z.object(shape).safeParse(value);

describe("toToolInput", () => {
  it.each([
    { label: "leaves an undeclared schema undeclared", schema: undefined, expected: undefined },
    {
      label: "keeps an empty declaration empty, so an argless tool stays argless",
      schema: {},
      expected: { shape: {}, passthrough: false },
    },
  ])("$label", ({ schema, expected }) => {
    expect(toToolInput("p.t", schema)).toEqual(expected);
  });

  it("passes a zod raw shape through untouched", () => {
    const shape = { msg: z.string() };
    const input = toToolInput("p.t", shape);
    expect(input?.shape).toBe(shape);
    expect(input?.passthrough).toBe(false);
  });

  it("rejects a raw shape that holds a non-zod value, naming the tool and field", () => {
    const bad = { msg: { type: "string" } } as never;
    expect(() => toToolInput("p.t", bad)).toThrow(/plugin tool "p\.t".*field "msg"/);
  });

  it("converts a JSON Schema object so declared fields survive and others drop", () => {
    const shape = shapeOf({
      type: "object",
      properties: {
        msg: { type: "string", description: "text to echo" },
        count: { type: "integer", minimum: 1, maximum: 5 },
        loud: { type: "boolean" },
      },
      required: ["msg"],
    });
    const ok = parse(shape, { msg: "hi", count: 2, loud: true, stray: 1 });
    expect(ok.success).toBe(true);
    expect(ok.data).toEqual({ msg: "hi", count: 2, loud: true });
  });

  it("flags passthrough only for `additionalProperties: true`", () => {
    const base = { type: "object", properties: { a: { type: "number" } } } as const;
    expect(toToolInput("p.t", base)?.passthrough).toBe(false);
    expect(toToolInput("p.t", { ...base, additionalProperties: false })?.passthrough).toBe(false);
    expect(toToolInput("p.t", { ...base, additionalProperties: true })?.passthrough).toBe(true);
  });

  it("treats properties outside `required` as optional and enforces required ones", () => {
    const shape = shapeOf({
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a"],
    });
    expect(parse(shape, { a: 1 }).success).toBe(true);
    expect(parse(shape, { b: 1 }).success).toBe(false);
  });

  it("enforces types, integer and range bounds", () => {
    const shape = shapeOf({
      type: "object",
      properties: { n: { type: "integer", minimum: 1, maximum: 5 }, s: { type: "string" } },
    });
    expect(parse(shape, { n: 1.5 }).success).toBe(false);
    expect(parse(shape, { n: 6 }).success).toBe(false);
    expect(parse(shape, { s: 3 }).success).toBe(false);
  });

  it("converts string enums, arrays and nested objects", () => {
    const shape = shapeOf({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["a", "b"] },
        ids: { type: "array", items: { type: "string" } },
        fill: {
          type: "object",
          properties: { r: { type: "number" }, g: { type: "number" } },
          required: ["r"],
        },
        bag: { type: "object" },
      },
    });
    expect(parse(shape, { mode: "c" }).success).toBe(false);
    expect(parse(shape, { ids: ["x", 2] }).success).toBe(false);
    expect(parse(shape, { fill: { g: 1 } }).success).toBe(false);
    const value = {
      mode: "a",
      ids: ["x"],
      fill: { r: 1, extra: true },
      bag: { anything: [1] },
    };
    expect(parse(shape, value).data).toEqual(value);
  });

  it("accepts any value for a keyword it does not convert", () => {
    const shape = shapeOf({
      type: "object",
      properties: { v: { anyOf: [{ type: "string" }, { type: "number" }] } },
    });
    expect(parse(shape, { v: 3 }).data).toEqual({ v: 3 });
    expect(parse(shape, { v: "x" }).data).toEqual({ v: "x" });
  });

  it("carries descriptions into the converted schema", () => {
    const shape = shapeOf({
      type: "object",
      properties: { msg: { type: "string", description: "text to echo" } },
      required: ["msg"],
    });
    expect((shape.msg as z.ZodType | undefined)?.description).toBe("text to echo");
  });
});
