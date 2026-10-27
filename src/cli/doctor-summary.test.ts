import { describe, expect, it } from "vitest";
import { docsUrl } from "../util/docs-links.js";
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
    expect(text).toContain("claude mcp add browxai -- npx -y browxai");
    expect(text).toContain("npx browxai init <dir>");
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
  it("orders areas failures, then warnings, then ticks, each group in display order", () => {
    const checks: Check[] = [
      ...OK.filter((c) => !["node", "origins", "capabilities"].includes(c.name)),
      { name: "newthing", ok: false, detail: "broken", fix: "mend" },
      { name: "origins", ok: false, detail: "blocked" },
      { name: "capabilities", ok: true, warn: true, detail: "missing: action", fix: "add it" },
      { name: "node", ok: false, detail: "v20.0.0" },
    ];
    const { text, allOk } = formatDoctor(checks, OPTS);
    expect(allOk).toBe(false);
    const heads = text
      .split("\n")
      .map((l) => /^ {2}(\S) (\S+)/.exec(l))
      .filter((m) => m !== null)
      .map((m) => `${m[1]} ${m[2]}`);
    expect(heads).toEqual([
      "✗ node",
      "✗ settings",
      "✗ newthing",
      "⚠ capabilities",
      "✓ install",
      "✓ workspace",
      "✓ browser",
      "✓ attach",
    ]);
    expect(text).toContain("3 areas need a fix. Fix them, then run `browxai doctor` again.");
    expect(text).not.toContain("next: undefined");
    expect(text).not.toMatch(/node +v20\.0\.0\n {4}next:/);
  });

  it("says one area needs a fix in the singular", () => {
    const checks = OK.map((c) => (c.name === "node" ? { ...c, ok: false, fix: "upgrade" } : c));
    const { text } = formatDoctor(checks, OPTS);
    expect(text).toContain("1 area needs a fix. Fix it, then run `browxai doctor` again.");
  });

  it("lists each failing row of one area under its own name", () => {
    const checks: Check[] = OK.map((c) => {
      if (c.name === "chrome") return { ...c, ok: false, detail: "no chrome", fix: "get chrome" };
      if (c.name === "chromium") return { ...c, ok: false, detail: "no chromium", fix: "get it" };
      return c;
    });
    const { text } = formatDoctor(checks, OPTS);
    expect(text).toMatch(
      /✗ browser +no chrome\n {4}next: get chrome\n {4}chromium: no chromium\n {4}next: get it\n/,
    );
  });

  it("shows only the failing rows of an area that has a failure and a warning", () => {
    const checks: Check[] = [
      ...OK.filter((c) => c.name !== "capabilities"),
      { name: "capabilities", ok: false, detail: "unknown capability", fix: "fix the list" },
      { name: "byob-attach", ok: true, warn: true, detail: "attach refused", fix: "add it" },
    ];
    const { text } = formatDoctor(checks, OPTS);
    expect(text).toMatch(/✗ capabilities +unknown capability\n {4}next: fix the list\n/);
    expect(text).not.toContain("attach refused");
  });

  it("groups the byob-attach warning under capabilities", () => {
    const checks: Check[] = [
      ...OK,
      { name: "byob-attach", ok: true, warn: true, detail: "attach refused", fix: "add it" },
    ];
    const { text, allOk } = formatDoctor(checks, OPTS);
    expect(allOk).toBe(true);
    expect(text).toMatch(/⚠ capabilities +attach refused\n {4}next: add it\n/);
    expect(text.match(/capabilities/g)).toHaveLength(1);
  });

  it("puts a multi-line detail on one line", () => {
    const checks = OK.map((c) =>
      c.name === "node" ? { ...c, ok: false, detail: "line one\n   line two\n" } : c,
    );
    expect(formatDoctor(checks, OPTS).text).toContain("line one line two\n");
  });

  it("verbose keeps the input order and prints fix lines only for failures and warnings", () => {
    const checks: Check[] = [
      { name: "a", ok: true, detail: "fine", fix: "hidden" },
      { name: "b", ok: true, warn: true, detail: "careful", fix: "do x" },
      { name: "c", ok: false, detail: "broken", fix: "do y" },
      { name: "d", ok: true, info: true, detail: "off", fix: "hidden too", enable: "turn on" },
    ];
    const { text, allOk } = formatDoctor(checks, { ...OPTS, verbose: true });
    expect(allOk).toBe(false);
    const row = (glyph: string, name: string, detail: string) =>
      `  ${glyph} ${name.padEnd(12)} ${detail}\n`;
    expect(text).toBe(
      "browxai doctor (v9.9.9) — environment & connectivity\n\n" +
        row("✓", "a", "fine") +
        row("⚠", "b", "careful") +
        "    fix: do x\n" +
        row("✗", "c", "broken") +
        "    fix: do y\n" +
        row("−", "d", "off") +
        "    enable with: turn on\n" +
        "\nfix the ✗ items above, then run `browxai doctor` again. Common errors: " +
        docsUrl.troubleshooting +
        "\n",
    );
  });

  it("verbose passes a warning without failing", () => {
    const checks: Check[] = [{ name: "b", ok: true, warn: true, detail: "careful", fix: "do x" }];
    const { text, allOk } = formatDoctor(checks, { ...OPTS, verbose: true });
    expect(allOk).toBe(true);
    expect(text).toContain("⚠ b");
    expect(text).toContain("all checks passed.");
  });
});
