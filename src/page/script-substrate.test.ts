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
// per-handler `if (sh)` branch in `eval_js` (RFC 0003). The deadline race + error
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
  it("tags the safari engine", () => {
    const { handle } = safariHandle();
    expect(new SafariScriptSubstrate(handle).engine).toBe("safari");
  });

  it("wraps the expression in `return (…)` and runs it over execute/sync", async () => {
    const { handle, calls } = safariHandle();
    const sub: ScriptSubstrate = new SafariScriptSubstrate(handle);
    const expr = "1 + 2";
    await sub.evaluate(expr);
    expect(calls).toEqual([{ sessionId: "S", script: "return (1 + 2);" }]);
  });

  it("returns the page-controlled value from the WebDriver client", async () => {
    const { handle, result } = safariHandle();
    result.value = { ok: 1 };
    const sub = new SafariScriptSubstrate(handle);
    const expr = "window.__x";
    expect(await sub.evaluate(expr)).toEqual({ ok: 1 });
  });
});

describe("PlaywrightScriptSubstrate", () => {
  it("tags the supplied engine (default chromium)", () => {
    const page = (() => ({ evaluate: async () => undefined })) as unknown as () => Page;
    expect(new PlaywrightScriptSubstrate(page).engine).toBe("chromium");
    expect(new PlaywrightScriptSubstrate(page, "firefox").engine).toBe("firefox");
  });

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
