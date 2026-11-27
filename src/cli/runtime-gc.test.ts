import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addVersion, tempRuntime, type TempRuntime } from "./__fixtures__/runtime-tree.js";
import {
  collectGarbage,
  parsePs,
  systemProcessLister,
  versionsInUse,
  versionsToKeep,
  type ProcessInfo,
} from "./runtime-gc.js";
import { versionDir } from "./runtime-layout.js";
import { switchCurrent } from "./runtime-store.js";

let rt: TempRuntime | undefined;
afterEach(() => {
  rt?.cleanup();
  rt = undefined;
});

const listing = (ps: ProcessInfo[] | undefined) => async () => ps;
const server = (pid: number, root: string, v: string): ProcessInfo => ({
  pid,
  command: `/usr/local/bin/node ${root}/versions/${v}/node_modules/browxai/dist/cli.js serve --socket /tmp/s`,
});

describe("versionsToKeep", () => {
  it("keeps current, previous and the newest other one", () => {
    const all = ["0.24.0", "0.23.0", "0.22.0", "0.21.0", "0.20.0"];
    expect([...versionsToKeep(all, "0.22.0", "0.20.0")].sort()).toEqual([
      "0.20.0",
      "0.22.0",
      "0.24.0",
    ]);
    expect([...versionsToKeep(all, "0.24.0", "0.23.0")].sort()).toEqual([
      "0.22.0",
      "0.23.0",
      "0.24.0",
    ]);
    expect([...versionsToKeep(all, undefined, undefined)].sort()).toEqual([
      "0.22.0",
      "0.23.0",
      "0.24.0",
    ]);
  });
});

describe("the process list", () => {
  it("parses ps output", () => {
    expect(parsePs("  12 /bin/node a b\n345 x\n\nbad\n")).toEqual([
      { pid: 12, command: "/bin/node a b" },
      { pid: 345, command: "x" },
    ]);
  });

  it("runs ps with POSIX flags off Linux, and reports a failed ps as unknown", async () => {
    const calls: string[][] = [];
    const lister = systemProcessLister(async (file, args) => {
      calls.push([file, ...args]);
      return { status: 1, stdout: "", stderr: "" };
    }, "darwin");
    expect(await lister()).toBeUndefined();
    expect(calls).toEqual([["ps", "-A", "-o", "pid=", "-o", "args="]]);
  });

  it.runIf(process.platform === "linux")(
    "reads /proc on Linux and finds this process",
    async () => {
      const lister = systemProcessLister(
        async () => ({ status: 1, stdout: "", stderr: "" }),
        "linux",
      );
      const all = await lister();
      expect(all?.some((p) => p.pid === process.pid)).toBe(true);
    },
  );

  it("maps each version to the pids whose command line names it", async () => {
    rt = tempRuntime();
    const root = rt.paths.root;
    const use = await versionsInUse(
      rt.paths,
      listing([
        server(10, root, "0.21.0"),
        server(11, root, "0.21.0"),
        server(12, root, "0.22.0"),
        { pid: 13, command: `grep ${root}/versions/` },
        { pid: 14, command: `node /elsewhere/versions/0.20.0/cli.js` },
      ]),
    );
    expect(Object.fromEntries(use!)).toEqual({ "0.21.0": [10, 11], "0.22.0": [12] });
  });
});

describe("collectGarbage", () => {
  function fiveVersions(): TempRuntime {
    rt = tempRuntime();
    for (const v of ["0.20.0", "0.21.0", "0.22.0", "0.23.0", "0.24.0"]) addVersion(rt.paths, v);
    switchCurrent(rt.paths, "0.22.0");
    return rt;
  }

  it("removes versions past three that no process uses, and skips one in use", async () => {
    const { paths } = fiveVersions();
    const r = await collectGarbage(
      paths,
      { previous: "0.21.0" },
      { list: listing([server(99, paths.root, "0.20.0")]) },
    );
    expect(r.kept.sort()).toEqual(["0.21.0", "0.22.0", "0.24.0"]);
    expect(r.removed).toEqual(["0.23.0"]);
    expect(r.inUse).toEqual([{ version: "0.20.0", pids: [99] }]);
    expect(existsSync(versionDir(paths, "0.23.0"))).toBe(false);
    expect(existsSync(versionDir(paths, "0.20.0"))).toBe(true);
    expect(r.unknown).toBe(false);
  });

  it("removes nothing when the process list can't be read", async () => {
    const { paths } = fiveVersions();
    const r = await collectGarbage(paths, { previous: "0.21.0" }, { list: listing(undefined) });
    expect(r).toMatchObject({ removed: [], unknown: true });
    for (const v of ["0.20.0", "0.23.0"]) expect(existsSync(versionDir(paths, v))).toBe(true);
  });

  it("never removes current or previous, in use or not", async () => {
    const { paths } = fiveVersions();
    const r = await collectGarbage(paths, { previous: "0.20.0" }, { list: listing([]) });
    expect(r.removed.sort()).toEqual(["0.21.0", "0.23.0"]);
    expect(existsSync(versionDir(paths, "0.20.0"))).toBe(true);
    expect(existsSync(versionDir(paths, "0.22.0"))).toBe(true);
  });

  it("sweeps staging directories older than an hour whose process is gone", async () => {
    rt = tempRuntime();
    const now = Date.now();
    const old = (now - 2 * 60 * 60 * 1000) / 1000;
    for (const name of ["0.22.0-111", "0.22.0-222", "0.23.0-333"])
      mkdirSync(join(rt.paths.staging, name));
    utimesSync(join(rt.paths.staging, "0.22.0-111"), old, old);
    utimesSync(join(rt.paths.staging, "0.22.0-222"), old, old);
    const r = await collectGarbage(
      rt.paths,
      {},
      { list: listing([]), now: () => now, alive: (pid) => pid === 222 },
    );
    expect(r.stagingRemoved).toEqual(["0.22.0-111"]);
    expect(existsSync(join(rt.paths.staging, "0.22.0-222"))).toBe(true);
    expect(existsSync(join(rt.paths.staging, "0.23.0-333"))).toBe(true);
  });
});
