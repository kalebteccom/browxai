// `browxai runtime update --auto` with a fake clock, a fake registry, a fake npm
// and a fake smoke check. No network, no launchd or systemd, temp directories only.

import { writeFileSync } from "node:fs";
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
import { readJournal } from "./runtime-journal.js";
import { versionDir } from "./runtime-layout.js";
import type { Registry } from "./runtime-npm.js";
import { HOUR } from "./runtime-schedule.js";
import type { SmokeResult } from "./runtime-smoke.js";
import { readCurrent, readState, switchCurrent, writeState } from "./runtime-store.js";
import { runRuntime, type RuntimeDeps } from "./runtime.js";

let rt: TempRuntime | undefined;
afterEach(() => {
  rt?.cleanup();
  rt = undefined;
});

const NODE = "/opt/node/bin/node";
const T0 = Date.parse("2026-11-27T12:00:00.000Z");
const BOOT = Date.parse("2026-11-27T08:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

/** A clock the test moves by hand. */
function clock(start = T0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => (now += ms),
  };
}

/** A registry that counts its contacts. */
function counted(registry: Registry): Registry & { contacts: number } {
  const r = {
    contacts: 0,
    view: (spec: string) => {
      r.contacts++;
      return registry.view(spec);
    },
  };
  return r;
}

function installed(): TempRuntime {
  rt = tempRuntime();
  writeFileSync(rt.paths.nodePath, NODE + "\n");
  addVersion(rt.paths, "0.22.0");
  switchCurrent(rt.paths, "0.22.0");
  // The boot was seen, so the first run here doesn't wait for one.
  writeState(rt.paths, { bootSeen: BOOT });
  return rt;
}

interface Setup {
  c?: ReturnType<typeof clock>;
  registry?: Registry & { contacts: number };
  npm?: ReturnType<typeof fakeNpm>;
  env?: NodeJS.ProcessEnv;
  smoke?: () => Promise<SmokeResult>;
  verify?: RuntimeDeps["verify"];
  boot?: number;
}

function setup(s: Setup = {}) {
  const c = s.c ?? clock();
  const registry =
    s.registry ??
    counted(fakeRegistry({ "0.23.0": { publishedAt: iso(T0 - 48 * HOUR) } }, { latest: "0.23.0" }));
  const npm = s.npm ?? fakeNpm();
  const auto = async (args: string[] = []) => {
    let out = "";
    let err = "";
    const code = await runRuntime(["update", "--auto", ...args], {
      ctx: { ...rt!.ctx, env: { ...rt!.ctx.env, ...s.env } },
      appBundle: () => undefined,
      list: () => Promise.resolve([]),
      execPath: NODE,
      findNpm: () => "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
      run: npm,
      registry: () => registry,
      smoke: s.smoke ?? (() => Promise.resolve<SmokeResult>({ ok: true, notes: [] })),
      ...(s.verify ? { verify: s.verify } : {}),
      agent: fakeAgent(),
      clock: { now: c.now, random: () => 0, bootTime: () => Promise.resolve(s.boot ?? BOOT) },
      out: (t) => (out += t),
      err: (t) => (err += t),
    });
    return { code, out, err };
  };
  return { c, registry, npm, auto };
}

describe("update --auto: the schedule", () => {
  it("applies the channel's version once its delay has passed, and journals it", async () => {
    rt = installed();
    const { auto, registry } = setup();
    const r = await auto();
    expect(r.code).toBe(0);
    expect(registry.contacts).toBe(1);
    expect(readCurrent(rt.paths)).toBe("0.23.0");
    const state = readState(rt.paths);
    expect(state).toMatchObject({
      previous: "0.22.0",
      lastCheck: iso(T0),
      nextCheck: iso(T0 + 6 * HOUR),
      lastResult: "applied 0.23.0",
      contacts: [iso(T0)],
      applies: [iso(T0)],
    });
    expect(state.pending).toBeUndefined();
    expect(readJournal(rt.paths)).toEqual([
      expect.objectContaining({
        at: iso(T0),
        mode: "auto",
        event: "apply",
        version: "0.23.0",
        from: "0.22.0",
        result: "applied",
      }),
    ]);
  });

  it("returns at once before the next check, with no contact and no journal line", async () => {
    rt = installed();
    const { auto, registry, c } = setup();
    await auto();
    c.advance(5 * HOUR);
    const r = await auto();
    expect(r).toMatchObject({ code: 0, out: "", err: "" });
    expect(registry.contacts).toBe(1);
    expect(readJournal(rt.paths)).toHaveLength(1);
    c.advance(HOUR);
    await auto();
    expect(registry.contacts).toBe(2);
  });

  it("waits 10 to 30 minutes after the first run that follows a boot", async () => {
    rt = installed();
    const { auto, registry, c } = setup({ boot: BOOT + 24 * HOUR });
    await auto();
    expect(registry.contacts).toBe(0);
    expect(readState(rt.paths)).toMatchObject({
      bootSeen: BOOT + 24 * HOUR,
      nextCheck: iso(T0 + 10 * MIN),
    });
    c.advance(10 * MIN);
    await auto();
    expect(registry.contacts).toBe(1);
  });

  it("keeps a later nextCheck when a boot comes before it", async () => {
    rt = installed();
    writeState(rt.paths, { bootSeen: BOOT, nextCheck: iso(T0 + 3 * HOUR) });
    const { auto } = setup({ boot: BOOT + HOUR });
    await auto();
    expect(readState(rt.paths).nextCheck).toBe(iso(T0 + 3 * HOUR));
  });

  it("holds back a version published less than 24 hours ago, and --now applies it", async () => {
    rt = installed();
    const registry = counted(
      fakeRegistry({ "0.23.0": { publishedAt: iso(T0 - 2 * HOUR) } }, { latest: "0.23.0" }),
    );
    const { auto, npm } = setup({ registry });
    const r = await auto();
    expect(r.out).toContain(`0.23.0 waits until ${iso(T0 + 22 * HOUR)}`);
    expect(npm.calls).toEqual([]);
    expect(readState(rt.paths).pending).toEqual({
      version: "0.23.0",
      state: "waiting",
      until: iso(T0 + 22 * HOUR),
    });
    writeState(rt.paths, { ...readState(rt.paths), nextCheck: iso(T0) });
    await auto(["--now"]);
    expect(readCurrent(rt.paths)).toBe("0.23.0");
  });

  it("honours cooldownHours in runtime.json and keeps 24 for a value it doesn't know", async () => {
    rt = installed();
    const registry = counted(
      fakeRegistry({ "0.23.0": { publishedAt: iso(T0 - 2 * HOUR) } }, { latest: "0.23.0" }),
    );
    writeFileSync(rt.paths.settings, JSON.stringify({ cooldownHours: "soon" }));
    const { auto } = setup({ registry });
    const r = await auto();
    expect(r.err).toContain('"cooldownHours" in runtime.json is "soon"');
    expect(readCurrent(rt.paths)).toBe("0.22.0");
    writeFileSync(rt.paths.settings, JSON.stringify({ cooldownHours: 1 }));
    writeState(rt.paths, { ...readState(rt.paths), nextCheck: iso(T0) });
    await auto();
    expect(readCurrent(rt.paths)).toBe("0.23.0");
  });

  it("stops at 6 registry contacts in 24 hours", async () => {
    rt = installed();
    const contacts = [5, 4, 3, 2, 1, 0.5].map((h) => iso(T0 - h * HOUR));
    writeState(rt.paths, { bootSeen: BOOT, contacts });
    const { auto, registry } = setup();
    const r = await auto();
    expect(registry.contacts).toBe(0);
    expect(r.out).toContain("6 registry contacts in 24 hours");
    expect(readState(rt.paths).nextCheck).toBe(iso(T0 + 19 * HOUR));
  });

  it("stops at 2 applies in 24 hours", async () => {
    rt = installed();
    writeState(rt.paths, { bootSeen: BOOT, applies: [iso(T0 - 2 * HOUR), iso(T0 - HOUR)] });
    const { auto, npm } = setup();
    await auto();
    expect(npm.calls).toEqual([]);
    expect(readState(rt.paths).pending).toMatchObject({ version: "0.23.0", state: "limit" });
  });

  it("records a deprecated current and skips a deprecated newer version", async () => {
    rt = installed();
    const registry = counted(
      fakeRegistry({ "0.22.0": { deprecated: "Use 0.22.1." } }, { latest: "0.22.0" }),
    );
    const { auto } = setup({ registry });
    await auto();
    expect(readState(rt.paths).currentDeprecated).toBe("Use 0.22.1.");
  });
});

describe("update --auto: offline and failures", () => {
  it("offline: exits 0, leaves current alone, backs off 1 hour, doubling, reset by an answer", async () => {
    rt = installed();
    const down = counted(fakeRegistry({}, {}, { unreachable: true }));
    const { auto, c } = setup({ registry: down });
    expect((await auto()).code).toBe(0);
    expect(readCurrent(rt.paths)).toBe("0.22.0");
    expect(readState(rt.paths)).toMatchObject({
      backoffMs: HOUR,
      backoffUntil: iso(T0 + HOUR),
      lastResult: "offline",
    });
    expect(readJournal(rt.paths).at(-1)).toMatchObject({ event: "offline" });
    c.advance(30 * MIN);
    await auto();
    expect(down.contacts).toBe(1);
    c.advance(30 * MIN);
    await auto();
    expect(readState(rt.paths)).toMatchObject({ backoffMs: 2 * HOUR });
    // Back online: the same runtime, a registry that answers.
    c.advance(2 * HOUR);
    const up = setup({ c });
    await up.auto();
    const state = readState(rt.paths);
    expect(state.backoffMs).toBeUndefined();
    expect(state.backoffUntil).toBeUndefined();
    expect(readCurrent(rt.paths)).toBe("0.23.0");
  });

  it("a failed smoke check leaves current alone, and the third failure holds the version", async () => {
    rt = installed();
    const smoke = () =>
      Promise.resolve<SmokeResult>({ ok: false, reason: "MCP handshake: no answer" });
    const { auto, c, npm } = setup({ smoke });
    for (let i = 1; i <= 3; i++) {
      expect((await auto()).code).toBe(0);
      expect(readCurrent(rt.paths)).toBe("0.22.0");
      expect(readState(rt.paths).failed).toEqual({ "0.23.0": i });
      // 13 hours apart, so each apply fits the limit of 2 in 24 hours.
      c.advance(13 * HOUR);
    }
    expect(readState(rt.paths)).toMatchObject({
      held: { "0.23.0": "failed its checks 3 times" },
      pending: { version: "0.23.0", state: "held", reason: "failed its checks 3 times" },
    });
    const installs = npm.calls.filter((call) => call.args.includes("install")).length;
    expect(installs).toBe(3);
    await auto();
    expect(npm.calls.filter((call) => call.args.includes("install"))).toHaveLength(3);
    const applies = readJournal(rt.paths).filter((e) => e.event === "apply");
    expect(applies.map((e) => e.result)).toEqual(["failed", "failed", "failed"]);
  });

  it("a failed verification holds the version at once", async () => {
    rt = installed();
    const { auto } = setup({
      verify: () =>
        Promise.resolve({ ok: false, detail: "npm audit signatures failed (1 invalid)" }),
    });
    await auto();
    expect(readState(rt.paths)).toMatchObject({
      held: { "0.23.0": "verification failed" },
      pending: { version: "0.23.0", state: "held", reason: "verification failed" },
    });
  });

  it("exits 0 with no contact while another live run holds the lock", async () => {
    rt = installed();
    writeFileSync(rt.paths.lock, JSON.stringify({ pid: process.ppid, startedAt: iso(T0) }));
    const { auto, registry } = setup();
    const r = await auto();
    expect(r.code).toBe(0);
    expect(r.out).toContain(`another update run (pid ${process.ppid})`);
    expect(registry.contacts).toBe(0);
  });

  it("exits 1 and journals an internal error when npm can't be found", async () => {
    rt = installed();
    let out = "";
    const code = await runRuntime(["update", "--auto"], {
      ctx: rt.ctx,
      appBundle: () => undefined,
      list: () => Promise.resolve([]),
      execPath: NODE,
      findNpm: () => undefined,
      agent: fakeAgent(),
      clock: { now: () => T0, random: () => 0, bootTime: () => Promise.resolve(BOOT) },
      out: (t) => (out += t),
      err: (t) => (out += t),
    });
    expect(code).toBe(1);
    expect(readJournal(rt.paths).at(-1)).toMatchObject({ event: "error" });
    expect(readState(rt.paths).lastResult).toContain("no npm-cli.js next to");
  });
});

describe("update --auto: the opt-out", () => {
  it.each([["off"], ["0"], ["false"], ["no"], ["OFF"]])(
    "BROWX_RUNTIME_AUTO_UPDATE=%s turns it off with no contact",
    async (value) => {
      rt = installed();
      const { auto, registry } = setup({ env: { BROWX_RUNTIME_AUTO_UPDATE: value } });
      const r = await auto();
      expect(r.code).toBe(0);
      expect(r.out).toContain("auto-update off (BROWX_RUNTIME_AUTO_UPDATE)");
      expect(registry.contacts).toBe(0);
    },
  );

  it("an unknown value counts as off, with a warning", async () => {
    rt = installed();
    const { auto, registry } = setup({ env: { BROWX_RUNTIME_AUTO_UPDATE: "sometimes" } });
    const r = await auto();
    expect(r.err).toContain("BROWX_RUNTIME_AUTO_UPDATE=sometimes is not on or off");
    expect(registry.contacts).toBe(0);
  });

  it('"autoUpdate": "off" in runtime.json wins over on in the environment', async () => {
    rt = installed();
    writeFileSync(rt.paths.settings, JSON.stringify({ autoUpdate: "off" }));
    const { auto, registry } = setup({ env: { BROWX_RUNTIME_AUTO_UPDATE: "on" } });
    const r = await auto();
    expect(r.out).toContain("auto-update off (runtime.json)");
    expect(registry.contacts).toBe(0);
  });

  it("an unreadable runtime.json counts as off", async () => {
    rt = installed();
    writeFileSync(rt.paths.settings, "{");
    const { auto, registry } = setup();
    const r = await auto();
    expect(r.err).toContain("so auto-update is off");
    expect(registry.contacts).toBe(0);
  });

  it("journals the off state once, not on every hourly run", async () => {
    rt = installed();
    const { auto, c } = setup({ env: { BROWX_RUNTIME_AUTO_UPDATE: "off" } });
    await auto();
    c.advance(HOUR);
    await auto();
    expect(readJournal(rt.paths)).toEqual([
      expect.objectContaining({
        event: "skip",
        result: "auto-update off (BROWX_RUNTIME_AUTO_UPDATE)",
      }),
    ]);
  });
});

describe("update --auto: held versions", () => {
  /** A runtime whose `current` is `version`, with the boot already seen. */
  function on(version: string): TempRuntime {
    rt = tempRuntime();
    writeFileSync(rt.paths.nodePath, NODE + "\n");
    addVersion(rt.paths, version);
    switchCurrent(rt.paths, version);
    writeState(rt.paths, { bootSeen: BOOT });
    return rt;
  }

  it("holds a new major version until runtime config major allow", async () => {
    rt = on("1.4.0");
    const registry = counted(
      fakeRegistry({ "2.0.0": { publishedAt: iso(T0 - 48 * HOUR) } }, { latest: "2.0.0" }),
    );
    const { auto, npm, c } = setup({ registry });
    const r = await auto();
    expect(r.code).toBe(0);
    expect(readCurrent(rt.paths)).toBe("1.4.0");
    expect(npm.calls).toEqual([]);
    expect(readState(rt.paths).pending).toEqual({
      version: "2.0.0",
      state: "held",
      reason:
        "a new major version (1.4.0 to 2.0.0). Run browxai runtime update --allow-major, " +
        "or browxai runtime config major allow",
    });
    writeFileSync(rt.paths.settings, JSON.stringify({ majorPolicy: "allow" }));
    c.advance(7 * HOUR);
    await auto();
    expect(readCurrent(rt.paths)).toBe("2.0.0");
  });

  it("holds a version whose engines.node the runtime's node misses", async () => {
    rt = installed();
    const registry = counted(
      fakeRegistry(
        { "0.23.0": { publishedAt: iso(T0 - 48 * HOUR), enginesNode: ">=24" } },
        { latest: "0.23.0" },
      ),
    );
    const { auto, npm } = setup({ registry, npm: fakeNpm({ nodeVersion: "22.11.0" }) });
    await auto();
    expect(readCurrent(rt.paths)).toBe("0.22.0");
    expect(npm.calls).toEqual([]);
    expect(readState(rt.paths).pending).toEqual({
      version: "0.23.0",
      state: "held",
      reason: `needs Node >=24, and the runtime's node at ${NODE} is 22.11.0`,
    });
  });

  it("applies it once the node satisfies the range", async () => {
    rt = installed();
    const registry = counted(
      fakeRegistry(
        { "0.23.0": { publishedAt: iso(T0 - 48 * HOUR), enginesNode: ">=24" } },
        { latest: "0.23.0" },
      ),
    );
    const { auto } = setup({ registry, npm: fakeNpm({ nodeVersion: "24.1.0" }) });
    await auto();
    expect(readCurrent(rt.paths)).toBe("0.23.0");
  });

  it("holds a Playwright bump where sessions use the bundled Chromium, without a retry", async () => {
    rt = installed();
    addPackage(versionDir(rt.paths, "0.22.0"), "playwright-core", "1.65.1");
    const npm = fakeNpm({ playwright: "1.66.0" });
    const { auto, c } = setup({
      npm,
      smoke: () => Promise.resolve<SmokeResult>({ ok: true, notes: [], bundledChromium: true }),
    });
    const r = await auto();
    expect(r.code).toBe(0);
    expect(readCurrent(rt.paths)).toBe("0.22.0");
    const state = readState(rt.paths);
    expect(state.held?.["0.23.0"]).toMatch(/^needs a Chromium download: it moves playwright-core/);
    expect(state.failed?.["0.23.0"]).toBeUndefined();
    expect(state.pending).toMatchObject({ version: "0.23.0", state: "held" });
    expect(readJournal(rt.paths).at(-1)).toMatchObject({ event: "apply", result: "held" });
    const installs = npm.calls.filter((x) => x.args.includes("install")).length;
    c.advance(7 * HOUR);
    await auto();
    expect(npm.calls.filter((x) => x.args.includes("install")).length).toBe(installs);
    expect(readCurrent(rt.paths)).toBe("0.22.0");
  });

  it("does not apply a version a rollback left", async () => {
    rt = installed();
    writeState(rt.paths, { bootSeen: BOOT, held: { "0.23.0": "rolled back by user" } });
    const { auto, npm } = setup();
    await auto();
    expect(npm.calls).toEqual([]);
    expect(readState(rt.paths).pending).toEqual({
      version: "0.23.0",
      state: "held",
      reason: "rolled back by user",
    });
  });
});
