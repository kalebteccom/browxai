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
});
