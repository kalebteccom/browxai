import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromiumSandboxRow } from "./doctor-chromium-sandbox.js";
import { toolListRow } from "./doctor-tool-list.js";
import { toolProfileRow } from "./doctor-tool-profile.js";
import type { SandboxFacts } from "../session/chromium-sandbox-launch.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browx-doctor-cs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const save = (layers: object) => writeFileSync(join(dir, "config.json"), JSON.stringify(layers));

const normalUser: SandboxFacts = {
  platform: "linux",
  uid: 1000,
  maxUserNamespaces: 63000,
  unprivilegedUsernsClone: 1,
  apparmorRestrictUserns: 0,
};
const root: SandboxFacts = { ...normalUser, uid: 0 };

describe("chromiumSandboxRow", () => {
  it("reports auto (default) with the sandbox on for a normal user", () => {
    const row = chromiumSandboxRow({}, dir, () => normalUser);
    expect(row.name).toBe("chromium-sandbox");
    expect(row.ok).toBe(true);
    expect(row.warn).toBeUndefined();
    expect(row.detail).toMatch(/^auto \(default\):/);
    expect(row.detail).toContain("sandbox is on");
  });

  it("warns, says why and names the fix when auto finds the host unable", () => {
    const row = chromiumSandboxRow({}, dir, () => root);
    expect(row.ok).toBe(true);
    expect(row.warn).toBe(true);
    expect(row.detail).toContain("sandbox is off on this host");
    expect(row.detail).toContain("runs as root");
    expect(row.fix).toContain("BROWX_CHROMIUM_SANDBOX=on");
    expect(row.fix).toContain("BROWX_CHROMIUM_SANDBOX=off");
  });

  it("reports off from the env, with no warning on a host that cannot run it", () => {
    const row = chromiumSandboxRow({ BROWX_CHROMIUM_SANDBOX: "off" }, dir, () => root);
    expect(row.ok).toBe(true);
    expect(row.warn).toBeUndefined();
    expect(row.detail).toMatch(/^off: browsers browxai launches run without/);
  });

  it("reports on, and warns when the host looks unable to run it", () => {
    const able = chromiumSandboxRow({ BROWX_CHROMIUM_SANDBOX: "on" }, dir, () => normalUser);
    expect(able.detail).toMatch(/^on:/);
    expect(able.warn).toBeUndefined();
    const unable = chromiumSandboxRow({ BROWX_CHROMIUM_SANDBOX: "on" }, dir, () => root);
    expect(unable.warn).toBe(true);
    expect(unable.fix).toContain("BROWX_CHROMIUM_SANDBOX=off");
  });

  it("reads a saved layer, which can raise the level above an env off", () => {
    save({ user: { chromiumSandbox: "on" } });
    const row = chromiumSandboxRow({ BROWX_CHROMIUM_SANDBOX: "off" }, dir, () => normalUser);
    expect(row.detail).toMatch(/^on:/);
  });

  it("reports the level the ceiling holds when a saved layer asks for off", () => {
    save({ user: { chromiumSandbox: "off" } });
    const row = chromiumSandboxRow({}, dir, () => normalUser);
    expect(row.detail).toMatch(/^auto \(default\):/);
  });

  it("tells the operator to remove a saved on, not to set the env var", () => {
    save({ project: { chromiumSandbox: "on" } });
    const row = chromiumSandboxRow({ BROWX_CHROMIUM_SANDBOX: "off" }, dir, () => root);
    expect(row.warn).toBe(true);
    expect(row.fix).toContain("Remove chromiumSandbox from the project layer of config.json");
    expect(row.fix).not.toContain("Set BROWX_CHROMIUM_SANDBOX=off");
  });

  it("keeps the env hint when the on came from the env", () => {
    const row = chromiumSandboxRow({ BROWX_CHROMIUM_SANDBOX: "on" }, dir, () => root);
    expect(row.fix).toContain("Set BROWX_CHROMIUM_SANDBOX=off");
    expect(row.fix).not.toContain("config.json");
  });

  it("says a launch of the installed Chrome tries the sandbox where AppArmor blocks the bundled build", () => {
    const row = chromiumSandboxRow({}, dir, () => ({ ...normalUser, apparmorRestrictUserns: 1 }));
    expect(row.warn).toBe(true);
    expect(row.detail).toContain("a launch of the installed Google Chrome tries");
    expect(row.detail).not.toContain("the installed Chrome tries");
    expect(row.detail).toContain("AppArmor");
    expect(row.detail).toContain(
      "the bundled browser (the bundled Chromium and the headless shell) skips it",
    );
  });

  it("fails on a mistyped env value and names the fix", () => {
    const row = chromiumSandboxRow({ BROWX_CHROMIUM_SANDBOX: "yes" }, dir, () => normalUser);
    expect(row.ok).toBe(false);
    expect(row.detail).toMatch(/BROWX_CHROMIUM_SANDBOX: unknown value "yes"/);
    expect(row.fix).toContain("auto, on or off");
  });

  it("leaves a mistyped BROWX_TOOL_LIST and BROWX_TOOL_PROFILE to their own rows", () => {
    const env = { BROWX_TOOL_LIST: "enabeld", BROWX_TOOL_PROFILE: "lean" };
    expect(chromiumSandboxRow(env, dir, () => normalUser).ok).toBe(true);
  });

  it("is not what fails the tool-list and tool-profile rows", () => {
    const env = { BROWX_CHROMIUM_SANDBOX: "yes" };
    expect(toolListRow(env, dir).ok).toBe(true);
    expect(toolProfileRow(env, dir).ok).toBe(true);
    expect(chromiumSandboxRow(env, dir, () => normalUser).ok).toBe(false);
  });
});
