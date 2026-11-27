import { readFileSync, statSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  addVersion,
  fakeAgent,
  tempRuntime,
  type TempRuntime,
} from "./__fixtures__/runtime-tree.js";
import { parseConfigArgs } from "./runtime-config.js";
import { switchCurrent } from "./runtime-store.js";
import { RUNTIME_USAGE, runRuntime, type RuntimeDeps } from "./runtime.js";

let rt: TempRuntime | undefined;
afterEach(() => {
  rt?.cleanup();
  rt = undefined;
});

function installed(): TempRuntime {
  rt = tempRuntime();
  addVersion(rt.paths, "0.22.0");
  switchCurrent(rt.paths, "0.22.0");
  return rt;
}

async function run(args: string[], env: NodeJS.ProcessEnv = {}, deps: RuntimeDeps = {}) {
  let out = "";
  let err = "";
  const code = await runRuntime(["config", ...args], {
    ctx: { ...rt!.ctx, env: { ...rt!.ctx.env, ...env } },
    appBundle: () => undefined,
    list: async () => [],
    agent: fakeAgent(),
    out: (t) => (out += t),
    err: (t) => (err += t),
    ...deps,
  });
  return { code, out, err };
}

const settings = () =>
  JSON.parse(readFileSync(rt!.paths.settings, "utf8")) as Record<string, unknown>;

describe("runtime config arguments", () => {
  it.each([
    [[], null],
    [["auto-update", "on"], { key: "auto-update", value: "on" }],
    [["auto-update", "off"], { key: "auto-update", value: "off" }],
    [["channel", "latest"], { key: "channel", value: "latest" }],
    [["channel", "next"], { key: "channel", value: "next" }],
    [["cooldown-hours", "0"], { key: "cooldown-hours", value: 0 }],
    [["cooldown-hours", "720"], { key: "cooldown-hours", value: 720 }],
  ])("reads %j", (args, want) => {
    expect(parseConfigArgs(args)).toEqual(want);
  });

  it.each([
    [["auto-update"]],
    [["auto-update", "yes"]],
    [["auto-update", "true"]],
    [["auto-update", "ON"]],
    [["channel", "beta"]],
    [["channel", "Latest"]],
    [["cooldown-hours", "-1"]],
    [["cooldown-hours", "721"]],
    [["cooldown-hours", "1.5"]],
    [["cooldown-hours", "24h"]],
    [["major", "allow"]],
    [["autoUpdate", "on"]],
    [["channel", "next", "extra"]],
  ])("refuses %j", (args) => {
    expect(parseConfigArgs(args)).toBeUndefined();
  });
});

describe("browxai runtime config", () => {
  it("prints each setting and its source", async () => {
    installed();
    const r = await run([]);
    expect(r).toEqual({
      code: 0,
      out:
        `runtime settings (${rt!.paths.settings})\n` +
        "  channel:        latest (default)\n" +
        "  auto-update:    on (default)\n" +
        "  cooldown-hours: 24 (default)\n",
      err: "",
    });
  });

  it("shows the variables that win over runtime.json", async () => {
    installed();
    writeFileSync(rt!.paths.settings, JSON.stringify({ channel: "next", cooldownHours: 6 }));
    const r = await run([], { BROWX_RUNTIME_CHANNEL: "latest", BROWX_RUNTIME_AUTO_UPDATE: "off" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("  channel:        latest (BROWX_RUNTIME_CHANNEL)\n");
    expect(r.out).toContain("  auto-update:    off (BROWX_RUNTIME_AUTO_UPDATE)\n");
    expect(r.out).toContain("  cooldown-hours: 6 (runtime.json)\n");
  });

  it("warns and exits 1 when a stored value is not usable", async () => {
    installed();
    writeFileSync(rt!.paths.settings, JSON.stringify({ autoUpdate: "maybe", channel: "beta" }));
    const r = await run([]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("  channel:        not usable\n");
    expect(r.out).toContain("  auto-update:    off (runtime.json)\n");
    expect(r.err).toContain('"channel" in runtime.json is "beta"');
    expect(r.err).toContain("so auto-update is off");
  });

  it.each([
    [["auto-update", "off"], { autoUpdate: "off" }],
    [["auto-update", "on"], { autoUpdate: "on" }],
    [["channel", "next"], { channel: "next" }],
    [["cooldown-hours", "48"], { cooldownHours: 48 }],
  ])("writes %j to runtime.json, mode 0600", async (args, want) => {
    installed();
    const r = await run(args);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toBe(`✓ ${args[0]} is ${args[1]} in ${rt!.paths.settings}\n`);
    expect(settings()).toEqual(want);
    expect(statSync(rt!.paths.settings).mode & 0o777).toBe(0o600);
  });

  it("keeps the other keys", async () => {
    installed();
    writeFileSync(rt!.paths.settings, JSON.stringify({ channel: "next", other: 1 }));
    await run(["auto-update", "off"]);
    expect(settings()).toEqual({ channel: "next", other: 1, autoUpdate: "off" });
  });

  it("is read back by the settings the updater uses", async () => {
    installed();
    await run(["auto-update", "off"]);
    const r = await run([]);
    expect(r.out).toContain("  auto-update:    off (runtime.json)\n");
  });

  it("refuses an unknown value with the usage and writes nothing", async () => {
    installed();
    for (const args of [
      ["auto-update", "maybe"],
      ["channel", "beta"],
      ["cooldown-hours", "x"],
    ]) {
      const r = await run(args);
      expect(r).toEqual({ code: 2, out: "", err: RUNTIME_USAGE });
    }
    expect(() => statSync(rt!.paths.settings)).toThrow();
  });

  it("leaves a runtime.json that doesn't parse alone", async () => {
    installed();
    writeFileSync(rt!.paths.settings, "{not json");
    const r = await run(["channel", "next"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("is not a JSON object. Fix it or remove it. Nothing was changed.");
    expect(readFileSync(rt!.paths.settings, "utf8")).toBe("{not json");
  });

  it("warns when a variable in this environment overrides the new value", async () => {
    installed();
    const ch = await run(["channel", "next"], { BROWX_RUNTIME_CHANNEL: "latest" });
    expect(ch.code).toBe(0);
    expect(ch.err).toContain("BROWX_RUNTIME_CHANNEL=latest is set in this environment");
    const au = await run(["auto-update", "on"], { BROWX_RUNTIME_AUTO_UPDATE: "0" });
    expect(au.err).toContain("BROWX_RUNTIME_AUTO_UPDATE=0 is set in this environment");
    const off = await run(["auto-update", "off"], { BROWX_RUNTIME_AUTO_UPDATE: "0" });
    expect(off.err).toBe("");
  });

  it("refuses a missing runtime", async () => {
    rt = tempRuntime({ create: false });
    const r = await run(["auto-update", "off"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no browxai runtime at");
  });

  it("exits 2 inside the signed app", async () => {
    installed();
    const r = await run(
      ["auto-update", "off"],
      {},
      { appBundle: () => "/Applications/Browxai.app" },
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain("brew upgrade --cask browxai");
  });
});
