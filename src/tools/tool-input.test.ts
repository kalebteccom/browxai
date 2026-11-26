import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseToolArgs } from "./tool-input.js";

const SHAPE = {
  name: z.string(),
  ttlSeconds: z.number().int().positive().max(60).optional(),
};

const errorOf = (r: ReturnType<typeof parseToolArgs>): string => {
  expect(r.ok).toBe(false);
  if (r.ok) return "";
  const body = JSON.parse((r.response.content[0] as { text: string }).text);
  expect(body.ok).toBe(false);
  return body.error as string;
};

describe("parseToolArgs", () => {
  it("returns the parsed arguments, without keys the schema does not name", () => {
    expect(parseToolArgs("probe", SHAPE, { name: "a", ttlSeconds: 5, extra: 1 })).toEqual({
      ok: true,
      args: { name: "a", ttlSeconds: 5 },
    });
  });

  it("names the tool and each argument that does not match", () => {
    const error = errorOf(parseToolArgs("probe", SHAPE, { name: 1, ttlSeconds: 61 }));
    expect(error).toMatch(/^probe: the arguments do not match the tool's input schema\./);
    expect(error).toContain("→ at name");
    expect(error).toContain("→ at ttlSeconds");
  });

  it("refuses a missing required argument", () => {
    expect(errorOf(parseToolArgs("probe", SHAPE, {}))).toContain("→ at name");
  });

  it("checks no arguments as an empty object", () => {
    expect(parseToolArgs("probe", undefined, undefined)).toEqual({ ok: true, args: {} });
    expect(parseToolArgs("probe", { name: z.string().optional() }, undefined)).toEqual({
      ok: true,
      args: {},
    });
  });

  it("refuses arguments that are not an object", () => {
    expect(errorOf(parseToolArgs("probe", SHAPE, "name"))).toContain("expected object");
  });
});
