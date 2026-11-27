import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";

const bundled = vi.hoisted(() => ({ path: "" }));
vi.mock(import("playwright-core"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    chromium: Object.assign(Object.create(actual.chromium) as typeof actual.chromium, {
      executablePath: () => bundled.path,
    }),
  };
});

import { chromeCheck, chromiumCheck, configuredChannel, safariCheck } from "./doctor-engines.js";

describe("safariCheck", () => {
  it("is ready without an enable hint when safaridriver is available", () => {
    const row = safariCheck(() => undefined);
    expect(row).toMatchObject({ name: "safari", ok: true, info: true });
    expect(row.enable).toBeUndefined();
  });

  it("stays informational and says how to enable it when unavailable", () => {
    const row = safariCheck(() => {
      throw new Error('safari-unavailable: host platform is "linux", not macOS. More text.');
    });
    expect(row).toMatchObject({ name: "safari", ok: true, info: true });
    expect(row.detail).toContain('host platform is "linux"');
    expect(row.enable).toContain("safaridriver --enable");
  });
});

describe("chromeCheck", () => {
  const found = () => "/Applications/Google Chrome";
  const missing = () => undefined;

  it("passes with no channel when Chrome is installed, and says a default session launches it", () => {
    const row = chromeCheck(found, undefined);
    expect(row).toMatchObject({ name: "chrome", ok: true });
    expect(row.info).toBeUndefined();
    expect(row.detail).toContain("/Applications/Google Chrome");
    expect(row.detail).toMatch(/default session launches it/);
    expect(row.enable).toBeUndefined();
  });

  it("fails with no channel and no Chrome, naming the refusal and the opt-in", () => {
    const row = chromeCheck(missing, undefined);
    expect(row).toMatchObject({ name: "chrome", ok: false });
    expect(row.detail).toMatch(/refused with chrome-not-installed/);
    expect(row.fix).toMatch(/install Google Chrome/);
    expect(row.fix).toContain("BROWX_CHANNEL=chromium");
  });

  it("stays informational on the chromium opt-in when Chrome is missing", () => {
    const row = chromeCheck(missing, "chromium");
    expect(row).toMatchObject({ name: "chrome", ok: true, info: true });
    expect(row.detail).toMatch(/sessions launch the bundled Chromium/);
    expect(row.enable).toMatch(/install Google Chrome/);
  });

  it("names another configured channel without failing", () => {
    const row = chromeCheck(missing, "msedge");
    expect(row).toMatchObject({ name: "chrome", ok: true, info: true });
    expect(row.detail).toContain('Channel "msedge"');
  });
});

describe("configuredChannel", () => {
  it("reads BROWX_CHANNEL, and is undefined when it is blank", () => {
    const ws = mkdtempSync(join(tmpdir(), "browx-doctor-channel-"));
    try {
      expect(configuredChannel({ BROWX_CHANNEL: " chromium " }, ws)).toBe("chromium");
      expect(configuredChannel({ BROWX_CHANNEL: "" }, ws)).toBeUndefined();
      expect(configuredChannel({}, ws)).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("chromiumCheck", () => {
  it("is informational when the bundled build is missing and not opted in", async () => {
    bundled.path = "/nowhere/chrome";
    const row = await chromiumCheck(false);
    expect(row).toMatchObject({ name: "chromium", ok: true, info: true });
    expect(row.detail).toMatch(/Only channel "chromium" uses it/);
    expect(row.enable).toContain("BROWX_CHANNEL=chromium");
  });

  it("fails when channel chromium is set and the bundled build is missing", async () => {
    bundled.path = "/nowhere/chrome";
    const row = await chromiumCheck(true);
    expect(row).toMatchObject({ name: "chromium", ok: false });
    expect(row.fix).toMatch(/install chromium/);
  });

  it("passes with the path when the bundled build is present", async () => {
    bundled.path = fileURLToPath(import.meta.url);
    expect(await chromiumCheck(true)).toMatchObject({ ok: true, detail: bundled.path });
    expect(await chromiumCheck(false)).toMatchObject({ ok: true, info: true });
  });
});
