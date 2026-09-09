import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  lowerTraceToSpec,
  lowerStep,
  locatorExprFromHint,
  parseCheck,
} from "./export-playwright-script.js";
import { Recorder } from "./recording.js";
import type { RecordedReadStep } from "./recording.js";
import { resolveWorkspacePath } from "../session/storage.js";

describe("export_playwright_script — lowering", () => {
  it("emits a complete spec shell for an empty recording", () => {
    const r = lowerTraceToSpec("empty-flow", []);
    expect(r.stats.steps).toBe(0);
    expect(r.source).toContain(`import { test, expect } from "@playwright/test"`);
    expect(r.source).toContain(`test("empty-flow", async ({ page }) =>`);
    expect(r.source).toContain("// No steps recorded.");
    expect(parseCheck(r.source).ok).toBe(true);
  });

  it("lowers navigate / click / fill into runnable Playwright calls", () => {
    const steps = [
      {
        id: "open-1",
        kind: "action" as const,
        action: { type: "navigate", url: "https://app.example.com/login" },
        url: "https://app.example.com/login",
        ts: 0,
      },
      {
        id: "fill-1",
        kind: "action" as const,
        action: { type: "fill", ref: "e1", value: "alice" },
        url: "https://app.example.com/login",
        selectorHint: '[data-testid="username"]',
        stability: "high" as const,
        ts: 0,
      },
      {
        id: "click-1",
        kind: "action" as const,
        action: { type: "click", ref: "e2" },
        url: "https://app.example.com/",
        selectorHint: 'role=button[name="Sign in"]',
        stability: "medium" as const,
        ts: 0,
      },
    ];
    const r = lowerTraceToSpec("login-flow", steps);
    expect(r.stats.steps).toBe(3);
    expect(r.stats.handled).toBe(3);
    expect(r.stats.unhandled).toBe(0);
    expect(r.source).toContain(`await page.goto("https://app.example.com/login");`);
    expect(r.source).toContain(`await page.locator("[data-testid=\\"username\\"]").fill("alice");`);
    expect(r.source).toContain(`await page.getByRole("button", { name: "Sign in" }).click();`);
    expect(parseCheck(r.source).ok).toBe(true);
  });

  it("inserts a fragile-selector TODO when stability is low", () => {
    const r = lowerTraceToSpec("fragile-flow", [
      {
        id: "click-1",
        kind: "action" as const,
        action: { type: "click", ref: "e1" },
        url: "https://x.example.com",
        selectorHint: "role=button",
        stability: "low" as const,
        ts: 0,
      },
    ]);
    expect(r.stats.fragile).toBe(1);
    expect(r.source).toContain("// TODO: fragile selector");
    expect(r.source).toContain(`await page.getByRole("button").click();`);
    expect(parseCheck(r.source).ok).toBe(true);
  });

  it("lowers role+name, attribute, and role-only locators correctly", () => {
    expect(locatorExprFromHint('[data-testid="x"]')).toBe(`page.locator("[data-testid=\\"x\\"]")`);
    expect(locatorExprFromHint('role=button[name="OK"]')).toBe(
      `page.getByRole("button", { name: "OK" })`,
    );
    expect(locatorExprFromHint("role=textbox")).toBe(`page.getByRole("textbox")`);
    // Fall-through — anything else is wrapped as a raw locator.
    expect(locatorExprFromHint(".some-class")).toBe(`page.locator(".some-class")`);
  });

  it("lowers select, press (with + without target), and waitFor", () => {
    const pressNoTarget = lowerStep({
      id: "press-1",
      kind: "action" as const,
      action: { type: "press", value: "Enter" },
      url: "u",
      ts: 0,
    });
    expect(pressNoTarget.lines).toEqual([`await page.keyboard.press("Enter");`]);
    expect(pressNoTarget.handled).toBe(true);

    const pressTargeted = lowerStep({
      id: "press-2",
      kind: "action" as const,
      action: { type: "press", ref: "e1", value: "Enter" },
      url: "u",
      selectorHint: '[data-testid="search"]',
      stability: "high",
      ts: 0,
    });
    expect(pressTargeted.lines).toEqual([
      `await page.locator("[data-testid=\\"search\\"]").press("Enter");`,
    ]);

    const sel = lowerStep({
      id: "select-1",
      kind: "action" as const,
      action: { type: "select", ref: "e1", value: "a, b" },
      url: "u",
      selectorHint: '[data-testid="picker"]',
      stability: "high",
      ts: 0,
    });
    expect(sel.lines).toEqual([
      `await page.locator("[data-testid=\\"picker\\"]").selectOption(["a", "b"]);`,
    ]);

    const waitText = lowerStep({
      id: "wait-1",
      kind: "action" as const,
      action: { type: "waitFor", value: "text:Done" },
      url: "u",
      ts: 0,
    });
    expect(waitText.lines).toEqual([
      `await page.getByText("Done").first().waitFor({ state: "visible" });`,
    ]);

    const waitTarget = lowerStep({
      id: "wait-2",
      kind: "action" as const,
      action: { type: "waitFor", ref: "e1" },
      url: "u",
      selectorHint: 'role=alert[name="Saved"]',
      stability: "medium",
      ts: 0,
    });
    expect(waitTarget.lines).toEqual([
      `await page.getByRole("alert", { name: "Saved" }).waitFor({ state: "visible" });`,
    ]);
  });

  it("flags unhandled action types with a TODO + non-handled counter", () => {
    const r = lowerTraceToSpec("mystery", [
      {
        id: "mystery-1",
        kind: "action" as const,
        action: { type: "mysteryAction", value: "?" },
        url: "u",
        ts: 0,
      },
    ]);
    expect(r.stats.handled).toBe(0);
    expect(r.stats.unhandled).toBe(1);
    expect(r.source).toContain(`// TODO: unhandled action type "mysteryAction"`);
    expect(parseCheck(r.source).ok).toBe(true);
  });

  it("integrates with the Recorder via `inspect()` for mid-recording export", () => {
    const rec = new Recorder();
    rec.start("integration");
    rec.record({ type: "navigate", url: "https://a.example.com" }, "https://a.example.com");
    rec.record({ type: "click", ref: "e1" }, "https://a.example.com", {
      selectorHint: '[data-testid="go"]',
      stability: "high",
    });
    const snap = rec.inspect();
    expect(snap).not.toBeNull();
    const r = lowerTraceToSpec(snap!.name, snap!.steps);
    expect(r.stats.steps).toBe(2);
    expect(r.source).toContain(`await page.goto("https://a.example.com");`);
    expect(r.source).toContain(`await page.locator("[data-testid=\\"go\\"]").click();`);
    // The recording is still active after inspect() — caller didn't end it.
    expect(rec.active()).toBe(true);
  });

  it("returns null from inspect() when no recording is active", () => {
    expect(new Recorder().inspect()).toBeNull();
  });
});

describe("export_playwright_script — recorded reads", () => {
  const readStep = (
    id: string,
    read: RecordedReadStep["read"],
    rest: Partial<RecordedReadStep> = {},
  ) =>
    ({
      id,
      kind: "read",
      read,
      url: "https://m.example.com/t/1",
      ts: 0,
      ...rest,
    }) as RecordedReadStep;

  it("lowers `find` to a named locator and references it", () => {
    const r = lowerTraceToSpec("find-flow", [
      readStep(
        "find-1",
        { type: "find", query: "the reply button" },
        {
          selectorHint: 'role=button[name="Reply"]',
          stability: "medium",
        },
      ),
    ]);
    expect(r.stats).toEqual({ steps: 1, handled: 1, unhandled: 0, fragile: 0 });
    expect(r.source).toContain(`// find("the reply button")`);
    expect(r.source).toContain(`const button_reply = page.getByRole("button", { name: "Reply" });`);
    expect(r.source).toContain(`void [button_reply];`);
    expect(parseCheck(r.source).ok).toBe(true);
  });

  it("suffixes a second `find` that resolves to the same locator name", () => {
    const hint = { selectorHint: '[data-testid="row"]', stability: "high" as const };
    const r = lowerTraceToSpec("dup-flow", [
      readStep("find-1", { type: "find", query: "the row" }, hint),
      readStep("find-2", { type: "find", query: "the row again" }, hint),
    ]);
    expect(r.source).toContain(`const row = page.locator("[data-testid=\\"row\\"]");`);
    expect(r.source).toContain(`const row_2 = page.locator("[data-testid=\\"row\\"]");`);
    expect(parseCheck(r.source).ok).toBe(true);
  });

  it("counts a `find` that resolved no candidate as unhandled", () => {
    const r = lowerTraceToSpec("miss-flow", [readStep("find-1", { type: "find", query: "ghost" })]);
    expect(r.stats.unhandled).toBe(1);
    expect(r.source).toContain(`// TODO: find("ghost") resolved no candidate`);
  });

  it("lowers `extract` to a live per-field read and logs the result", () => {
    const r = lowerTraceToSpec("extract-flow", [
      readStep("extract-1", {
        type: "extract",
        schema: {
          type: "object",
          properties: {
            sender: { type: "string", "x-browx-source": { selector: "[data-testid=sender]" } },
            link: { type: "string", "x-browx-source": { selector: "a.rt", attr: "href" } },
            draft: { type: "string", "x-browx-source": { selector: "textarea", value: true } },
          },
        },
        scope: ".thread",
      }),
    ]);
    expect(r.stats).toEqual({ steps: 1, handled: 1, unhandled: 0, fragile: 0 });
    expect(r.source).toContain("const extract_1 = {");
    expect(r.source).toContain(
      `sender: (await page.locator(".thread").locator("[data-testid=sender]").first().innerText()).trim(),`,
    );
    expect(r.source).toContain(
      `link: await page.locator(".thread").locator("a.rt").first().getAttribute("href"),`,
    );
    expect(r.source).toContain(
      `draft: await page.locator(".thread").locator("textarea").first().inputValue(),`,
    );
    expect(r.source).toContain(`console.log(JSON.stringify({ extract_1 }, null, 2));`);
    expect(parseCheck(r.source).ok).toBe(true);
  });

  it("counts an `extract` field with no recorded selector as unhandled", () => {
    const r = lowerTraceToSpec("partial-extract", [
      readStep("extract-1", {
        type: "extract",
        schema: { type: "object", properties: { body: { type: "string" } } },
      }),
    ]);
    expect(r.stats.handled).toBe(0);
    expect(r.stats.unhandled).toBe(1);
    expect(r.source).toContain("body: null, // TODO: no selector recorded");
    expect(parseCheck(r.source).ok).toBe(true);
  });

  it("flags a ref-scoped `extract` — refs are session-local", () => {
    const r = lowerTraceToSpec("ref-extract", [
      readStep("extract-1", {
        type: "extract",
        schema: {
          type: "object",
          properties: { sender: { type: "string", "x-browx-source": { selector: ".s" } } },
        },
        scope: "e12",
      }),
    ]);
    expect(r.source).toContain(`// TODO: the recorded scope was ref "e12"`);
    expect(r.source).toContain(`sender: (await page.locator(".s").first().innerText()).trim(),`);
  });

  it("lowers `snapshot` to a comment and counts it unhandled", () => {
    const r = lowerTraceToSpec("snap-flow", [
      readStep("snapshot-1", { type: "snapshot", scope: "e4" }),
    ]);
    expect(r.stats).toEqual({ steps: 1, handled: 0, unhandled: 1, fragile: 0 });
    expect(r.source).toContain("// snapshot (scope: e4) — agent orientation read");
    expect(r.source).not.toContain("await page");
    expect(parseCheck(r.source).ok).toBe(true);
  });

  it("lowers `eval_js` and states the capability provenance in the header", () => {
    const r = lowerTraceToSpec("eval-flow", [
      readStep("eval_js-1", { type: "eval_js", expr: "document.title" }),
    ]);
    expect(r.stats.handled).toBe(1);
    expect(r.source).toContain(`const eval_js_1 = await page.evaluate("document.title");`);
    expect(r.source).toContain("off-by-default `eval` capability");
    expect(r.source).toContain(`console.log(JSON.stringify({ eval_js_1 }, null, 2));`);
    expect(parseCheck(r.source).ok).toBe(true);
  });

  it("omits the eval-capability header note when no eval_js was recorded", () => {
    const r = lowerTraceToSpec("no-eval", [readStep("snapshot-1", { type: "snapshot" })]);
    expect(r.source).not.toContain("off-by-default `eval` capability");
  });

  it("names the one-time browser install in every header", () => {
    expect(lowerTraceToSpec("any", []).source).toContain("npx playwright install chromium");
  });

  it("records reads through the Recorder and lowers them end to end", () => {
    const rec = new Recorder();
    rec.start("mail-thread");
    rec.record({ type: "navigate", url: "https://m.example.com/t/1" }, "https://m.example.com/t/1");
    rec.recordRead(
      {
        type: "extract",
        schema: {
          type: "object",
          properties: { sender: { type: "string", "x-browx-source": { selector: ".from" } } },
        },
      },
      "https://m.example.com/t/1",
    );
    const snap = rec.inspect();
    const r = lowerTraceToSpec(snap!.name, snap!.steps);
    expect(r.stats).toEqual({ steps: 2, handled: 2, unhandled: 0, fragile: 0 });
    expect(r.source).toContain(`await page.goto("https://m.example.com/t/1");`);
    expect(r.source).toContain(`sender: (await page.locator(".from").first().innerText()).trim(),`);
    expect(parseCheck(r.source).ok).toBe(true);
  });
});

describe("export_playwright_script — workspace path", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "browxai-export-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("writes to a workspace-rooted path and rejects escape", () => {
    // Happy path — `resolveWorkspacePath` returns a path inside the workspace
    // root that we can write to ourselves; mirrors how `dump_storage_state`
    // composes its writer + path validator.
    const target = resolveWorkspacePath(
      workspace,
      "scripts/login.spec.ts",
      "export_playwright_script",
    );
    expect(target.startsWith(workspace)).toBe(true);

    const r = lowerTraceToSpec("write-flow", [
      {
        id: "open-1",
        kind: "action" as const,
        action: { type: "navigate", url: "https://x.example.com" },
        url: "https://x.example.com",
        ts: 0,
      },
    ]);
    mkdirSync(join(workspace, "scripts"), { recursive: true });
    writeFileSync(target, r.source, "utf8");
    expect(existsSync(target)).toBe(true);
    const round = readFileSync(target, "utf8");
    expect(round).toContain(`await page.goto("https://x.example.com");`);

    // Escape — anything that resolves outside the workspace is rejected.
    expect(() =>
      resolveWorkspacePath(workspace, "../outside.spec.ts", "export_playwright_script"),
    ).toThrow(/must resolve inside \$BROWX_WORKSPACE/);
  });
});

describe("export_playwright_script — parse-check", () => {
  it("rejects unbalanced delimiters in the generated source", () => {
    const bad = `import { test, expect } from "@playwright/test";\n\ntest("x", async ({ page }) => {\n  await page.goto("https://a.example.com";\n});\n`;
    const r = parseCheck(bad);
    expect(r.ok).toBe(false);
  });

  it("accepts a real lowered spec", () => {
    const r = lowerTraceToSpec("ok", [
      {
        id: "open-1",
        kind: "action" as const,
        action: { type: "navigate", url: "https://a.example.com" },
        url: "https://a.example.com",
        ts: 0,
      },
    ]);
    expect(parseCheck(r.source).ok).toBe(true);
  });
});
