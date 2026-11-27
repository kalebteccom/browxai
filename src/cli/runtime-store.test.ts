import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { addVersion, tempRuntime, type TempRuntime } from "./__fixtures__/runtime-tree.js";
import {
  createLayout,
  listVersions,
  readCurrent,
  readState,
  switchCurrent,
  writeFileAtomic,
  writeState,
} from "./runtime-store.js";

let rt: TempRuntime | undefined;
afterEach(() => {
  rt?.cleanup();
  rt = undefined;
});

describe("createLayout", () => {
  it("makes 0700 directories and layout.json with schemaVersion 1", () => {
    rt = tempRuntime();
    for (const dir of [rt.paths.root, rt.paths.versions, rt.paths.staging, rt.paths.bin]) {
      expect(statSync(dir).mode & 0o777, dir).toBe(0o700);
    }
    expect(JSON.parse(readFileSync(rt.paths.layout, "utf8"))).toEqual({ schemaVersion: 1 });
    expect(statSync(rt.paths.layout).mode & 0o777).toBe(0o600);
  });

  it("leaves an existing layout.json alone", () => {
    rt = tempRuntime();
    writeFileSync(rt.paths.layout, '{"schemaVersion":1,"note":"kept"}');
    createLayout(rt.paths);
    expect(readFileSync(rt.paths.layout, "utf8")).toContain("kept");
  });
});

describe("switchCurrent", () => {
  it("points current at versions/<v> with a relative link", () => {
    rt = tempRuntime();
    addVersion(rt.paths, "0.21.0");
    switchCurrent(rt.paths, "0.21.0");
    expect(lstatSync(rt.paths.current).isSymbolicLink()).toBe(true);
    expect(readlinkSync(rt.paths.current)).toBe(join("versions", "0.21.0"));
    expect(readCurrent(rt.paths)).toBe("0.21.0");
  });

  it("refuses a version with no cli.js and leaves current alone", () => {
    rt = tempRuntime();
    addVersion(rt.paths, "0.21.0");
    switchCurrent(rt.paths, "0.21.0");
    expect(() => switchCurrent(rt!.paths, "0.22.0")).toThrow(/is missing/);
    expect(() => switchCurrent(rt!.paths, "../x")).toThrow(/not a version/);
    expect(readCurrent(rt.paths)).toBe("0.21.0");
  });

  it("leaves current valid when the switch fails before or at the rename", () => {
    rt = tempRuntime();
    addVersion(rt.paths, "0.21.0");
    addVersion(rt.paths, "0.22.0");
    switchCurrent(rt.paths, "0.21.0");
    const crash = () => {
      throw new Error("crash");
    };
    expect(() => switchCurrent(rt!.paths, "0.22.0", { rename: crash }, 4242)).toThrow("crash");
    expect(readCurrent(rt.paths)).toBe("0.21.0");
    expect(existsSync(join(rt.paths.root, "current.tmp-4242"))).toBe(false);
    expect(() => switchCurrent(rt!.paths, "0.22.0", { symlink: crash })).toThrow("crash");
    expect(readCurrent(rt.paths)).toBe("0.21.0");
  });

  it("replaces a stale temp link left by a killed switch", () => {
    rt = tempRuntime();
    addVersion(rt.paths, "0.21.0");
    symlinkSync("versions/nowhere", join(rt.paths.root, "current.tmp-77"));
    switchCurrent(rt.paths, "0.21.0", {}, 77);
    expect(readCurrent(rt.paths)).toBe("0.21.0");
  });

  // On ext4 a rename over a symlink is atomic for every reader. On APFS a lookup
  // that races the rename can fail with EINVAL, up to twice in a row in a tight
  // loop, so the launcher tries three times; this reader does the same and must
  // never fail all three.
  it("never leaves current missing for a concurrent reader across 10,000 switches", async () => {
    rt = tempRuntime();
    addVersion(rt.paths, "1.0.0");
    addVersion(rt.paths, "2.0.0");
    switchCurrent(rt.paths, "1.0.0");
    const stop = new Int32Array(new SharedArrayBuffer(4));
    // The reader resolves current the way the launcher does: through the link to cli.js.
    const reader = new Worker(
      `const { workerData, parentPort } = require("node:worker_threads");
       const { statSync } = require("node:fs");
       const stop = new Int32Array(workerData.stop);
       const ok = () => { try { statSync(workerData.cli); return true; } catch { return false; } };
       let reads = 0, misses = 0, failures = 0;
       parentPort.postMessage("ready");
       while (Atomics.load(stop, 0) === 0) {
         if (!ok()) { misses++; if (!ok() && !ok()) failures++; }
         reads++;
       }
       parentPort.postMessage({ reads, misses, failures });`,
      {
        eval: true,
        workerData: {
          stop: stop.buffer,
          cli: join(rt.paths.current, "node_modules/browxai/dist/cli.js"),
        },
      },
    );
    type Counts = { reads: number; misses: number; failures: number };
    const result = new Promise<Counts>((resolve, reject) => {
      reader.on("message", (m: unknown) => {
        if (typeof m === "object") resolve(m as Counts);
      });
      reader.on("error", reject);
    });
    await new Promise((r) => reader.once("message", r));
    for (let i = 0; i < 10_000; i++) switchCurrent(rt.paths, i % 2 === 0 ? "2.0.0" : "1.0.0");
    Atomics.store(stop, 0, 1);
    const { reads, misses, failures } = await result;
    await reader.terminate();
    expect(reads).toBeGreaterThan(0);
    expect(failures).toBe(0);
    if (process.platform === "linux") expect(misses).toBe(0);
  }, 60_000);
});

describe("listVersions", () => {
  it("lists version directories newest first and ignores anything else", () => {
    rt = tempRuntime();
    for (const v of ["0.9.0", "0.21.0", "0.10.0", "0.22.0-next.1"]) addVersion(rt.paths, v);
    writeFileSync(join(rt.paths.versions, "notes.txt"), "");
    expect(listVersions(rt.paths)).toEqual(["0.22.0-next.1", "0.21.0", "0.10.0", "0.9.0"]);
  });
});

describe("state.json", () => {
  it("round-trips, mode 0600", () => {
    rt = tempRuntime();
    writeState(rt.paths, { previous: "0.21.0", failed: { "0.22.0": 1 } });
    expect(readState(rt.paths)).toEqual({ previous: "0.21.0", failed: { "0.22.0": 1 } });
    expect(statSync(rt.paths.state).mode & 0o777).toBe(0o600);
  });

  it("reads a missing, broken or odd file as empty", () => {
    rt = tempRuntime();
    expect(readState(rt.paths)).toEqual({});
    writeFileSync(rt.paths.state, "[");
    expect(readState(rt.paths)).toEqual({});
    writeFileSync(rt.paths.state, JSON.stringify({ previous: "../../x" }));
    expect(readState(rt.paths)).toEqual({});
  });
});

describe("writeFileAtomic", () => {
  it("sets the mode exactly and leaves no temp file", () => {
    rt = tempRuntime();
    const path = join(rt.paths.root, "f");
    writeFileAtomic(path, "one", 0o640);
    writeFileAtomic(path, "two", 0o600);
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(join(rt.paths.root, `.f.tmp-${process.pid}`))).toBe(false);
  });
});
