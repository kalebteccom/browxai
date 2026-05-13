import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveWorkspace } from "./workspace.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "browx-test-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("resolveWorkspace (no-trace contract)", () => {
  it("uses BROWX_WORKSPACE env (absolute) and creates it if missing", () => {
    const root = join(tmp, "ws");
    expect(existsSync(root)).toBe(false);
    const ws = resolveWorkspace({ BROWX_WORKSPACE: root });
    expect(ws.root).toBe(resolve(root));
    expect(existsSync(root)).toBe(true);
  });

  it("creates subdirs on demand without polluting cwd", () => {
    const cwdBefore = readdirSync(process.cwd());
    const root = join(tmp, "ws");
    const ws = resolveWorkspace({ BROWX_WORKSPACE: root });
    const profile = ws.sub("profile");
    const logs = ws.sub("logs");
    expect(existsSync(profile)).toBe(true);
    expect(existsSync(logs)).toBe(true);
    expect(profile).toBe(join(resolve(root), "profile"));
    // cwd untouched — the no-trace contract holds for the resolver.
    expect(readdirSync(process.cwd())).toEqual(cwdBefore);
  });

  it("falls back to ~/.browxai when BROWX_WORKSPACE is unset", () => {
    // We don't actually create here — assert path shape only.
    const ws = resolveWorkspace({ BROWX_WORKSPACE: "" });
    expect(ws.root).toMatch(/\.browxai$/);
  });
});
