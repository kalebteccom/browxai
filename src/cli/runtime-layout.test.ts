import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempRuntime, type TempRuntime } from "./__fixtures__/runtime-tree.js";
import {
  compareVersions,
  inspectRuntime,
  isVersion,
  migrationSteps,
  resolveRuntimeDir,
  runtimePaths,
} from "./runtime-layout.js";

const posix = process.platform !== "win32";

let rt: TempRuntime | undefined;
afterEach(() => {
  rt?.cleanup();
  rt = undefined;
});

describe("resolveRuntimeDir", () => {
  const base = { home: "/home/u", platform: "linux" as const, uid: 1000 };

  it("defaults to ~/.browxai-runtime", () => {
    expect(resolveRuntimeDir({ ...base, env: {} })).toEqual({ dir: "/home/u/.browxai-runtime" });
  });

  it("takes BROWX_RUNTIME_DIR, with ~ expanded", () => {
    expect(resolveRuntimeDir({ ...base, env: { BROWX_RUNTIME_DIR: "~/rt" } })).toEqual({
      dir: "/home/u/rt",
    });
  });

  it("refuses a relative BROWX_RUNTIME_DIR", () => {
    const r = resolveRuntimeDir({ ...base, env: { BROWX_RUNTIME_DIR: "rt" } });
    expect(r).toEqual({ error: 'BROWX_RUNTIME_DIR must be an absolute path, got "rt"' });
  });

  it("lets --dir win over the variable", () => {
    const r = resolveRuntimeDir({ ...base, env: { BROWX_RUNTIME_DIR: "/a" } }, "/b");
    expect(r).toEqual({ dir: "/b" });
  });
});

describe("versions", () => {
  it.each(["0.21.0", "1.0.0", "0.23.0-next.1", "10.20.30-rc.1.alpha"])("%s is a version", (v) => {
    expect(isVersion(v)).toBe(true);
  });

  it.each(["", "1.0", "v1.0.0", "01.0.0", "1.0.0+build", "../1.0.0", "1.0.0/x", "1.0.0-"])(
    "%j is not a version",
    (v) => expect(isVersion(v)).toBe(false),
  );

  it("orders by semver precedence, prereleases before their release", () => {
    const sorted = [
      "0.10.0",
      "0.9.1",
      "1.0.0",
      "1.0.0-next.2",
      "1.0.0-next.10",
      "1.0.0-alpha",
      "0.21.0",
    ].sort(compareVersions);
    expect(sorted).toEqual([
      "0.9.1",
      "0.10.0",
      "0.21.0",
      "1.0.0-alpha",
      "1.0.0-next.2",
      "1.0.0-next.10",
      "1.0.0",
    ]);
  });
});

describe("inspectRuntime", () => {
  it("accepts a managed runtime", () => {
    rt = tempRuntime();
    expect(inspectRuntime(rt.paths.root, rt.ctx, true)).toEqual({
      ok: true,
      found: { kind: "managed", schemaVersion: 1, known: true },
    });
  });

  it("reports a missing and an empty directory", () => {
    rt = tempRuntime({ create: false });
    expect(inspectRuntime(rt.paths.root, rt.ctx, true)).toEqual({
      ok: true,
      found: { kind: "absent" },
    });
    mkdirSync(rt.paths.root, { mode: 0o700 });
    expect(inspectRuntime(rt.paths.root, rt.ctx, true)).toEqual({
      ok: true,
      found: { kind: "empty" },
    });
  });

  it("refuses to run as root", () => {
    rt = tempRuntime();
    const r = inspectRuntime(rt.paths.root, { ...rt.ctx, uid: 0 }, false);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("does not run as root") });
  });

  it("refuses a hand-made directory with the migration steps, and changes nothing", () => {
    rt = tempRuntime({ create: false });
    mkdirSync(join(rt.paths.root, "node_modules"), { recursive: true, mode: 0o700 });
    chmodSync(rt.paths.root, 0o700);
    const r = inspectRuntime(rt.paths.root, rt.ctx, false);
    expect(r).toEqual({ ok: false, reason: migrationSteps(rt.paths.root) });
    expect(migrationSteps(rt.paths.root)).toContain(
      "Move the directory aside, then run: browxai runtime install",
    );
  });

  it.runIf(posix)("refuses a runtime directory that is a symlink", () => {
    rt = tempRuntime({ dirName: "real" });
    const link = join(rt.home, "link");
    symlinkSync(rt.paths.root, link);
    const r = inspectRuntime(link, rt.ctx, false);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("is a symlink") });
  });

  it.runIf(posix)("refuses a versions/ that is a symlink", () => {
    rt = tempRuntime();
    rmSync(rt.paths.versions, { recursive: true });
    const elsewhere = mkdtempSync(join(tmpdir(), "bx-rt-other-"));
    try {
      symlinkSync(elsewhere, rt.paths.versions);
      const r = inspectRuntime(rt.paths.root, rt.ctx, true);
      expect(r).toEqual({
        ok: false,
        reason: expect.stringMatching(/^versions\/ .* is a symlink/),
      });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it.runIf(posix).each([0o720, 0o702, 0o777])(
    "refuses a group- or world-writable runtime directory (%o)",
    (mode) => {
      rt = tempRuntime();
      chmodSync(rt.paths.root, mode);
      const r = inspectRuntime(rt.paths.root, rt.ctx, false);
      expect(r).toEqual({
        ok: false,
        reason: expect.stringContaining("writable by group or others"),
      });
    },
  );

  it.runIf(posix).each([0o770, 0o707])(
    "refuses a group- or world-writable versions/ (%o)",
    (mode) => {
      rt = tempRuntime();
      chmodSync(rt.paths.versions, mode);
      const r = inspectRuntime(rt.paths.root, rt.ctx, true);
      expect(r).toEqual({
        ok: false,
        reason: expect.stringMatching(/^versions\/ .* writable by group or others/),
      });
    },
  );

  it("refuses a directory owned by another user", () => {
    rt = tempRuntime();
    const other = (rt.ctx.uid ?? 0) + 1;
    const r = inspectRuntime(rt.paths.root, { ...rt.ctx, uid: other }, false);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("is owned by another user") });
  });

  it("refuses an unknown schemaVersion for a write, and reports it for a read", () => {
    rt = tempRuntime();
    writeFileSync(rt.paths.layout, JSON.stringify({ schemaVersion: 2 }));
    expect(inspectRuntime(rt.paths.root, rt.ctx, true)).toEqual({
      ok: false,
      reason: expect.stringContaining("has schemaVersion 2, and this browxai supports 1"),
    });
    expect(inspectRuntime(rt.paths.root, rt.ctx, false)).toEqual({
      ok: true,
      found: { kind: "managed", schemaVersion: 2, known: false },
    });
  });

  it("refuses a layout.json that isn't valid", () => {
    rt = tempRuntime();
    writeFileSync(rt.paths.layout, "{");
    const r = inspectRuntime(rt.paths.root, rt.ctx, false);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("layout.json is not valid") });
  });

  it("refuses a runtime inside the workspace, and a workspace inside the runtime", () => {
    rt = tempRuntime();
    const inside = { ...rt.ctx, env: { BROWX_WORKSPACE: rt.home } };
    expect(inspectRuntime(rt.paths.root, inside, false)).toEqual({
      ok: false,
      reason: expect.stringContaining("overlaps the workspace"),
    });
    const around = { ...rt.ctx, env: { BROWX_WORKSPACE: join(rt.paths.root, "ws") } };
    expect(inspectRuntime(rt.paths.root, around, false)).toEqual({
      ok: false,
      reason: expect.stringContaining("overlaps the workspace"),
    });
  });

  it("checks the default workspace when BROWX_WORKSPACE is unset", () => {
    rt = tempRuntime();
    const paths = runtimePaths(join(rt.home, ".browxai", "runtime"));
    const r = inspectRuntime(paths.root, { ...rt.ctx, env: {} }, false);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("overlaps the workspace") });
  });

  it("refuses the macOS app's own folder", () => {
    rt = tempRuntime();
    const dir = join(rt.home, "Library", "Application Support", "Browxai", "runtime");
    const r = inspectRuntime(dir, { ...rt.ctx, platform: "darwin" }, false);
    expect(r).toEqual({
      ok: false,
      reason: expect.stringContaining("inside the Browxai app's folder"),
    });
  });
});
