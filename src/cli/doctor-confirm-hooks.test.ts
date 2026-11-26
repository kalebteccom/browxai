import { describe, it, expect } from "vitest";
import { confirmHookRows } from "./doctor-confirm-hooks.js";

describe("confirmHookRows", () => {
  it("reports the default hooks in one row with no warning", () => {
    const rows = confirmHookRows({});
    expect(rows).toEqual([
      {
        name: "confirm-hooks",
        ok: true,
        detail: "[navigate_off_allowlist, byob_action, native_device_app]",
      },
    ]);
  });

  it("adds a warning row for a default hook the list leaves out", () => {
    const rows = confirmHookRows({ BROWX_CONFIRM_REQUIRED: "navigate_off_allowlist" });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.detail).toBe("[navigate_off_allowlist]");
    expect(rows[1]).toMatchObject({ name: "confirm-hooks", ok: true, warn: true });
    expect(rows[1]!.detail).toContain('"byob_action" is not in the list');
    expect(rows[1]!.detail).toContain("attached sessions run without a hold");
  });

  it("warns for each reserved hook and each missing default", () => {
    const rows = confirmHookRows({ BROWX_CONFIRM_REQUIRED: "file_download,file_upload" });
    expect(rows.map((r) => r.warn === true)).toEqual([false, true, true, true, true]);
    expect(rows.every((r) => r.ok)).toBe(true);
  });

  it("fails on an unknown hook name, as before", () => {
    const rows = confirmHookRows({ BROWX_CONFIRM_REQUIRED: "fly_to_moon" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ok).toBe(false);
    expect(rows[0]!.detail).toContain("fly_to_moon");
    expect(rows[0]!.fix).toContain("fix BROWX_CONFIRM_REQUIRED");
  });
});
