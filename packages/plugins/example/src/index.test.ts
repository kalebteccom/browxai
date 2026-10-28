// Unit-test the example plugin handlers in isolation — no runtime,
// no server, no MCP transport. The keystone covers the
// register-through-MCP-end-to-end path; this file just proves the
// handlers themselves do what they say.

import { describe, it, expect } from "vitest";
import { handlers } from "./index.js";

function parseFirst(res: {
  content: ReadonlyArray<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const first = res.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text!) as Record<string, unknown>;
}

describe("@browxai/plugin-example handlers", () => {
  it.each([
    {
      label: "echo defaults to empty string when msg is missing",
      run: () => handlers.echo({}),
      expected: { ok: true, result: "" },
    },
    {
      label: "add defaults missing args to 0",
      run: () => handlers.add({}),
      expected: { ok: true, sum: 0 },
    },
  ])("$label", async ({ run, expected }) => {
    expect(parseFirst(await run())).toEqual(expected);
  });

  it("now returns ISO + epoch", async () => {
    const res = await handlers.now();
    const parsed = parseFirst(res);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.iso).toBe("string");
    expect(typeof parsed.epochMs).toBe("number");
  });
});
