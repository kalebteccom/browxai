import { describe, it, expect } from "vitest";
import { chromeCheck, safariCheck } from "./doctor-engines.js";

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
  it("carries an enable hint only when Chrome is missing", () => {
    expect(chromeCheck(() => "/Applications/Google Chrome").enable).toBeUndefined();
    expect(chromeCheck(() => undefined).enable).toMatch(/install Google Chrome/);
  });
});
