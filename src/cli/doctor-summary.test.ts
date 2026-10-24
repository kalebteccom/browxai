import { describe, expect, it } from "vitest";
import type { Check } from "./doctor.js";
import { formatDoctor, summarize } from "./doctor-summary.js";

const OK: Check[] = [
  { name: "node", ok: true, detail: "v22.1.0" },
  { name: "build", ok: true, detail: "dist/cli.js exists (0d old)" },
  { name: "workspace", ok: true, detail: "/w (writable)" },
  { name: "test-attrs", ok: true, detail: "data-testid (default)" },
  { name: "cdp-attach", ok: true, detail: "unset" },
  { name: "capabilities", ok: true, detail: "enabled=[read] (default)" },
  { name: "confirm-hooks", ok: true, detail: "(none)" },
  { name: "origins", ok: true, detail: "open" },
  { name: "chrome", ok: true, detail: "/Applications/Chrome" },
  { name: "chromium", ok: true, detail: "/pw/chromium" },
  { name: "firefox", ok: true, info: true, detail: "not installed", enable: "install it" },
  { name: "webkit", ok: true, info: true, detail: "not installed", enable: "install it" },
  { name: "android", ok: true, info: true, detail: "no adb" },
  { name: "safari", ok: true, info: true, detail: "found" },
  { name: "electron", ok: true, info: true, detail: "unset" },
  { name: "engine", ok: true, info: true, detail: "chromium (default)" },
  { name: "plugins", ok: true, info: true, detail: "none declared" },
];

const OPTS = { verbose: false, version: "9.9.9" };

describe("doctor summary", () => {
  it("prints one tick line per area and hides opt-in rows", () => {
    const { text, allOk } = formatDoctor(OK, OPTS);
    expect(allOk).toBe(true);
    const lines = text.split("\n").filter((l) => l.startsWith("  "));
    expect(lines).toEqual([
      "  ✓ node",
      "  ✓ install",
      "  ✓ workspace",
      "  ✓ browser",
      "  ✓ capabilities",
      "  ✓ attach",
      "  ✓ settings",
    ]);
    expect(text).not.toContain("firefox");
    expect(text).toContain("claude mcp add browxai -- browxai");
    expect(text).toContain("browxai doctor --verbose");
  });

  it("puts failures first, with the row detail and the next step", () => {
    const checks: Check[] = [
      ...OK.filter((c) => c.name !== "workspace" && c.name !== "node"),
      {
        name: "node",
        ok: false,
        detail: "v20.0.0, browxai needs Node 22 or later",
        fix: "install Node 22",
      },
      {
        name: "workspace",
        ok: false,
        detail: "/w couldn't create subdir",
        fix: "check permissions",
      },
    ];
    const { text, allOk } = formatDoctor(checks, OPTS);
    expect(allOk).toBe(false);
    const body = text.split("\n").filter((l) => l.startsWith("  ") || l.startsWith("    "));
    expect(body[0]).toMatch(/^ {2}✗ node +v20\.0\.0/);
    expect(body[1]).toBe("    next: install Node 22");
    expect(body[2]).toMatch(/^ {2}✗ workspace +\/w couldn't/);
    expect(body[4]).toMatch(/^ {2}✓ /);
    expect(text).toContain("2 areas need a fix");
  });

  it("shows a warning after failures and before ticks, and does not fail", () => {
    const checks: Check[] = OK.map((c) =>
      c.name === "capabilities"
        ? { ...c, warn: true, detail: "missing: action", fix: "add action back" }
        : c,
    );
    const { text, allOk } = formatDoctor(checks, OPTS);
    expect(allOk).toBe(true);
    expect(text).toMatch(/⚠ capabilities +missing: action\n {4}next: add action back/);
    expect(text.indexOf("⚠")).toBeLessThan(text.indexOf("✓ node"));
    expect(text).toContain("Nothing failed");
  });

  it("shows an opt-in row only when it fails", () => {
    const checks: Check[] = [
      ...OK.filter((c) => c.name !== "engine"),
      { name: "engine", ok: false, detail: 'unknown engine "x"', fix: "pick one" },
    ];
    expect(summarize(checks).find((a) => a.label === "engine")?.state).toBe("fail");
  });

  it("groups the chrome and chromium rows into one browser area", () => {
    const checks = OK.map((c) =>
      c.name === "chromium" ? { ...c, ok: false, detail: "missing", fix: "install" } : c,
    );
    const browser = summarize(checks).filter((a) => a.label === "browser");
    expect(browser).toHaveLength(1);
    expect(browser[0]!.state).toBe("fail");
  });

  it("gives a row it does not know its own area", () => {
    const checks: Check[] = [...OK, { name: "newthing", ok: false, detail: "broken", fix: "mend" }];
    expect(summarize(checks).map((a) => a.label)).toContain("newthing");
  });

  it("verbose prints every row, as before", () => {
    const { text } = formatDoctor(OK, { ...OPTS, verbose: true });
    expect(text).toContain("browxai doctor (v9.9.9) — environment & connectivity");
    expect(text).toContain("−");
    expect(text).toContain("enable with: install it");
    expect(text).toContain("all checks passed.");
    expect(text.match(/^ {2}\S /gm)).toHaveLength(OK.length);
  });

  it("verbose keeps the failure wording", () => {
    const checks: Check[] = [{ name: "node", ok: false, detail: "old", fix: "upgrade" }];
    const { text, allOk } = formatDoctor(checks, { ...OPTS, verbose: true });
    expect(allOk).toBe(false);
    expect(text).toContain("fix: upgrade");
    expect(text).toContain("fix the ✗ items above");
  });
});
