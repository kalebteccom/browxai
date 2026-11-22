import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolProfileRow } from "./doctor-tool-profile.js";
import { toolListRow } from "./doctor-tool-list.js";
import { CORE_TOOLS } from "../util/tool-profile.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browx-doctor-tp-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const save = (layers: object) => writeFileSync(join(dir, "config.json"), JSON.stringify(layers));

describe("toolProfileRow", () => {
  it("reports full (default) with no env and no saved value", () => {
    const row = toolProfileRow({}, dir);
    expect(row.name).toBe("tool-profile");
    expect(row.ok).toBe(true);
    expect(row.detail).toMatch(/^full \(default\)/);
  });

  it("reports core from the env, with the size of the core set", () => {
    const row = toolProfileRow({ BROWX_TOOL_PROFILE: "core" }, dir);
    expect(row.ok).toBe(true);
    expect(row.detail).toMatch(/^core:/);
    expect(row.detail).toContain(`${CORE_TOOLS.length} core tools`);
  });

  it("reports core from a saved layer with no env", () => {
    save({ user: { toolProfile: "core" } });
    expect(toolProfileRow({}, dir).detail).toMatch(/^core:/);
  });

  it("lets a saved full override an env core, and says it is set", () => {
    save({ project: { toolProfile: "full" } });
    const row = toolProfileRow({ BROWX_TOOL_PROFILE: "core" }, dir);
    expect(row.detail).toMatch(/^full:/);
  });

  it("fails on a mistyped env value and names the fix", () => {
    const row = toolProfileRow({ BROWX_TOOL_PROFILE: "lean" }, dir);
    expect(row.ok).toBe(false);
    expect(row.detail).toMatch(/BROWX_TOOL_PROFILE: unknown value "lean"/);
    expect(row.fix).toContain("full or core");
  });

  it("leaves a mistyped BROWX_TOOL_LIST to the tool-list row", () => {
    const env = { BROWX_TOOL_LIST: "enabeld" };
    expect(toolProfileRow(env, dir).ok).toBe(true);
    expect(toolListRow(env, dir).ok).toBe(false);
  });

  it("leaves a mistyped BROWX_TOOL_PROFILE to the tool-profile row", () => {
    const env = { BROWX_TOOL_PROFILE: "lean" };
    expect(toolListRow(env, dir).ok).toBe(true);
    expect(toolProfileRow(env, dir).ok).toBe(false);
  });
});
