import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolListRow } from "./doctor-tool-list.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browx-doctor-tl-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const save = (layers: object) => writeFileSync(join(dir, "config.json"), JSON.stringify(layers));

describe("toolListRow", () => {
  it("reports all (default) with no env and no saved value", () => {
    const row = toolListRow({}, dir);
    expect(row.ok).toBe(true);
    expect(row.detail).toMatch(/^all \(default\)/);
  });

  it("reports enabled from a saved layer with no env", () => {
    save({ user: { toolList: "enabled" } });
    const row = toolListRow({}, dir);
    expect(row.ok).toBe(true);
    expect(row.detail).toMatch(/^enabled:/);
  });

  it("lets a saved all override an env enabled, and says it is set", () => {
    save({ project: { toolList: "all" } });
    const row = toolListRow({ BROWX_TOOL_LIST: "enabled" }, dir);
    expect(row.detail).toMatch(/^all:/);
  });

  it("fails on a mistyped env value", () => {
    const row = toolListRow({ BROWX_TOOL_LIST: "enabeld" }, dir);
    expect(row.ok).toBe(false);
    expect(row.detail).toMatch(/BROWX_TOOL_LIST: unknown value "enabeld"/);
  });
});
