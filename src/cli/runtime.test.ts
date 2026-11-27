import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addVersion,
  fakeAgent,
  tempRuntime,
  type TempRuntime,
} from "./__fixtures__/runtime-tree.js";
import { cliOf, versionDir } from "./runtime-layout.js";
import { readCurrent, readState, switchCurrent, writeState } from "./runtime-store.js";
import { RUNTIME_USAGE, runRuntime, type RuntimeDeps } from "./runtime.js";
import { PACKAGE_VERSION } from "../util/version.js";

let rt: TempRuntime | undefined;
afterEach(() => {
  rt?.cleanup();
  rt = undefined;
});

async function run(args: string[], deps: RuntimeDeps = {}) {
  let out = "";
  let err = "";
  const code = await runRuntime(args, {
    ctx: rt!.ctx,
    appBundle: () => undefined,
    list: async () => [],
    selfCli: "/elsewhere/dist/cli.js",
    system: { platform: "linux", home: rt!.home, env: {}, exists: () => false },
    agent: fakeAgent(),
    out: (t) => (out += t),
    err: (t) => (err += t),
    ...deps,
  });
  return { code, out, err };
}

function installed(): TempRuntime {
  rt = tempRuntime();
  addVersion(rt.paths, "0.21.0");
  addVersion(rt.paths, "0.22.0");
  writeFileSync(rt.paths.nodePath, process.execPath + "\n");
  switchCurrent(rt.paths, "0.22.0");
  writeState(rt.paths, { previous: "0.21.0" });
  return rt;
}

describe("browxai runtime: usage and refusals", () => {
  it.each([[[]], [["nope"]], [["status", "--bogus"]], [["rollback", "--to"]], [["gc", "x"]]])(
    "prints the usage and exits 2 for %j",
    async (args) => {
      rt = tempRuntime();
      const r = await run(args);
      expect(r).toEqual({ code: 2, out: "", err: RUNTIME_USAGE });
    },
  );

  it.each(["status", "rollback", "gc"])("exits 2 inside the signed app (%s)", async (verb) => {
    rt = installed();
    const r = await run([verb], { appBundle: () => "/Applications/Browxai.app" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("brew upgrade --cask browxai");
    expect(readCurrent(rt.paths)).toBe("0.22.0");
  });

  it("refuses a group-writable runtime and changes nothing", async () => {
    rt = installed();
    const { chmodSync } = await import("node:fs");
    chmodSync(rt.paths.root, 0o770);
    const r = await run(["rollback"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("writable by group or others");
    expect(readCurrent(rt.paths)).toBe("0.22.0");
  });

  it("refuses a hand-made directory with the migration steps", async () => {
    rt = tempRuntime({ create: false });
    mkdirSync(join(rt.paths.root, "node_modules"), { recursive: true });
    const r = await run(["gc"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("has no layout.json");
  });

  it("refuses rollback and gc where nothing is installed", async () => {
    rt = tempRuntime({ create: false });
    for (const verb of ["rollback", "gc"]) {
      const r = await run([verb]);
      expect(r.code, verb).toBe(2);
      expect(r.err).toContain("Run: browxai runtime install");
    }
  });
});

describe("browxai runtime status", () => {
  it("says where nothing is installed, and exits 0", async () => {
    rt = tempRuntime({ create: false });
    const r = await run(["status"]);
    expect(r).toEqual({
      code: 0,
      out: `No browxai runtime at ${rt.paths.root}. Run: browxai runtime install\n`,
      err: "",
    });
  });

  it("prints the versions and the pids that use them", async () => {
    rt = installed();
    const command = `node ${rt.paths.root}/versions/0.21.0/node_modules/browxai/dist/cli.js`;
    const r = await run(["status"], { list: async () => [{ pid: 4321, command }] });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`browxai runtime at ${rt.paths.root}`);
    expect(r.out).toContain("current:      0.22.0");
    expect(r.out).toContain("previous:     0.21.0");
    expect(r.out).toMatch(/0\.22\.0 +current\n/);
    expect(r.out).toMatch(/0\.21\.0 +previous {2}in use by pid 4321/);
    expect(r.out).toContain(`node:         ${process.execPath}`);
    expect(r.out).toContain("channel:      latest (default)");
  });

  it("prints the same facts as JSON", async () => {
    rt = installed();
    const r = await run(["status", "--json"], { selfCli: cliOf(versionDir(rt.paths, "0.21.0")) });
    const s = JSON.parse(r.out) as Record<string, unknown>;
    expect(s).toMatchObject({
      dir: rt.paths.root,
      layout: "managed",
      schemaVersion: 1,
      current: "0.22.0",
      previous: "0.21.0",
      process: { version: PACKAGE_VERSION, fromRuntime: true },
      channel: { value: "latest", source: "default" },
      autoUpdate: { on: true, source: "default" },
      node: { path: process.execPath, exists: true },
      pidsKnown: true,
    });
    expect(s.versions).toEqual([
      { version: "0.22.0", current: true, previous: false, pids: [] },
      { version: "0.21.0", current: false, previous: true, pids: [] },
    ]);
  });

  it("reports a runtime written by a newer browxai, and an unknown channel", async () => {
    rt = installed();
    writeFileSync(rt.paths.layout, JSON.stringify({ schemaVersion: 2 }));
    const r = await run(["status"], {
      ctx: { ...rt.ctx, env: { ...rt.ctx.env, BROWX_RUNTIME_CHANNEL: "x" } },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("layout.json has schemaVersion 2");
    expect(r.out).toContain("✗ BROWX_RUNTIME_CHANNEL=x is not a channel");
  });
});

describe("browxai runtime rollback", () => {
  it("switches current to previous with no network, and back again", async () => {
    rt = installed();
    const first = await run(["rollback"]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("✓ current is 0.21.0, was 0.22.0.");
    expect(readCurrent(rt.paths)).toBe("0.21.0");
    expect(readState(rt.paths).previous).toBe("0.22.0");
    await run(["rollback"]);
    expect(readCurrent(rt.paths)).toBe("0.22.0");
  });

  it("holds the version it left, and a second rollback releases it", async () => {
    rt = installed();
    const first = await run(["rollback"], { now: () => Date.parse("2026-11-27T12:00:00.000Z") });
    expect(first.out).toContain(
      "0.22.0 is held: the updater doesn't apply it again until a newer version appears. " +
        "To apply it: browxai runtime update --version 0.22.0",
    );
    expect(readState(rt.paths)).toMatchObject({
      previous: "0.22.0",
      held: { "0.22.0": "rolled back by user" },
      pending: { version: "0.22.0", state: "held", reason: "rolled back by user" },
    });
    const journal = readFileSync(rt.paths.journal, "utf8").trim().split("\n");
    expect(JSON.parse(journal.at(-1)!)).toEqual({
      at: "2026-11-27T12:00:00.000Z",
      mode: "manual",
      event: "rollback",
      version: "0.21.0",
      from: "0.22.0",
      reason: "0.22.0 rolled back by user",
    });
    await run(["rollback"]);
    const state = readState(rt.paths);
    expect(readCurrent(rt.paths)).toBe("0.22.0");
    expect(state.held).toEqual({ "0.21.0": "rolled back by user" });
    expect(state.pending).toBeUndefined();
  });

  it("--to switches to any kept version", async () => {
    rt = installed();
    addVersion(rt.paths, "0.20.0");
    const r = await run(["rollback", "--to", "0.20.0"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("✓ current is 0.20.0, was 0.22.0.");
    expect(readCurrent(rt.paths)).toBe("0.20.0");
    expect(readState(rt.paths)).toMatchObject({
      previous: "0.22.0",
      held: { "0.22.0": "rolled back by user" },
    });
  });

  it("--to refuses a version that isn't kept, and changes nothing", async () => {
    rt = installed();
    const r = await run(["rollback", "--to", "0.19.0"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      "browxai runtime: 0.19.0 is not a kept version (kept: 0.22.0, 0.21.0). Nothing was changed.\n",
    );
    expect(readCurrent(rt.paths)).toBe("0.22.0");
    expect(readState(rt.paths).held).toBeUndefined();
  });

  it("--to the current version changes nothing", async () => {
    rt = installed();
    const r = await run(["rollback", "--to", "0.22.0"]);
    expect(r).toEqual({
      code: 0,
      out: "current is already 0.22.0. Nothing was changed.\n",
      err: "",
    });
    expect(readState(rt.paths).held).toBeUndefined();
  });

  it.each([[["rollback", "--to", "latest"]], [["rollback", "0.21.0"]], [["rollback", "--to"]]])(
    "rejects %j as usage",
    async (args) => {
      rt = installed();
      expect(await run(args)).toEqual({ code: 2, out: "", err: RUNTIME_USAGE });
    },
  );

  it("exits 1 and changes nothing with no previous version", async () => {
    rt = installed();
    writeState(rt.paths, {});
    const r = await run(["rollback"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no previous version");
    expect(readCurrent(rt.paths)).toBe("0.22.0");
  });
});

describe("browxai runtime gc", () => {
  it("prints what it kept and removed", async () => {
    rt = installed();
    for (const v of ["0.19.0", "0.20.0"]) addVersion(rt.paths, v);
    const r = await run(["gc"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("kept: 0.22.0, 0.21.0, 0.20.0\nremoved: 0.19.0\n");
  });

  it("exits 1 when the process list can't be read", async () => {
    rt = installed();
    for (const v of ["0.19.0", "0.20.0"]) addVersion(rt.paths, v);
    const r = await run(["gc"], { list: async () => undefined });
    expect(r.code).toBe(1);
    expect(r.err).toContain("no version was removed");
  });
});
