import { describe, expect, it } from "vitest";
import "../tools/tool-metadata.js";
import { capabilitiesRow } from "./doctor-capabilities.js";

describe("capabilitiesRow", () => {
  it("is a plain ok row for the defaults", () => {
    const { row } = capabilitiesRow({});
    expect(row.ok).toBe(true);
    expect(row.warn).toBeUndefined();
    expect(row.detail).toContain("(default)");
  });

  it("fails with the bad name and the valid names, without throwing", () => {
    const { row, enabled } = capabilitiesRow({ BROWX_CAPABILITIES: "read,navigation,evall" });
    expect(row.ok).toBe(false);
    expect(row.detail).toContain('"evall"');
    expect(row.detail).toContain("Valid: read, navigation");
    expect(row.detail).not.toContain("\n");
    expect(enabled.has("read")).toBe(true);
  });

  it("warns when the list drops defaults and says how to add them back", () => {
    const { row } = capabilitiesRow({ BROWX_CAPABILITIES: "eval" });
    expect(row.ok).toBe(true);
    expect(row.warn).toBe(true);
    expect(row.detail).toContain("missing: read, navigation, action, human");
    expect(row.fix).toContain("BROWX_CAPABILITIES=read,navigation,action,human,eval");
  });

  it("does not warn about defaults when the list keeps them", () => {
    const { row } = capabilitiesRow({ BROWX_CAPABILITIES: "read,navigation,action,human,file-io" });
    expect(row.warn).toBeUndefined();
    expect(row.detail).not.toContain("missing");
  });
  it("treats a blank list as the defaults", () => {
    const { row } = capabilitiesRow({ BROWX_CAPABILITIES: "  " });
    expect(row.ok).toBe(true);
    expect(row.warn).toBeUndefined();
    expect(row.detail).toContain("(default)");
  });

  it("has no fix for an explicit list that is exactly the defaults", () => {
    const { row } = capabilitiesRow({ BROWX_CAPABILITIES: "read,navigation,action,human" });
    expect(row.ok).toBe(true);
    expect(row.warn).toBeUndefined();
    expect(row.fix).toBeUndefined();
    expect(row.detail).not.toContain("(default)");
    expect(row.detail).not.toContain("dangerous");
  });

  it("notes eval as dangerous without warning, and points at the threat model", () => {
    const { row, enabled } = capabilitiesRow({
      BROWX_CAPABILITIES: "read,navigation,action,human,eval",
    });
    expect(row.ok).toBe(true);
    expect(row.warn).toBeUndefined();
    expect(row.detail).toContain("dangerous: eval");
    expect(row.fix).toMatch(/^eval on: page text remains untrusted/);
    expect(enabled.has("eval")).toBe(true);
  });

  it("gives the missing-defaults fix first and the dangerous note after it", () => {
    const { row } = capabilitiesRow({ BROWX_CAPABILITIES: "eval,byob-attach" });
    expect(row.warn).toBe(true);
    expect(row.detail).toContain("missing: read, navigation, action, human");
    expect(row.detail).toContain("dangerous: eval, byob-attach");
    const fix = row.fix ?? "";
    const add = fix.indexOf("BROWX_CAPABILITIES=read,navigation,action,human,eval,byob-attach");
    const note = fix.indexOf("; eval,byob-attach on:");
    expect(add).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(add);
  });

  it("uses the plural for several unknown names", () => {
    const { row } = capabilitiesRow({ BROWX_CAPABILITIES: "read,foo,bar" });
    expect(row.ok).toBe(false);
    expect(row.detail).toContain('unknown capabilities "foo", "bar"');
  });
});
