import { describe, it, expect } from "vitest";
import {
  PlaywrightScriptSubstrate,
  SafariScriptSubstrate,
  type ScriptSubstrate,
} from "./script-substrate.js";
import type { SafariSessionHandle } from "../engine/index.js";
import type { Page } from "playwright-core";

// The ScriptSubstrate port routing. PlaywrightScriptSubstrate is `page.evaluate`
// verbatim (covered by the per-engine keystones); these cover the Safari adapter's
// `execute/sync` path + the `return (…)` expression wrapping that replaced the
// per-handler `if (sh)` branch in `eval_js`. The deadline race + error
// envelope live in the handler, not the substrate, so they are not exercised here.

function safariHandle(): {
  handle: SafariSessionHandle;
  calls: Array<{ sessionId: string; script: string }>;
  result: { value: unknown };
} {
  const calls: Array<{ sessionId: string; script: string }> = [];
  const result = { value: undefined as unknown };
  const handle = {
    sessionId: "S",
    webDriver: {
      executeScript: async (sessionId: string, script: string) => {
        calls.push({ sessionId, script });
        return result.value;
      },
    },
  } as unknown as SafariSessionHandle;
  return { handle, calls, result };
}

describe("ScriptSubstrate adapters", () => {
  it.each([
    {
      name: "SafariScriptSubstrate wraps the expression in `return (…)`, runs it over execute/sync and returns the value",
      expr: "1 + 2",
      value: { ok: 1 },
      make: (expr: string) => {
        const { handle, calls, result } = safariHandle();
        result.value = { ok: 1 };
        const sub: ScriptSubstrate = new SafariScriptSubstrate(handle);
        return { run: () => sub.evaluate(expr), seen: () => calls };
      },
      expectedSeen: [{ sessionId: "S", script: "return (1 + 2);" }],
    },
    {
      name: "PlaywrightScriptSubstrate delegates the raw expression to page.evaluate verbatim (no wrapping)",
      expr: "document.title",
      value: "v",
      make: (expr: string) => {
        const seen: string[] = [];
        const page = (() => ({
          evaluate: async (e: string) => {
            seen.push(e);
            return "v";
          },
        })) as unknown as () => Page;
        const sub: ScriptSubstrate = new PlaywrightScriptSubstrate(page);
        return { run: () => sub.evaluate(expr), seen: () => seen };
      },
      expectedSeen: ["document.title"],
    },
  ])("$name", async ({ expr, value, make, expectedSeen }) => {
    const driven = make(expr);
    expect(await driven.run()).toEqual(value);
    expect(driven.seen()).toEqual(expectedSeen);
  });
});
