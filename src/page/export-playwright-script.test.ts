import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  lowerTraceToSpec,
  lowerStep,
  locatorExprFromHint,
  parseCheck,
} from "./export-playwright-script.js";
import { Recorder } from "./recording.js";
import { resolveWorkspacePath } from "../session/storage.js";
import { writeFileSync, mkdirSync } from "node:fs";

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
        action: { type: "navigate", url: "https://app.example.com/login" },
        url: "https://app.example.com/login",
        ts: 0,
      },
      {
        id: "fill-1",
        action: { type: "fill", ref: "e1", value: "alice" },
        url: "https://app.example.com/login",
        selectorHint: '[data-testid="username"]',
        stability: "high" as const,
        ts: 0,
      },
      {
        id: "click-1",
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
      action: { type: "press", value: "Enter" },
      url: "u",
      ts: 0,
    });
    expect(pressNoTarget.lines).toEqual([`await page.keyboard.press("Enter");`]);
    expect(pressNoTarget.handled).toBe(true);

    const pressTargeted = lowerStep({
      id: "press-2",
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
      action: { type: "waitFor", value: "text:Done" },
      url: "u",
      ts: 0,
    });
    expect(waitText.lines).toEqual([
      `await page.getByText("Done").first().waitFor({ state: "visible" });`,
    ]);

    const waitTarget = lowerStep({
      id: "wait-2",
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
    rec.record(
      { type: "click", ref: "e1" },
      "https://a.example.com",
      { selectorHint: '[data-testid="go"]', stability: "high" },
    );
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
    const target = resolveWorkspacePath(workspace, "scripts/login.spec.ts", "export_playwright_script");
    expect(target.startsWith(workspace)).toBe(true);

    const r = lowerTraceToSpec("write-flow", [
      {
        id: "open-1",
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
        action: { type: "navigate", url: "https://a.example.com" },
        url: "https://a.example.com",
        ts: 0,
      },
    ]);
    expect(parseCheck(r.source).ok).toBe(true);
  });
});
