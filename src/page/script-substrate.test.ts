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

describe("SafariScriptSubstrate", () => {
  it("wraps the expression in `return (…)`, runs it over execute/sync and returns the value", async () => {
    const { handle, calls, result } = safariHandle();
    result.value = { ok: 1 };
    const sub: ScriptSubstrate = new SafariScriptSubstrate(handle);
    const expr = "1 + 2";
    expect(await sub.evaluate(expr)).toEqual({ ok: 1 });
    expect(calls).toEqual([{ sessionId: "S", script: "return (1 + 2);" }]);
  });
});

describe("PlaywrightScriptSubstrate", () => {
  it("delegates the raw expression to page.evaluate verbatim (no wrapping)", async () => {
    const seen: string[] = [];
    const page = (() => ({
      evaluate: async (expr: string) => {
        seen.push(expr);
        return "v";
      },
    })) as unknown as () => Page;
    const sub: ScriptSubstrate = new PlaywrightScriptSubstrate(page);
    const expr = "document.title";
    const value = await sub.evaluate(expr);
    expect(seen).toEqual(["document.title"]);
    expect(value).toBe("v");
  });
});
