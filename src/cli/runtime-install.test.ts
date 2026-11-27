import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addVersion,
  fakeNpm,
  fakeRegistry,
  tempRuntime,
  type TempRuntime,
} from "./__fixtures__/runtime-tree.js";
import type { SmokeResult } from "./runtime-smoke.js";
import { SHIM_TEXT } from "./runtime-shim.js";
import { readCurrent, readState, switchCurrent } from "./runtime-store.js";
import { runRuntime, type RuntimeDeps } from "./runtime.js";

let rt: TempRuntime | undefined;
afterEach(() => {
  rt?.cleanup();
  rt = undefined;
});

const NODE = "/opt/node/bin/node";
const VERSIONS = { "0.21.0": {}, "0.22.0": {} };

async function run(args: string[], deps: RuntimeDeps = {}) {
  let out = "";
  let err = "";
  const code = await runRuntime(args, {
    ctx: rt!.ctx,
    appBundle: () => undefined,
    list: () => Promise.resolve([]),
    execPath: NODE,
    findNpm: () => "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
    run: fakeNpm(),
    registry: () => fakeRegistry(VERSIONS, { latest: "0.21.0" }),
    smoke: () => Promise.resolve<SmokeResult>({ ok: true, notes: [] }),
    system: { platform: "linux", home: rt!.home, env: {}, exists: () => false },
    out: (t) => (out += t),
    err: (t) => (err += t),
    ...deps,
  });
  return { code, out, err };
}

describe("browxai runtime install", () => {
  it("lays out the runtime, records node, writes the launcher and installs the channel's version", async () => {
    rt = tempRuntime({ create: false });
    const npm = fakeNpm();
    const r = await run(["install"], { run: npm });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const { paths } = rt;
    expect(JSON.parse(readFileSync(paths.layout, "utf8"))).toEqual({ schemaVersion: 1 });
    expect(readFileSync(paths.nodePath, "utf8")).toBe(`${NODE}\n`);
    expect(readFileSync(paths.shim, "utf8")).toBe(SHIM_TEXT);
    expect(statSync(paths.root).mode & 0o777).toBe(0o700);
    expect(readCurrent(paths)).toBe("0.21.0");
    expect(npm.calls.every((c) => c.file === NODE)).toBe(true);
    expect(r.out).toContain(`launcher: ${paths.shim}`);
    expect(r.out).toContain("✓ current is 0.21.0.");
    expect(r.out).toContain(`Client entries name the launcher ${paths.shim}`);
  });

  it("installs into --dir and writes --channel to runtime.json", async () => {
    rt = tempRuntime({ create: false });
    const dir = join(rt.home, "elsewhere");
    const r = await run(["install", "--dir", dir, "--channel", "next"], {
      registry: () => fakeRegistry(VERSIONS, { next: "0.22.0" }),
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8"))).toEqual({
      channel: "next",
    });
    expect(existsSync(join(dir, "versions", "0.22.0"))).toBe(true);
  });

  it("exits 1 and leaves no current when the first install fails a check", async () => {
    rt = tempRuntime({ create: false });
    const r = await run(["install"], {
      smoke: () => Promise.resolve<SmokeResult>({ ok: false, reason: "MCP handshake: no answer" }),
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "✗ 0.21.0 was not applied: smoke check failed: MCP handshake: no answer",
    );
    expect(existsSync(rt.paths.current)).toBe(false);
  });

  it("refuses with exit 2 when there is no npm beside node", async () => {
    rt = tempRuntime({ create: false });
    const r = await run(["install"], { findNpm: () => undefined });
    expect(r.code).toBe(2);
    expect(r.err).toContain(`no npm-cli.js next to ${NODE}`);
    expect(existsSync(rt.paths.root)).toBe(false);
  });

  it("exits 2 inside the signed app, before touching anything", async () => {
    rt = tempRuntime({ create: false });
    const r = await run(["install"], { appBundle: () => "/Applications/Browxai.app" });
    expect(r.code).toBe(2);
    expect(existsSync(rt.paths.root)).toBe(false);
  });

  it("rewrites only the active config, and a profile directory only when named", async () => {
    rt = tempRuntime({ create: false });
    const old = "/usr/local/lib/node_modules/browxai/dist/cli.js";
    const active = join(rt.home, ".cursor", "mcp.json");
    const profile = join(rt.home, "profiles", "work");
    const other = join(rt.home, "profiles", "home");
    for (const dir of [join(rt.home, ".cursor"), profile, other])
      mkdirSync(dir, { recursive: true });
    const config = JSON.stringify({
      mcpServers: { browxai: { command: "node", args: [old], env: {} } },
    });
    for (const f of [active, join(profile, "mcp.json"), join(other, "mcp.json")])
      writeFileSync(f, config);
    const system = { platform: "linux" as const, home: rt.home, env: {}, exists: existsSync };
    const r = await run(["install", "--write-client-config", "--profile-dir", profile], { system });
    expect(r.code).toBe(0);
    const shim = rt.paths.shim;
    const commandOf = (f: string) =>
      (JSON.parse(readFileSync(f, "utf8")) as { mcpServers: { browxai: { command: string } } })
        .mcpServers.browxai.command;
    expect(commandOf(active)).toBe(shim);
    expect(commandOf(join(profile, "mcp.json"))).toBe(shim);
    expect(commandOf(join(other, "mcp.json"))).toBe("node");
    expect(existsSync(`${active}.browxai-bak`)).toBe(true);
  });

  it("refuses --profile-dir without --write-client-config", async () => {
    rt = tempRuntime({ create: false });
    expect((await run(["install", "--profile-dir", "/x"])).code).toBe(2);
  });
});

describe("browxai runtime update", () => {
  function installed(): TempRuntime {
    rt = tempRuntime();
    writeFileSync(rt.paths.nodePath, NODE + "\n");
    addVersion(rt.paths, "0.21.0");
    switchCurrent(rt.paths, "0.21.0");
    return rt;
  }

  it("switches to the newer channel version and records the previous one", async () => {
    rt = installed();
    const r = await run(["update"], {
      registry: () => fakeRegistry(VERSIONS, { latest: "0.22.0" }),
    });
    expect(r.code).toBe(0);
    expect(readCurrent(rt.paths)).toBe("0.22.0");
    expect(readState(rt.paths).previous).toBe("0.21.0");
    expect(r.out).toContain("✓ current is 0.22.0, was 0.21.0.");
  });

  it("says so and exits 0 when current is the newest", async () => {
    rt = installed();
    const r = await run(["update"]);
    expect(r).toMatchObject({ code: 0, out: expect.stringContaining("Nothing to do.") });
  });

  it("downloads nothing with --check", async () => {
    rt = installed();
    const npm = fakeNpm();
    const r = await run(["update", "--check"], {
      run: npm,
      registry: () => fakeRegistry(VERSIONS, { latest: "0.22.0" }),
    });
    expect(r.out).toContain("would install 0.22.0 over 0.21.0. Nothing was downloaded.");
    expect(npm.calls).toEqual([]);
    expect(readCurrent(rt.paths)).toBe("0.21.0");
  });

  it("exits 3 when the registry can't be reached, and changes nothing", async () => {
    rt = installed();
    const r = await run(["update"], {
      registry: () => fakeRegistry({}, {}, { unreachable: true }),
    });
    expect(r.code).toBe(3);
    expect(readCurrent(rt.paths)).toBe("0.21.0");
  });

  it("uses BROWX_RUNTIME_NODE, then the recorded node, for npm", async () => {
    rt = installed();
    const npm = fakeNpm();
    const ctx = { ...rt.ctx, env: { ...rt.ctx.env, BROWX_RUNTIME_NODE: "/env/node" } };
    await run(["update"], {
      ctx,
      run: npm,
      registry: () => fakeRegistry(VERSIONS, { latest: "0.22.0" }),
    });
    expect(npm.calls[0]!.file).toBe("/env/node");
  });

  it("refuses an unknown channel from the environment", async () => {
    rt = installed();
    const ctx = { ...rt.ctx, env: { ...rt.ctx.env, BROWX_RUNTIME_CHANNEL: "beta" } };
    const r = await run(["update"], { ctx });
    expect(r.code).toBe(2);
    expect(r.err).toContain("BROWX_RUNTIME_CHANNEL=beta is not a channel");
  });

  it.each([
    [["update", "--version", "latest"]],
    [["update", "--allow-major"]],
    [["update", "--auto"]],
  ])("rejects %j as usage", async (args) => {
    rt = installed();
    expect((await run(args)).code).toBe(2);
  });
});

describe("browxai runtime uninstall", () => {
  it("refuses while a process uses a version, then removes the directory with --yes", async () => {
    rt = tempRuntime();
    addVersion(rt.paths, "0.21.0");
    const command = `node ${rt.paths.root}/versions/0.21.0/node_modules/browxai/dist/cli.js`;
    const list = () => Promise.resolve([{ pid: 777, command }]);
    const refused = await run(["uninstall"], { list });
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("pid 777 runs from");
    expect(existsSync(rt.paths.root)).toBe(true);
    const done = await run(["uninstall", "--yes"], { list });
    expect(done.code).toBe(0);
    expect(existsSync(rt.paths.root)).toBe(false);
    expect(existsSync(rt.home)).toBe(true);
  });
});
