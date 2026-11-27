// `browxai runtime update`, `install --link` and `uninstall --keep-versions` with
// a fake registry, a fake npm and a fake smoke check. Temp directories stand in
// for the home directory and PATH; nothing touches a real bin directory.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addPackage,
  addVersion,
  fakeAgent,
  fakeNpm,
  fakeRegistry,
  tempRuntime,
  type TempRuntime,
} from "./__fixtures__/runtime-tree.js";
import { versionDir } from "./runtime-layout.js";
import type { SmokeResult } from "./runtime-smoke.js";
import { writeShim } from "./runtime-shim.js";
import { readCurrent, readState, switchCurrent, writeState } from "./runtime-store.js";
import { runRuntime, type RuntimeDeps } from "./runtime.js";

let rt: TempRuntime | undefined;
afterEach(() => {
  rt?.cleanup();
  rt = undefined;
});

const NODE = "/opt/node/bin/node";
const PASS = () => Promise.resolve<SmokeResult>({ ok: true, notes: [] });

async function run(args: string[], deps: RuntimeDeps = {}, env: NodeJS.ProcessEnv = {}) {
  let out = "";
  let err = "";
  const code = await runRuntime(args, {
    ctx: { ...rt!.ctx, env: { ...rt!.ctx.env, ...env } },
    appBundle: () => undefined,
    list: () => Promise.resolve([]),
    execPath: NODE,
    findNpm: () => "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
    run: fakeNpm(),
    smoke: PASS,
    system: { platform: "linux", home: rt!.home, env: {}, exists: () => false },
    agent: fakeAgent(),
    out: (t) => (out += t),
    err: (t) => (err += t),
    ...deps,
  });
  return { code, out, err };
}

/** A runtime on `version` with the recorded node. */
function on(version: string): TempRuntime {
  rt = tempRuntime();
  writeFileSync(rt.paths.nodePath, NODE + "\n");
  addVersion(rt.paths, version);
  switchCurrent(rt.paths, version);
  return rt;
}

const installs = (npm: ReturnType<typeof fakeNpm>) =>
  npm.calls.filter((c) => c.args.includes("install")).length;

describe("update: the major guard (D7)", () => {
  const registry = () => fakeRegistry({ "1.4.0": {}, "2.0.0": {} }, { latest: "2.0.0" });
  const HELD =
    "2.0.0 is held: a new major version (1.4.0 to 2.0.0). Run browxai runtime update --allow-major, " +
    "or browxai runtime config major allow. current stays 1.4.0.\n";

  it("holds a new major version, says why, and records it for doctor", async () => {
    rt = on("1.4.0");
    const npm = fakeNpm();
    const r = await run(["update"], { run: npm, registry });
    expect(r).toEqual({ code: 0, out: HELD, err: "" });
    expect(installs(npm)).toBe(0);
    expect(readCurrent(rt.paths)).toBe("1.4.0");
    expect(readState(rt.paths).pending).toMatchObject({ version: "2.0.0", state: "held" });
    const check = await run(["update", "--check"], { run: npm, registry });
    expect(check.out).toBe(HELD);
  });

  it("applies it with --allow-major, or with major allow in runtime.json", async () => {
    rt = on("1.4.0");
    expect((await run(["update", "--allow-major"], { registry })).code).toBe(0);
    expect(readCurrent(rt.paths)).toBe("2.0.0");
    rt.cleanup();
    rt = on("1.4.0");
    writeFileSync(rt.paths.settings, JSON.stringify({ majorPolicy: "allow" }));
    await run(["update"], { registry });
    expect(readCurrent(rt.paths)).toBe("2.0.0");
  });

  it("applies a version --version names, with a warning", async () => {
    rt = on("1.4.0");
    const r = await run(["update", "--version", "2.0.0"], { registry });
    expect(r.code).toBe(0);
    expect(r.err).toContain("warning: 2.0.0 is a new major version over 1.4.0\n");
    expect(readCurrent(rt.paths)).toBe("2.0.0");
  });

  it("lets a minor before 1.0 cross", async () => {
    rt = on("0.22.0");
    await run(["update"], {
      registry: () => fakeRegistry({ "0.23.0": {} }, { latest: "0.23.0" }),
    });
    expect(readCurrent(rt.paths)).toBe("0.23.0");
  });
});

describe("update: the Node engines hold", () => {
  const registry = () => fakeRegistry({ "0.23.0": { enginesNode: ">=24" } }, { latest: "0.23.0" });

  it("holds a version whose engines.node the runtime's node misses", async () => {
    rt = on("0.22.0");
    const npm = fakeNpm({ nodeVersion: "22.11.0" });
    const r = await run(["update"], { run: npm, registry });
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      `0.23.0 is held: needs Node >=24, and the runtime's node at ${NODE} is 22.11.0. ` +
        "current stays 0.22.0. To apply it anyway: browxai runtime update --version 0.23.0.\n",
    );
    expect(installs(npm)).toBe(0);
    expect(readState(rt.paths).pending).toEqual({
      version: "0.23.0",
      state: "held",
      reason: `needs Node >=24, and the runtime's node at ${NODE} is 22.11.0`,
    });
  });

  it("applies it on a node that satisfies the range", async () => {
    rt = on("0.22.0");
    await run(["update"], { run: fakeNpm({ nodeVersion: "24.1.0" }), registry });
    expect(readCurrent(rt.paths)).toBe("0.23.0");
  });

  it("warns and applies when --version names it", async () => {
    rt = on("0.22.0");
    const r = await run(["update", "--version", "0.23.0"], {
      run: fakeNpm({ nodeVersion: "22.11.0" }),
      registry,
    });
    expect(r.err).toContain(
      `warning: 0.23.0 needs Node >=24, and the runtime's node at ${NODE} is 22.11.0\n`,
    );
    expect(readCurrent(rt.paths)).toBe("0.23.0");
  });
});

describe("update: the Playwright-bump hold (D20)", () => {
  const registry = () => fakeRegistry({ "0.22.0": {}, "0.23.0": {} }, { latest: "0.23.0" });
  const bundled = () =>
    Promise.resolve<SmokeResult>({ ok: true, notes: [], bundledChromium: true });
  const HOLD =
    "needs a Chromium download: it moves playwright-core from 1.65.1 to 1.66.0, and this machine has no Google Chrome. " +
    "Run browxai runtime update --version 0.23.0, then npx playwright-core@1.66.0 install chromium";

  function onPlaywright(): TempRuntime {
    rt = on("0.22.0");
    addPackage(versionDir(rt.paths, "0.22.0"), "playwright-core", "1.65.1");
    return rt;
  }

  it("holds the version, removes its staging and counts no failure", async () => {
    rt = onPlaywright();
    const npm = fakeNpm({ playwright: "1.66.0" });
    const r = await run(["update"], { run: npm, registry, smoke: bundled });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`0.23.0 is held: ${HOLD}. current stays 0.22.0.\n`);
    expect(readCurrent(rt.paths)).toBe("0.22.0");
    expect(existsSync(versionDir(rt.paths, "0.23.0"))).toBe(false);
    expect(readdirSync(rt.paths.staging)).toEqual([]);
    const state = readState(rt.paths);
    expect(state.held).toEqual({ "0.23.0": HOLD });
    expect(state.failed?.["0.23.0"]).toBeUndefined();
    expect(state.pending).toEqual({ version: "0.23.0", state: "held", reason: HOLD });
    // The next update stops at the hold and downloads nothing.
    const again = await run(["update"], { run: npm, registry, smoke: bundled });
    expect(again.out).toBe(`0.23.0 is held: ${HOLD}. current stays 0.22.0.\n`);
    expect(installs(npm)).toBe(1);
  });

  it("--version applies it, names the browser download and releases the hold", async () => {
    rt = onPlaywright();
    const npm = fakeNpm({ playwright: "1.66.0" });
    await run(["update"], { run: npm, registry, smoke: bundled });
    const r = await run(["update", "--version", "0.23.0"], { run: npm, registry, smoke: bundled });
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "note: 0.23.0 moves playwright-core from 1.65.1 to 1.66.0, and this machine has no Google Chrome. " +
        "Run: npx playwright-core@1.66.0 install chromium\n",
    );
    expect(readCurrent(rt.paths)).toBe("0.23.0");
    expect(readState(rt.paths).held).toEqual({});
  });

  it("applies the bump where Google Chrome is installed", async () => {
    rt = onPlaywright();
    await run(["update"], { run: fakeNpm({ playwright: "1.66.0" }), registry });
    expect(readCurrent(rt.paths)).toBe("0.23.0");
  });

  it("applies a version with the same playwright-core", async () => {
    rt = onPlaywright();
    await run(["update"], { run: fakeNpm({ playwright: "1.65.1" }), registry, smoke: bundled });
    expect(readCurrent(rt.paths)).toBe("0.23.0");
  });
});

describe("update after a rollback", () => {
  it("holds the version the rollback left, until --version names it", async () => {
    rt = on("0.21.0");
    addVersion(rt.paths, "0.22.0");
    switchCurrent(rt.paths, "0.22.0");
    writeState(rt.paths, { previous: "0.21.0" });
    const registry = () => fakeRegistry({ "0.21.0": {}, "0.22.0": {} }, { latest: "0.22.0" });
    expect((await run(["rollback"])).code).toBe(0);
    const held = await run(["update"], { registry });
    expect(held.out).toBe(
      "0.22.0 is held: rolled back by user. current stays 0.21.0. " +
        "To apply it anyway: browxai runtime update --version 0.22.0.\n",
    );
    expect(readCurrent(rt.paths)).toBe("0.21.0");
    const named = await run(["update", "--version", "0.22.0"], { registry });
    expect(named.code).toBe(0);
    expect(readCurrent(rt.paths)).toBe("0.22.0");
    expect(readState(rt.paths).held).toEqual({});
  });

  it("applies a newer version, which clears the older hold", async () => {
    rt = on("0.21.0");
    writeState(rt.paths, { held: { "0.22.0": "rolled back by user" } });
    await run(["update"], {
      registry: () => fakeRegistry({ "0.23.0": {} }, { latest: "0.23.0" }),
    });
    expect(readCurrent(rt.paths)).toBe("0.23.0");
    expect(readState(rt.paths).held).toEqual({});
  });
});

describe("install --link", () => {
  const registry = () => fakeRegistry({ "0.22.0": {} }, { latest: "0.22.0" });

  it("links ~/.local/bin/browxai to the launcher and says what it did", async () => {
    rt = tempRuntime({ create: false });
    const bin = join(rt.home, ".local", "bin");
    const r = await run(["install", "--link"], { registry }, { PATH: `${bin}:/usr/bin` });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toContain(`✓ created ${bin}\n`);
    expect(r.out).toContain(`✓ linked ${bin}/browxai to ${rt.paths.shim}\n`);
    expect(r.out).not.toContain("is not on PATH");
    expect(readlinkSync(join(bin, "browxai"))).toBe(rt.paths.shim);
    const again = await run(["install", "--link"], { registry }, { PATH: bin });
    expect(again.out).toContain(`✓ ${bin}/browxai already links to ${rt.paths.shim}\n`);
  });

  it("never replaces a file that isn't its link", async () => {
    rt = tempRuntime({ create: false });
    const bin = join(rt.home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "browxai"), "#!/bin/sh\necho mine\n");
    const r = await run(["install", "--link"], { registry }, { PATH: bin });
    expect(r.code).toBe(0);
    expect(r.err).toContain(
      `warning: ${bin}/browxai exists and is not a link, so it was left alone and no link was made.`,
    );
    expect(readFileSync(join(bin, "browxai"), "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it("never replaces a link to something else", async () => {
    rt = tempRuntime({ create: false });
    const bin = join(rt.home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const other = join(rt.home, "other", "browxai");
    symlinkSync(other, join(bin, "browxai"));
    const r = await run(["install", "--link"], { registry }, { PATH: bin });
    expect(r.err).toContain(`exists and is a link to ${other}, so it was left alone`);
    expect(readlinkSync(join(bin, "browxai"))).toBe(other);
  });

  it("warns when another browxai comes earlier on PATH, and when the directory isn't on PATH", async () => {
    rt = tempRuntime({ create: false });
    const bin = join(rt.home, ".local", "bin");
    const early = join(rt.home, "early");
    mkdirSync(early, { recursive: true });
    writeFileSync(join(early, "browxai"), "#!/bin/sh\n");
    chmodSync(join(early, "browxai"), 0o755);
    const r = await run(["install", "--link"], { registry }, { PATH: `${early}:${bin}` });
    expect(r.err).toContain(`warning: ${early}/browxai comes earlier on PATH, so a shell runs it.`);
    rt.cleanup();
    rt = tempRuntime({ create: false });
    const off = await run(["install", "--link"], { registry }, { PATH: "/usr/bin" });
    expect(off.out).toContain(`${join(rt.home, ".local", "bin")} is not on PATH.`);
  });

  it("makes no link without --link", async () => {
    rt = tempRuntime({ create: false });
    await run(["install"], { registry });
    expect(existsSync(join(rt.home, ".local", "bin", "browxai"))).toBe(false);
  });
});

describe("uninstall: the link and --keep-versions", () => {
  function full(): TempRuntime {
    rt = on("0.21.0");
    addVersion(rt.paths, "0.22.0");
    switchCurrent(rt.paths, "0.22.0");
    writeShim(rt.paths);
    writeState(rt.paths, { previous: "0.21.0" });
    writeFileSync(rt.paths.settings, JSON.stringify({ channel: "latest" }));
    return rt;
  }

  it("removes its own link, and leaves another file alone", async () => {
    rt = full();
    const bin = join(rt.home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(rt.paths.shim, join(bin, "browxai"));
    const r = await run(["uninstall"]);
    expect(r.out).toContain(`✓ removed the link ${bin}/browxai\n`);
    expect(() => lstatSync(join(bin, "browxai"))).toThrow();
    rt.cleanup();
    rt = full();
    const bin2 = join(rt.home, ".local", "bin");
    mkdirSync(bin2, { recursive: true });
    writeFileSync(join(bin2, "browxai"), "mine\n");
    await run(["uninstall"]);
    expect(readFileSync(join(bin2, "browxai"), "utf8")).toBe("mine\n");
  });

  it("--keep-versions keeps versions/ and layout.json while a server runs, and install reuses them", async () => {
    rt = full();
    const agent = fakeAgent();
    await agent.install(rt.paths, NODE);
    const command = `node ${rt.paths.root}/versions/0.21.0/node_modules/browxai/dist/cli.js`;
    const r = await run(["uninstall", "--keep-versions"], {
      agent,
      list: () => Promise.resolve([{ pid: 777, command }]),
    });
    expect(r.code).toBe(0);
    expect(agent.calls.at(-1)).toBe("remove");
    expect(readdirSync(rt.paths.root).sort()).toEqual(["layout.json", "versions"]);
    expect(readdirSync(rt.paths.versions).sort()).toEqual(["0.21.0", "0.22.0"]);
    expect(r.out).toContain(
      `✓ removed the launcher, settings and state from ${rt.paths.root}. ` +
        "Kept versions/ (0.22.0, 0.21.0) and layout.json",
    );
    const npm = fakeNpm();
    const again = await run(["install"], {
      run: npm,
      registry: () => fakeRegistry({ "0.22.0": {} }, { latest: "0.22.0" }),
    });
    expect(again.code).toBe(0);
    expect(readCurrent(rt.paths)).toBe("0.22.0");
    expect(installs(npm)).toBe(0);
  });
});
